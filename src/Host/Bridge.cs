using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Media.Imaging;
using Microsoft.Web.WebView2.Core;
using Microsoft.Win32;

namespace ModelViewer;

/// <summary>
/// JSON RPC between the web UI and the host over WebView2 messages.
/// UI → host: {id, cmd, args}. Host → UI: {id, ok, result|error} and events {event, data}.
/// </summary>
public sealed class Bridge : IDisposable
{
    readonly MainWindow window;
    readonly CancellationTokenSource lifetime = new();
    readonly Dictionary<string, DateTime> lastProgress = new();

    public Bridge(MainWindow window) => this.window = window;

    public void Dispose() => lifetime.Cancel();

    public void OnMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        JsonNode? msg;
        try { msg = JsonNode.Parse(e.WebMessageAsJson); } catch { return; }
        if (msg is not JsonObject m) return;
        var id = m["id"]?.GetValue<int>() ?? 0;
        var cmd = m["cmd"]?.GetValue<string>() ?? "";
        var args = m["args"] as JsonObject ?? new JsonObject();

        // Paths of dropped files travel as CoreWebView2File objects next to the message.
        List<string>? dropped = null;
        if (cmd == "drop.paths" && e.AdditionalObjects != null)
            dropped = e.AdditionalObjects.OfType<CoreWebView2File>().Select(f => f.Path).ToList();

