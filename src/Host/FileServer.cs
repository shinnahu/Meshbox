using System.Collections.Concurrent;
using System.Text;
using Microsoft.Web.WebView2.Core;

namespace ModelViewer;

/// <summary>
/// Serves local files to the UI under https://files.viewer/{drive}/{path} so loaders resolve relative
/// textures naturally. When a texture is missing it searches the usual places (Textures/, the .fbm
/// folder, parent folders, a .png next to a referenced .psd, user texture folders...).
/// </summary>
static class FileServer
{
    public const string Host = "files.viewer";

    public record TexLog(string Requested, string? Resolved, string How);

    static readonly ConcurrentDictionary<MainWindow, ConcurrentQueue<TexLog>> logs = new();

    static readonly HashSet<string> ImageExts = new(StringComparer.OrdinalIgnoreCase)
    { ".png", ".jpg", ".jpeg", ".tga", ".bmp", ".gif", ".webp", ".tif", ".tiff", ".psd", ".dds", ".exr", ".hdr", ".ktx2" };
    // Order of preference when substituting a missing texture by a sibling with the same name.
    static readonly string[] SubstituteExts = [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tga", ".tif", ".tiff", ".gif"];

    public static string ToUrl(string path)
    {
        path = Path.GetFullPath(path);
        string[] parts;
        string prefix;
        if (path.StartsWith(@"\\", StringComparison.Ordinal))
        {
            prefix = "~unc";
            parts = path.TrimStart('\\').Split('\\');
        }
        else
        {
            prefix = path[0].ToString().ToUpperInvariant();
            parts = path[3..].Split('\\');
        }
        var sb = new StringBuilder($"https://{Host}/{prefix}");
        foreach (var p in parts) if (p.Length > 0) sb.Append('/').Append(Uri.EscapeDataString(p));
        return sb.ToString();
    }

    public static string? FromUrlPath(string absolutePath)
    {
        var segs = absolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries).Select(Uri.UnescapeDataString).ToArray();
        if (segs.Length < 2) return null;
        if (segs.Any(s => s == ".." || s == ".")) return null;
        if (segs[0] == "~unc") return @"\\" + string.Join('\\', segs[1..]);
        if (segs[0].Length != 1 || !char.IsLetter(segs[0][0])) return null;
        return segs[0].ToUpperInvariant() + @":\" + string.Join('\\', segs[1..]);
    }

    /// <summary>
    /// Each local drive is also mapped natively (https://d.drive.viewer/...), which streams several times
    /// faster than answering from .NET. Requests still pass through OnRequest first: existing files are left
    /// to WebView2, missing textures get the fallback search.
    /// </summary>
    public const string DriveSuffix = ".drive.viewer";

    public static void Attach(CoreWebView2 core, MainWindow window)
    {
        logs[window] = new ConcurrentQueue<TexLog>();
        window.Closed += (_, _) => logs.TryRemove(window, out _);
        core.AddWebResourceRequestedFilter($"https://{Host}/*", CoreWebView2WebResourceContext.All);
        foreach (var d in DriveInfo.GetDrives())
        {
            try
            {
                if (!d.IsReady || d.DriveType is DriveType.CDRom or DriveType.Unknown or DriveType.NoRootDirectory) continue;
                var letter = char.ToLowerInvariant(d.Name[0]);
                core.SetVirtualHostNameToFolderMapping($"{letter}{DriveSuffix}", d.RootDirectory.FullName, CoreWebView2HostResourceAccessKind.Allow);
                core.AddWebResourceRequestedFilter($"https://{letter}{DriveSuffix}/*", CoreWebView2WebResourceContext.All);
            }
            catch (Exception ex) { Log.Error("Map drive " + d.Name, ex); }
        }
        core.WebResourceRequested += (_, e) => OnRequest(core, window, e);
    }

