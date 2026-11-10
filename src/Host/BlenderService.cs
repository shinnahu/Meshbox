using System.Collections.Concurrent;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace ModelViewer;

public sealed record BlenderInstall(string Path, string Version, string Source)
{
    public Version Parsed => System.Version.TryParse(Regex.Match(Version, @"\d+(\.\d+){0,2}").Value, out var v) ? v : new Version(0, 0);
}

/// <summary>Finds Blender installs and runs our scripts headless (preview .blend, export FBX, organize).</summary>
public static class BlenderService
{
    /// <summary>Bump when preview.py output changes so cached previews are rebuilt.</summary>
    const string PreviewVersion = "4";
    static readonly ConcurrentDictionary<string, Process> running = new();
    static List<BlenderInstall>? found;

    public static string PreviewCacheDir => Path.Combine(Program.DataDir, "cache", "previews");

    public static List<BlenderInstall> FindAll(bool refresh = false)
    {
        if (found != null && !refresh) return found;
        var list = new List<BlenderInstall>();
        void Add(string? exe, string source)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(exe)) return;
                exe = Path.GetFullPath(exe.Trim().Trim('"'));
                if (!File.Exists(exe)) return;
                if (list.Any(b => string.Equals(b.Path, exe, StringComparison.OrdinalIgnoreCase))) return;
                var info = FileVersionInfo.GetVersionInfo(exe);
                var ver = info.ProductVersion?.Trim();
                if (string.IsNullOrEmpty(ver)) ver = $"{info.FileMajorPart}.{info.FileMinorPart}";
                list.Add(new BlenderInstall(exe, ver, source));
            }
            catch { }
        }

        Add(Settings.Current.BlenderPath, "custom");

        foreach (var pf in new[] { Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86) })
        {
            var root = Path.Combine(pf, "Blender Foundation");
            if (!Directory.Exists(root)) continue;
            foreach (var d in Directory.EnumerateDirectories(root)) Add(Path.Combine(d, "blender.exe"), "installed");
        }

        foreach (var lib in SteamLibraries()) Add(Path.Combine(lib, "steamapps", "common", "Blender", "blender.exe"), "steam");

        // Whatever .blend files open with.
        foreach (var hive in new[] { Registry.CurrentUser, Registry.ClassesRoot })
        {
            try
            {
                var keyPath = hive == Registry.CurrentUser ? @"Software\Classes\blendfile\shell\open\command" : @"blendfile\shell\open\command";
                using var k = hive.OpenSubKey(keyPath);
                var cmd = k?.GetValue(null) as string;
                if (cmd != null)
                {
                    var m = Regex.Match(cmd, "^\"([^\"]+)\"|^(\\S+)");
                    Add(m.Groups[1].Success ? m.Groups[1].Value : m.Groups[2].Value, "default");
                }
            }
            catch { }
        }

        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        Add(Path.Combine(local, "Programs", "Blender Foundation", "Blender", "blender.exe"), "installed");

        found = list.OrderByDescending(b => b.Parsed).ToList();
        return found;
    }

    static IEnumerable<string> SteamLibraries()
    {
        var libs = new List<string>();
        try
        {
            using var k = Registry.CurrentUser.OpenSubKey(@"Software\Valve\Steam");
            var steam = (k?.GetValue("SteamPath") as string)?.Replace('/', '\\');
            if (steam != null)
            {
                libs.Add(steam);
                var vdf = Path.Combine(steam, "steamapps", "libraryfolders.vdf");
                if (File.Exists(vdf))
                    foreach (Match m in Regex.Matches(File.ReadAllText(vdf), "\"path\"\\s+\"([^\"]+)\""))
                        libs.Add(m.Groups[1].Value.Replace(@"\\", @"\"));
            }
        }
        catch { }
        libs.Add(@"C:\Program Files (x86)\Steam");
        return libs.Distinct(StringComparer.OrdinalIgnoreCase);
    }

    /// <summary>
    /// The Blender that .blend files open with in Explorer - used for "Open in Blender", so a file is not
    /// silently upgraded by a newer version on save. Falls back to the user's choice / newest.
    /// </summary>
    public static BlenderInstall? ForEditing()
    {
        var commands = new List<string?>();
        try
        {
            // What Explorer really uses (Settings > Default apps), then the classic association keys.
            using var choice = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.blend\UserChoice");
            if (choice?.GetValue("ProgId") is string progId)
            {
                using var k = Registry.ClassesRoot.OpenSubKey($@"{progId}\shell\open\command");
                commands.Add(k?.GetValue(null) as string);
            }
        }
        catch { }
        foreach (var (hive, keyPath) in new[] { (Registry.CurrentUser, @"Software\Classes\blendfile\shell\open\command"), (Registry.ClassesRoot, @"blendfile\shell\open\command") })
        {
            try { using var k = hive.OpenSubKey(keyPath); commands.Add(k?.GetValue(null) as string); } catch { }
        }
        foreach (var cmd in commands.Where(c => !string.IsNullOrWhiteSpace(c)))
        {
            var m = Regex.Match(cmd!, "^\"([^\"]+)\"|^(\\S+)");
            var exe = m.Groups[1].Success ? m.Groups[1].Value : m.Groups[2].Value;
            exe = exe.Replace("blender-launcher.exe", "blender.exe", StringComparison.OrdinalIgnoreCase);
            try
            {
                var hit = FindAll().FirstOrDefault(b => string.Equals(b.Path, Path.GetFullPath(exe), StringComparison.OrdinalIgnoreCase));
                if (hit != null) return hit;
            }
            catch { }
        }
        return Pick();
    }

    /// <summary>
    /// For scripts that save a .blend (organize): the user's everyday Blender, unless the file was saved by a
    /// newer version than that, in which case the newest install (an older Blender cannot read it).
    /// </summary>
    public static BlenderInstall? ForSaving(string blendPath)
    {
        var editing = ForEditing();
        var header = BlendFile.ReadHeader(blendPath);
        if (editing != null && header != null && System.Version.TryParse(header.Version, out var fileVer) && editing.Parsed >= fileVer) return editing;
        return Pick();
    }

    /// <summary>The user's choice if set, else the newest install (newer Blender opens older files, not the reverse).</summary>
    public static BlenderInstall? Pick()
    {
        var all = FindAll();
        var custom = Settings.Current.BlenderPath;
        if (!string.IsNullOrEmpty(custom))
        {
            var c = all.FirstOrDefault(b => string.Equals(b.Path, Path.GetFullPath(custom), StringComparison.OrdinalIgnoreCase));
            if (c != null) return c;
        }
        return all.FirstOrDefault();
    }

    public static void Cancel(string jobId)
    {
        if (running.TryRemove(jobId, out var p))
        {
            try { p.Kill(true); } catch { }
        }
    }

    /// <summary>
    /// Runs one of our scripts: blender -b [--factory-startup] [file.blend] --python script -- args.json.
    /// Scripts print "@@PROGRESS p msg", "@@RESULT {json}" or "@@ERROR msg".
    /// </summary>
    public static async Task<JsonNode> RunScript(string jobId, string script, string? blendFile, JsonNode args,
        Action<double, string> progress, bool factoryStartup = true, BlenderInstall? blender = null)
    {
        blender ??= Pick() ?? throw new InvalidOperationException(
            "Blender was not found. Install Blender or set its path in Settings.");
        var scriptPath = Path.Combine(Program.BlenderScriptsDir, script);
        if (!File.Exists(scriptPath)) throw new FileNotFoundException("Missing script " + script, scriptPath);

        var jobsDir = Path.Combine(Program.DataDir, "jobs");
        Directory.CreateDirectory(jobsDir);
        var argsFile = Path.Combine(jobsDir, $"{SafeName(jobId)}.json");
        await File.WriteAllTextAsync(argsFile, args.ToJsonString(), new UTF8Encoding(false));

        var psi = new ProcessStartInfo(blender.Path)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
            WorkingDirectory = Program.BlenderScriptsDir,
        };
        psi.ArgumentList.Add("-b");
        if (factoryStartup) psi.ArgumentList.Add("--factory-startup");
        psi.ArgumentList.Add("-noaudio");
        if (blendFile != null) psi.ArgumentList.Add(blendFile);
        psi.ArgumentList.Add("--python-exit-code");
        psi.ArgumentList.Add("3");
        psi.ArgumentList.Add("--python");
        psi.ArgumentList.Add(scriptPath);
        psi.ArgumentList.Add("--");
        psi.ArgumentList.Add(argsFile);
        psi.Environment["PYTHONIOENCODING"] = "utf-8";
        psi.Environment["PYTHONUTF8"] = "1";

        var tail = new ConcurrentQueue<string>();
        string? resultLine = null, errorLine = null;
        progress(0.02, $"Starting Blender {blender.Version}");

        using var proc = new Process { StartInfo = psi, EnableRaisingEvents = true };
        void OnLine(string? line)
        {
            if (line == null) return;
            if (line.StartsWith("@@PROGRESS ", StringComparison.Ordinal))
            {
                var rest = line[11..];
                var sp = rest.IndexOf(' ');
                var num = sp > 0 ? rest[..sp] : rest;
                var msg = sp > 0 ? rest[(sp + 1)..] : "";
                if (double.TryParse(num, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var p))
                    progress(Math.Clamp(p, 0, 1), msg);
                return;
            }
            if (line.StartsWith("@@RESULT ", StringComparison.Ordinal)) { resultLine = line[9..]; return; }
            if (line.StartsWith("@@ERROR ", StringComparison.Ordinal)) { errorLine = line[8..]; return; }
            if (line.StartsWith("Read blend:", StringComparison.Ordinal)) progress(0.08, "Opening .blend");
            tail.Enqueue(line);
            while (tail.Count > 60 && tail.TryDequeue(out _)) { }
        }
        proc.OutputDataReceived += (_, e) => OnLine(e.Data);
        proc.ErrorDataReceived += (_, e) => OnLine(e.Data);

        var sw = Stopwatch.StartNew();
        if (!proc.Start()) throw new InvalidOperationException("Could not start Blender.");
        running[jobId] = proc;
        proc.BeginOutputReadLine();
        proc.BeginErrorReadLine();
        try
        {
            await proc.WaitForExitAsync();
            proc.WaitForExit(); // flush async output
        }
        finally
        {
            running.TryRemove(jobId, out _);
            try { File.Delete(argsFile); } catch { }
        }
        Log.Info($"Blender {script} on {blendFile ?? "-"}: exit {proc.ExitCode} in {sw.Elapsed.TotalSeconds:0.0}s");

        if (resultLine != null)
        {
            var node = JsonNode.Parse(resultLine) ?? new JsonObject();
            if (node is JsonObject o) o["seconds"] = Math.Round(sw.Elapsed.TotalSeconds, 1);
            return node;
        }
        if (proc.ExitCode == -1 || proc.ExitCode == 137 || proc.ExitCode == unchecked((int)0xFFFFFFFF))
            throw new OperationCanceledException("Cancelled.");
        var detail = errorLine ?? string.Join("\n", tail.Where(l => l.Contains("Error", StringComparison.OrdinalIgnoreCase)).TakeLast(6));
        if (string.IsNullOrWhiteSpace(detail)) detail = string.Join("\n", tail.TakeLast(8));
        throw new InvalidOperationException($"Blender {blender.Version} failed (exit {proc.ExitCode}).\n{detail}".Trim());
    }

    public static async Task<JsonNode> Preview(string path, string jobId, bool force, Action<double, string> progress)
    {
        var fi = new FileInfo(path);
        if (!fi.Exists) throw new FileNotFoundException("File not found", path);
        Directory.CreateDirectory(PreviewCacheDir);
        var key = Hash($"{fi.FullName.ToLowerInvariant()}|{fi.Length}|{fi.LastWriteTimeUtc.Ticks}|{PreviewVersion}");
        var glb = Path.Combine(PreviewCacheDir, key + ".glb");
        var json = Path.Combine(PreviewCacheDir, key + ".json");
        if (!force && File.Exists(glb) && File.Exists(json))
        {
            File.SetLastAccessTimeUtc(glb, DateTime.UtcNow);
            var cached = JsonNode.Parse(await File.ReadAllTextAsync(json)) ?? new JsonObject();
            return new JsonObject { ["glb"] = glb, ["info"] = cached, ["cached"] = true };
        }

        var blender = Pick() ?? throw new InvalidOperationException(
            "Previewing .blend files needs Blender. Install Blender or set its path in Settings.");
        var tmp = Path.Combine(PreviewCacheDir, key + ".tmp.glb");
        var result = await RunScript(jobId, "preview.py", path, new JsonObject { ["out"] = tmp }, progress, true, blender);
        if (!File.Exists(tmp)) throw new InvalidOperationException("Blender finished but produced no preview.");
        File.Move(tmp, glb, true);
        var info = result["info"]?.DeepClone() ?? new JsonObject();
        if (info is JsonObject io)
        {
            io["previewBlender"] = blender.Version;
            io["seconds"] = result["seconds"]?.DeepClone();
        }
        await File.WriteAllTextAsync(json, info.ToJsonString());
        _ = Task.Run(() => TrimCache(PreviewCacheDir, 3L << 30));
        return new JsonObject { ["glb"] = glb, ["info"] = info, ["cached"] = false };
    }

    static void TrimCache(string dir, long maxBytes)
    {
        try
        {
            var files = new DirectoryInfo(dir).GetFiles("*.glb").OrderByDescending(f => f.LastAccessTimeUtc).ToList();
            long total = 0;
            foreach (var f in files)
            {
                total += f.Length;
                if (total > maxBytes)
                {
                    f.Delete();
                    var j = Path.ChangeExtension(f.FullName, ".json");
                    if (File.Exists(j)) File.Delete(j);
                }
            }
        }
        catch { }
    }

    public static string Hash(string s) =>
        Convert.ToHexString(SHA1.HashData(Encoding.UTF8.GetBytes(s)))[..20].ToLowerInvariant();

    static string SafeName(string s) => new(s.Select(c => char.IsLetterOrDigit(c) || c == '-' ? c : '_').ToArray());
}