        _ = Dispatch(id, cmd, args, dropped);
    }

    async Task Dispatch(int id, string cmd, JsonObject args, List<string>? dropped)
    {
        JsonObject reply;
        try
        {
            var result = await Handle(cmd, args, dropped);
            reply = new JsonObject { ["id"] = id, ["ok"] = true, ["result"] = result };
        }
        catch (OperationCanceledException ex)
        {
            reply = new JsonObject { ["id"] = id, ["ok"] = false, ["error"] = ex.Message, ["cancelled"] = true };
        }
        catch (Exception ex)
        {
            if (ex is not FileNotFoundException) Log.Error($"RPC {cmd}", ex);
            reply = new JsonObject { ["id"] = id, ["ok"] = false, ["error"] = ex.Message };
        }
        Post(reply);
    }

    void Post(JsonObject o)
    {
        var json = o.ToJsonString();
        window.Dispatcher.InvokeAsync(() =>
        {
            try { window.Core?.PostWebMessageAsJson(json); } catch { }
        });
    }

    public void Emit(string name, object? data)
    {
        JsonNode? node = data as JsonNode ?? (data == null ? null : JsonSerializer.SerializeToNode(data, Settings.Json));
        Post(new JsonObject { ["event"] = name, ["data"] = node });
    }

    Action<double, string> JobProgress(string jobId) => (p, msg) =>
    {
        lock (lastProgress)
        {
            var now = DateTime.Now;
            if (p < 0.999 && lastProgress.TryGetValue(jobId, out var t) && (now - t).TotalMilliseconds < 60) return;
            lastProgress[jobId] = now;
        }
        Emit("job.progress", new JsonObject { ["jobId"] = jobId, ["progress"] = p, ["message"] = msg });
    };

    static string S(JsonObject a, string key, string? fallback = null) =>
        a[key]?.GetValue<string>() ?? fallback ?? throw new ArgumentException($"Missing '{key}'");
    static string? SOpt(JsonObject a, string key) => a[key] is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;
    static bool B(JsonObject a, string key, bool fallback = false) =>
        a[key] is JsonValue v && v.TryGetValue<bool>(out var b) ? b : fallback;
    static List<string> L(JsonObject a, string key) =>
        (a[key] as JsonArray)?.Select(n => n?.GetValue<string>()).Where(s => s != null).Cast<string>().ToList() ?? new();

    async Task<JsonNode?> Handle(string cmd, JsonObject a, List<string>? dropped)
    {
        switch (cmd)
        {
            // ------------------------------------------------------------ app & window
            case "app.init":
            {
                var pictures = Environment.GetFolderPath(Environment.SpecialFolder.MyPictures);
                return new JsonObject
                {
                    ["version"] = Program.Version,
                    ["file"] = window.TakePendingFile(),
                    ["settings"] = JsonSerializer.SerializeToNode(Settings.Current, Settings.Json),
                    ["blender"] = JsonSerializer.SerializeToNode(BlenderService.FindAll(), Settings.Json),
                    ["dataDir"] = Program.DataDir,
                    ["thumbDir"] = LibraryService.ThumbDir,
                    ["screenshotDir"] = Settings.Current.ScreenshotDir ?? Path.Combine(pictures, Program.AppName),
                    ["shellRegistered"] = ShellIntegration.IsRegistered(),
                    ["windows"] = Application.Current.Windows.OfType<MainWindow>().Count(),
                    ["dev"] = Environment.GetEnvironmentVariable("MESHBOX_DEV") == "1",
                };
            }
            case "app.openWindow":
                window.Dispatcher.Invoke(() => App.Instance.OpenWindow(SOpt(a, "path")));
                return null;
            case "window.title":
                window.Dispatcher.Invoke(() => window.Title = S(a, "title"));
                return null;
            case "window.fullscreen":
                window.Dispatcher.Invoke(() => window.SetFullscreen(a.ContainsKey("on") ? B(a, "on") : !window.IsFullscreen));
                return window.IsFullscreen;
            case "window.busy":
                window.IsBusy = B(a, "busy");
                return null;
            case "window.close":
                _ = window.Dispatcher.InvokeAsync(window.Close);
                return null;

            // ------------------------------------------------------------ settings
            case "settings.get":
                return JsonSerializer.SerializeToNode(Settings.Current, Settings.Json);
            case "settings.set":
            {
                var patch = a["patch"] as JsonObject ?? new JsonObject();
                var current = JsonSerializer.SerializeToNode(Settings.Current, Settings.Json) as JsonObject ?? new JsonObject();
                foreach (var (k, v) in patch) current[k] = v?.DeepClone();
                var updated = current.Deserialize<HostSettings>(Settings.Json) ?? new HostSettings();
                Settings.Update(s =>
                {
                    s.OpenInNewWindow = updated.OpenInNewWindow;
                    s.BlenderPath = updated.BlenderPath;
                    s.LibraryRoot = updated.LibraryRoot;
                    s.ScanRoots = updated.ScanRoots;
                    s.TextureFolders = updated.TextureFolders;
                    s.UnityProject = updated.UnityProject;
                    s.UnitySubfolder = updated.UnitySubfolder;
                    s.ScreenshotDir = updated.ScreenshotDir;
                    s.Ui = updated.Ui;
                });
                if (patch.ContainsKey("blenderPath")) BlenderService.FindAll(true);
                return JsonSerializer.SerializeToNode(Settings.Current, Settings.Json);
            }
            case "recent.add":
                Settings.AddRecent(S(a, "path"));
                return new JsonArray(Settings.Current.Recent.Select(p => (JsonNode?)p).ToArray());
            case "recent.remove":
            {
                var p = S(a, "path");
                Settings.Update(s => s.Recent.RemoveAll(x => string.Equals(x, p, StringComparison.OrdinalIgnoreCase)));
                return null;
            }
            case "recent.list":
                return new JsonArray(Settings.Current.Recent.Where(File.Exists).Select(p => (JsonNode?)p).ToArray());

            // ------------------------------------------------------------ dialogs
            case "dialog.open":
                return window.Dispatcher.Invoke(() =>
                {
                    var d = new OpenFileDialog
                    {
                        Title = SOpt(a, "title") ?? "Open 3D model",
                        Filter = Filter(a["filters"] as JsonArray),
                        Multiselect = B(a, "multi"),
                    };
                    var init = SOpt(a, "initialDir");
                    if (init != null && Directory.Exists(init)) d.InitialDirectory = init;
                    return d.ShowDialog(window) == true
                        ? new JsonArray(d.FileNames.Select(f => (JsonNode?)f).ToArray())
                        : null;
                });
            case "dialog.folder":
                return window.Dispatcher.Invoke(() =>
                {
                    var d = new OpenFolderDialog { Title = SOpt(a, "title") ?? "Choose a folder" };
                    var init = SOpt(a, "initialDir");
                    if (init != null && Directory.Exists(init)) d.InitialDirectory = init;
                    return d.ShowDialog(window) == true ? JsonValue.Create(d.FolderName) : null;
                });
            case "dialog.save":
                return window.Dispatcher.Invoke(() =>
                {
                    var d = new SaveFileDialog
                    {
                        Title = SOpt(a, "title") ?? "Save",
                        FileName = SOpt(a, "defaultName") ?? "",
                        Filter = Filter(a["filters"] as JsonArray),
                        OverwritePrompt = true,
                    };
                    var init = SOpt(a, "initialDir");
                    if (init != null && Directory.Exists(init)) d.InitialDirectory = init;
                    return d.ShowDialog(window) == true ? JsonValue.Create(d.FileName) : null;
                });
            case "drop.paths":
                return new JsonArray((dropped ?? new()).Select(p => (JsonNode?)p).ToArray());

            // ------------------------------------------------------------ files
            case "fs.stat":
            {
                var p = S(a, "path");
                var fi = new FileInfo(p);
                if (fi.Exists)
                    return new JsonObject { ["exists"] = true, ["isDir"] = false, ["size"] = fi.Length, ["modified"] = fi.LastWriteTime.ToString("o") };
                var di = new DirectoryInfo(p);
                return new JsonObject { ["exists"] = di.Exists, ["isDir"] = di.Exists, ["size"] = 0, ["modified"] = di.Exists ? di.LastWriteTime.ToString("o") : null };
            }
            case "fs.exists":
                return new JsonArray(L(a, "paths").Select(p => (JsonNode?)(File.Exists(p) || Directory.Exists(p))).ToArray());
            case "fs.list":
            {
                var dir = S(a, "dir");
                var exts = L(a, "exts").Select(x => x.ToLowerInvariant()).ToHashSet();
                var recursive = B(a, "recursive");
                var arr = new JsonArray();
                if (!Directory.Exists(dir)) return arr;
                var opts = new EnumerationOptions { RecurseSubdirectories = recursive, IgnoreInaccessible = true, MaxRecursionDepth = 3 };
                foreach (var f in new DirectoryInfo(dir).EnumerateFiles("*", opts).Take(5000))
                {
                    if (exts.Count > 0 && !exts.Contains(f.Extension.ToLowerInvariant())) continue;
                    arr.Add(new JsonObject { ["path"] = f.FullName, ["name"] = f.Name, ["size"] = f.Length, ["modified"] = f.LastWriteTime.ToString("o") });
                }
                return arr;
            }
            case "fs.reveal":
            {
                var p = S(a, "path");
                System.Diagnostics.Process.Start("explorer.exe", File.Exists(p) ? $"/select,\"{p}\"" : $"\"{p}\"");
                return null;
            }
            case "fs.open":
            {
                var p = S(a, "path");
                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(p) { UseShellExecute = true });
                return null;
            }
            case "fs.openInBlender":
            {
                var p = S(a, "path");
                var b = BlenderService.ForEditing() ?? throw new InvalidOperationException("Blender was not found.");
                var psi = new System.Diagnostics.ProcessStartInfo(b.Path) { UseShellExecute = false };
                psi.ArgumentList.Add(p);
                System.Diagnostics.Process.Start(psi);
                return null;
            }
            case "fs.recycle":
                return await Task.Run(() => LibraryService.Recycle(L(a, "paths")));
            case "fs.writeBase64":
            {
                var p = S(a, "path");
                var data = Convert.FromBase64String(S(a, "data"));
                if (File.Exists(p) && !B(a, "overwrite", true)) throw new IOException("File exists: " + p);
                Directory.CreateDirectory(Path.GetDirectoryName(p)!);
                await File.WriteAllBytesAsync(p, data);
                return p;
            }
            case "fs.readText":
            {
                var p = S(a, "path");
                return File.Exists(p) ? await File.ReadAllTextAsync(p) : null;
            }
            case "fs.writeText":
            {
                var p = S(a, "path");
                Directory.CreateDirectory(Path.GetDirectoryName(p)!);
                var tmp = p + ".tmp";
                await File.WriteAllTextAsync(tmp, S(a, "text"), new UTF8Encoding(false));
                File.Move(tmp, p, true);
                return p;
            }
            case "fs.mkdir":
                return Directory.CreateDirectory(S(a, "path")).FullName;
            case "fs.copy":
            {
                var from = S(a, "from");
                var to = S(a, "to");
                await Task.Run(() => LibraryService.CopyFile(from, to, B(a, "overwrite")));
                return to;
            }
            case "fs.copyDir":
            {
                var from = S(a, "from");
                var to = S(a, "to");
                await Task.Run(() => LibraryService.CopyDirectory(from, to, B(a, "overwrite")));
                return to;
            }
            case "fs.hash":
            {
                var p = S(a, "path");
                return await Task.Run(() => LibraryService.Sha256(p));
            }
            case "fs.compress":
            {
                var saved = await LibraryService.CompressAsync(L(a, "paths"));
                return saved;
            }
            case "fs.free":
                return Native.FreeBytes(S(a, "path"));
            case "clipboard.png":
            {
                var bytes = Convert.FromBase64String(S(a, "data"));
                window.Dispatcher.Invoke(() =>
                {
                    var img = new BitmapImage();
                    img.BeginInit();
                    img.CacheOption = BitmapCacheOption.OnLoad;
                    img.StreamSource = new MemoryStream(bytes);
                    img.EndInit();
                    img.Freeze();
                    var data = new DataObject();
                    data.SetData("PNG", new MemoryStream(bytes));
                    data.SetImage(img);
                    Clipboard.SetDataObject(data, true);
                });
                return true;
            }
            case "textures.log":
                return JsonSerializer.SerializeToNode(FileServer.TakeLog(window), Settings.Json);

            // ------------------------------------------------------------ blender
            case "blend.header":
                return JsonSerializer.SerializeToNode(BlendFile.ReadHeader(S(a, "path")), Settings.Json);
            case "blender.installs":
                return JsonSerializer.SerializeToNode(BlenderService.FindAll(B(a, "refresh")), Settings.Json);
            case "blender.preview":
            {
                var jobId = S(a, "jobId");
                window.IsBusy = true;
                try { return await BlenderService.Preview(S(a, "path"), jobId, B(a, "force"), JobProgress(jobId)); }
                finally { window.IsBusy = false; }
            }
            case "blender.run":
            {
                // Generic: {jobId, script: "export_fbx.py" | "organize.py", blend?: path, args: {...}}
                var jobId = S(a, "jobId");
                var script = S(a, "script");
                if (script is not ("export_fbx.py" or "organize.py" or "preview.py"))
                    throw new ArgumentException("Unknown script " + script);
                var scriptArgs = a["args"]?.DeepClone() ?? new JsonObject();
                var blend = SOpt(a, "blend");
                // organize.py saves a .blend: use the Blender the user works with, so the file stays openable there.
                var blender = script == "organize.py" ? (blend != null ? BlenderService.ForSaving(blend) : BlenderService.ForEditing()) : null;
                window.IsBusy = true;
                try { return await BlenderService.RunScript(jobId, script, blend, scriptArgs, JobProgress(jobId), true, blender); }
                finally { window.IsBusy = false; }
            }
            case "blender.installAddon":
            {
                var jobId = S(a, "jobId");
                var addon = Path.Combine(Program.BlenderScriptsDir, "meshbox_milestones.py");
                var path = SOpt(a, "blenderPath");
                var b = path != null ? BlenderService.FindAll().FirstOrDefault(x => string.Equals(x.Path, path, StringComparison.OrdinalIgnoreCase)) : BlenderService.Pick();
                return await BlenderService.RunScript(jobId, "install_addon.py", null,
                    new JsonObject { ["addonFile"] = addon }, JobProgress(jobId), factoryStartup: false, blender: b);
            }
            case "job.cancel":
                BlenderService.Cancel(S(a, "jobId"));
                return null;

            // ------------------------------------------------------------ unity
            case "unity.projects":
                return UnityService.Projects();
            case "unity.send":
                return await Task.Run(() => UnityService.Send(S(a, "fbx"), S(a, "project"),
                    SOpt(a, "subfolder") ?? Settings.Current.UnitySubfolder, SOpt(a, "assetName"), B(a, "installImporter"), a.ContainsKey("textures") ? L(a, "textures") : null));

            // ------------------------------------------------------------ library
            case "library.scan":
            {
                var roots = L(a, "roots");
                var jobId = SOpt(a, "jobId") ?? "scan";
                var progress = JobProgress(jobId);
                var (models, backups, dirs) = await Task.Run(() =>
                    LibraryService.Scan(roots, (n, d) => progress(0.5, $"{n} models · {d}"), lifetime.Token));
                return new JsonObject
                {
                    ["models"] = JsonSerializer.SerializeToNode(models, Settings.Json),
                    ["backups"] = JsonSerializer.SerializeToNode(backups, Settings.Json),
                    ["dirs"] = dirs,
                };
            }
            case "library.readIndex":
                return File.Exists(LibraryService.IndexPath)
                    ? JsonNode.Parse(await File.ReadAllTextAsync(LibraryService.IndexPath))
                    : new JsonObject();
            case "library.writeIndex":
            {
                var tmp = LibraryService.IndexPath + ".tmp";
                await File.WriteAllTextAsync(tmp, (a["index"] ?? new JsonObject()).ToJsonString(), new UTF8Encoding(false));
                File.Move(tmp, LibraryService.IndexPath, true);
                return true;
            }
            case "library.saveThumb":
            {
                var model = S(a, "path");
                var dest = LibraryService.ThumbPath(model);
                Directory.CreateDirectory(LibraryService.ThumbDir);
                await File.WriteAllBytesAsync(dest, Convert.FromBase64String(S(a, "data")));
                return dest;
            }
            case "library.thumbPath":
                return LibraryService.ThumbPath(S(a, "path"));

            // ------------------------------------------------------------ shell
            case "shell.register":
                ShellIntegration.Register();
                return ShellIntegration.IsRegistered();
            case "shell.unregister":
                ShellIntegration.Unregister();
                return ShellIntegration.IsRegistered();

            default:
                throw new ArgumentException("Unknown command " + cmd);
        }
    }

    static string Filter(JsonArray? filters)
    {
        var parts = new List<string>();
        if (filters != null)
            foreach (var f in filters.OfType<JsonObject>())
            {
                var name = f["name"]?.GetValue<string>() ?? "Files";
                var exts = (f["exts"] as JsonArray)?.Select(e => "*." + e!.GetValue<string>().TrimStart('.', '*')).ToList() ?? new() { "*.*" };
                parts.Add($"{name}|{string.Join(';', exts)}");
            }
        if (parts.Count == 0) parts.Add("All files|*.*");
        return string.Join('|', parts);
    }
}