    /// <summary>Path for a https://x.drive.viewer/... URL (null for other hosts).</summary>
    static string? DrivePath(Uri uri)
    {
        if (!uri.Host.EndsWith(DriveSuffix, StringComparison.OrdinalIgnoreCase) || uri.Host.Length != DriveSuffix.Length + 1) return null;
        var segs = uri.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries).Select(Uri.UnescapeDataString).ToArray();
        if (segs.Any(s => s is ".." or ".")) return null;
        return char.ToUpperInvariant(uri.Host[0]) + @":\" + string.Join('\\', segs);
    }

    public static List<TexLog> TakeLog(MainWindow w)
    {
        var list = new List<TexLog>();
        if (logs.TryGetValue(w, out var q)) while (q.TryDequeue(out var item)) list.Add(item);
        return list;
    }

    sealed record Reply(int Status, string Reason, Stream? Body, string ContentType)
    {
        public long Length => Body is { CanSeek: true } ? Body.Length : -1;
    }

    static void OnRequest(CoreWebView2 core, MainWindow window, CoreWebView2WebResourceRequestedEventArgs e)
    {
        Uri uri;
        try { uri = new Uri(e.Request.Uri); } catch { return; }
        var drivePath = DrivePath(uri);
        if (drivePath != null)
        {
            // Fast path: the file exists, WebView2 streams it natively (no response set here).
            bool image = ImageExts.Contains(Path.GetExtension(drivePath));
            if (File.Exists(drivePath))
            {
                if (image) Enqueue(window, new TexLog(drivePath, drivePath, "exact"));
                return;
            }
            if (!image) return; // a plain 404 from WebView2
        }
        else if (!uri.Host.Equals(Host, StringComparison.OrdinalIgnoreCase)) return;

        var deferral = e.GetDeferral();
        Task.Run(() =>
        {
            try { return Serve(uri, window); }
            catch (Exception ex)
            {
                Log.Error("Serve " + uri, ex);
                return new Reply(500, "Error", null, "text/plain");
            }
        }).ContinueWith(t =>
        {
            window.Dispatcher.InvokeAsync(() =>
            {
                try
                {
                    var r = t.Result;
                    var headers = $"Content-Type: {r.ContentType}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Expose-Headers: Content-Length\r\nCache-Control: no-store";
                    if (r.Length >= 0) headers += $"\r\nContent-Length: {r.Length}";
                    e.Response = core.Environment.CreateWebResourceResponse(r.Body, r.Status, r.Reason, headers);
                }
                catch (Exception ex) { Log.Error("Respond", ex); }
                finally { deferral.Complete(); }
            });
        });
    }

    static Reply Serve(Uri uri, MainWindow window)
    {
        var abs = uri.AbsolutePath;
        if (abs.StartsWith("/_/", StringComparison.Ordinal) && uri.Host.Equals(Host, StringComparison.OrdinalIgnoreCase)) return ServeSpecial(abs[3..], uri);

        var path = DrivePath(uri) ?? FromUrlPath(abs);
        if (path == null) return NotFound();
        bool isImage = ImageExts.Contains(Path.GetExtension(path));

        if (File.Exists(path))
        {
            if (isImage) Enqueue(window, new TexLog(path, path, "exact"));
            return FileReply(path);
        }
        if (!isImage) return NotFound();

        var (found, how) = TextureSearch.Find(path, Settings.Current.TextureFolders);
        Enqueue(window, new TexLog(path, found, found != null ? how : "missing"));
        return found != null ? FileReply(found) : NotFound();
    }

    static void Enqueue(MainWindow w, TexLog item)
    {
        if (logs.TryGetValue(w, out var q))
        {
            q.Enqueue(item);
            while (q.Count > 4000 && q.TryDequeue(out _)) { }
        }
    }

    static Reply ServeSpecial(string what, Uri uri)
    {
        var query = System.Web.HttpUtility.ParseQueryString(uri.Query);
        switch (what)
        {
            case "blendthumb":
            {
                var p = query["path"];
                if (p == null || !File.Exists(p)) return NotFound();
                var png = BlendFile.ReadThumbnailPng(p);
                return png == null ? NotFound() : new Reply(200, "OK", new MemoryStream(png), "image/png");
            }
            default:
                return NotFound();
        }
    }

    static Reply FileReply(string path)
    {
        var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete,
            1 << 20, FileOptions.SequentialScan);
        return new Reply(200, "OK", fs, Mime(path));
    }

    static Reply NotFound() => new(404, "Not Found", null, "text/plain");

    public static string Mime(string path) => Path.GetExtension(path).ToLowerInvariant() switch
    {
        ".png" => "image/png",
        ".jpg" or ".jpeg" => "image/jpeg",
        ".webp" => "image/webp",
        ".gif" => "image/gif",
        ".bmp" => "image/bmp",
        ".svg" => "image/svg+xml",
        ".glb" or ".vrm" => "model/gltf-binary",
        ".gltf" => "model/gltf+json",
        ".json" => "application/json",
        ".obj" or ".mtl" or ".txt" => "text/plain",
        _ => "application/octet-stream",
    };

    // ---------------------------------------------------------------- texture search
    static class TextureSearch
    {
        sealed class Index
        {
            public DateTime Built;
            public readonly Dictionary<string, List<string>> ByName = new(StringComparer.OrdinalIgnoreCase);
            public readonly Dictionary<string, List<string>> ByStem = new(StringComparer.OrdinalIgnoreCase);
        }

        static readonly ConcurrentDictionary<string, Index> indexes = new(StringComparer.OrdinalIgnoreCase);
        static readonly ConcurrentDictionary<string, (string? path, string how, DateTime at)> answers = new(StringComparer.OrdinalIgnoreCase);

        public static (string? path, string how) Find(string requested, IEnumerable<string> extraRoots)
        {
            if (answers.TryGetValue(requested, out var cached) && DateTime.Now - cached.at < TimeSpan.FromSeconds(20))
                return (cached.path, cached.how);
            var r = FindUncached(requested, extraRoots);
            answers[requested] = (r.path, r.how, DateTime.Now);
            return r;
        }

        static (string? path, string how) FindUncached(string requested, IEnumerable<string> extraRoots)
        {
            var dir = Path.GetDirectoryName(requested) ?? "";
            var name = Path.GetFileName(requested);
            var stem = Path.GetFileNameWithoutExtension(requested);

            // 1. Same folder, other extension (a .psd/.tif reference with a .png beside it).
            var same = ByStemIn(dir, stem);
            if (same != null) return (same, "sibling");

            // 2. The usual texture folders around the model.
            var parent = Path.GetDirectoryName(dir);
            var model = Path.GetFileName(dir);
            var candidates = new List<string>
            {
                Path.Combine(dir, "Textures"), Path.Combine(dir, "textures"), Path.Combine(dir, "Texture"),
                Path.Combine(dir, "tex"), Path.Combine(dir, "Tex"), Path.Combine(dir, "Materials"), Path.Combine(dir, "images"),
            };
            try
            {
                foreach (var fbm in Directory.EnumerateDirectories(dir, "*.fbm")) candidates.Add(fbm);
            }
            catch { }
            if (parent != null)
            {
                candidates.Add(parent);
                candidates.Add(Path.Combine(parent, "Textures"));
                candidates.Add(Path.Combine(parent, "textures"));
                var grand = Path.GetDirectoryName(parent);
                if (grand != null) candidates.Add(Path.Combine(grand, "Textures"));
            }
            foreach (var c in candidates)
            {
                if (!Directory.Exists(c)) continue;
                var exact = Path.Combine(c, name);
                if (File.Exists(exact)) return (exact, "nearby");
                var alt = ByStemIn(c, stem);
                if (alt != null) return (alt, "nearby");
            }

            // 3. Search the model folder and its parent (a few levels deep), then user texture folders.
            var roots = new List<(string root, int depth)> { (dir, 4) };
            if (parent != null) roots.Add((parent, 4));
            foreach (var r in extraRoots) roots.Add((r, 6));
            foreach (var (root, depth) in roots)
            {
                var idx = GetIndex(root, depth);
                if (idx == null) continue;
                if (idx.ByName.TryGetValue(name, out var hits) && hits.Count > 0) return (Closest(hits, dir), "search");
                if (idx.ByStem.TryGetValue(stem, out var stems) && stems.Count > 0)
                {
                    var best = stems.OrderBy(ExtRank).ThenBy(p => Distance(p, dir)).First();
                    return (best, "search");
                }
            }
            return (null, "missing");
        }

        static string? ByStemIn(string dir, string stem)
        {
            foreach (var ext in SubstituteExts)
            {
                var p = Path.Combine(dir, stem + ext);
                if (File.Exists(p)) return p;
            }
            return null;
        }

        static string Closest(List<string> hits, string dir) => hits.OrderBy(p => Distance(p, dir)).First();

        static int ExtRank(string path)
        {
            int i = Array.IndexOf(SubstituteExts, Path.GetExtension(path).ToLowerInvariant());
            return i < 0 ? 99 : i;
        }

        static int Distance(string file, string dir)
        {
            var a = Path.GetDirectoryName(file)!.Split('\\');
            var b = dir.Split('\\');
            int common = 0;
            while (common < a.Length && common < b.Length && string.Equals(a[common], b[common], StringComparison.OrdinalIgnoreCase)) common++;
            return (a.Length - common) + (b.Length - common);
        }

        static Index? GetIndex(string root, int depth)
        {
            if (!Directory.Exists(root)) return null;
            if (indexes.TryGetValue(root, out var idx) && DateTime.Now - idx.Built < TimeSpan.FromSeconds(30)) return idx;
            idx = new Index { Built = DateTime.Now };
            int count = 0;
            var stack = new Stack<(string, int)>();
            stack.Push((root, 0));
            while (stack.Count > 0 && count < 30000)
            {
                var (d, level) = stack.Pop();
                try
                {
                    foreach (var f in Directory.EnumerateFiles(d))
                    {
                        if (!ImageExts.Contains(Path.GetExtension(f))) continue;
                        count++;
                        Add(idx.ByName, Path.GetFileName(f), f);
                        Add(idx.ByStem, Path.GetFileNameWithoutExtension(f), f);
                    }
                    if (level < depth)
                        foreach (var sub in Directory.EnumerateDirectories(d))
                        {
                            var n = Path.GetFileName(sub);
                            if (n.StartsWith('.') || n.StartsWith('$') || n is "node_modules" or "Library" or "Temp" or "obj" or "bin") continue;
                            stack.Push((sub, level + 1));
                        }
                }
                catch { }
            }
            indexes[root] = idx;
            return idx;
        }

        static void Add(Dictionary<string, List<string>> map, string key, string value)
        {
            if (!map.TryGetValue(key, out var list)) map[key] = list = new List<string>();
            list.Add(value);
        }
    }
}
