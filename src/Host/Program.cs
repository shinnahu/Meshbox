using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using System.Windows;
using Microsoft.Web.WebView2.Core;

namespace ModelViewer;

public static class Program
{
    public const string AppName = "Meshbox";
    public const string ExeName = "Meshbox.exe";

    public static readonly string DataDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), AppName);
    public static readonly string ConfigDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), AppName);
    public static readonly string BaseDir = AppContext.BaseDirectory;
    public static string WebDir => Path.Combine(BaseDir, "web");
    public static string BlenderScriptsDir => Path.Combine(BaseDir, "blender");
    public static string Version =>
        typeof(Program).Assembly.GetName().Version?.ToString(3) ?? "1.0.0";

    public static long Uptime => (long)(DateTime.Now - System.Diagnostics.Process.GetCurrentProcess().StartTime).TotalMilliseconds;

    /// <summary>Created as early as possible so the browser process boots while WPF builds the window.</summary>
    public static Task<CoreWebView2Environment> WebEnv = null!;

    [STAThread]
    public static int Main(string[] args)
    {
        if (args.Length > 0)
        {
            switch (args[0])
            {
                case "--register": ShellIntegration.Register(); return 0;
                case "--unregister": ShellIntegration.Unregister(); return 0;
                case "--uninstall": return Uninstall();
                case "--blend-thumb" when args.Length >= 3:
                {
                    // Diagnostics: --blend-thumb <file.blend> <out.png>
                    var h = BlendFile.ReadHeader(args[1]);
                    var png = BlendFile.ReadThumbnailPng(args[1]);
                    if (png != null) File.WriteAllBytes(args[2], png);
                    File.WriteAllText(args[2] + ".txt",
                        $"version={h?.Version} compression={h?.Compression} format={h?.FormatVersion} ptr={h?.PointerSize} thumb={(png != null ? png.Length + " bytes" : "none")}");
                    return png != null ? 0 : 2;
                }
                case "--fbx-check" when args.Length >= 3:
                {
                    // Diagnostics: --fbx-check <out.txt> <file.fbx>... (can Meshbox save material changes into it?)
                    var lines = args.Skip(2).Select(f => $"{FbxEdit.Check(f)}\t{f}");
                    File.WriteAllLines(args[1], lines);
                    return 0;
                }
            }
        }

        var files = args.Where(a => !a.StartsWith("--", StringComparison.Ordinal))
                        .Select(SafeFullPath).Where(p => p != null).Cast<string>().ToArray();
        bool forceNew = args.Contains("--new-instance");

        Diag.Write($"start pid={Environment.ProcessId} user={Environment.UserName} args=[{string.Join(" | ", args)}] cwd={Environment.CurrentDirectory}");
        Diag.Write($"base={BaseDir} data={DataDir} config={ConfigDir} env LOCALAPPDATA={Environment.GetEnvironmentVariable("LOCALAPPDATA")} APPDATA={Environment.GetEnvironmentVariable("APPDATA")}");
        if (!forceNew && !SingleInstance.TryBecomePrimary(files))
        {
            Diag.Write("handed the files to the running instance; exiting");
            return 0; // handed to the running instance
        }

        try { Directory.CreateDirectory(DataDir); Directory.CreateDirectory(ConfigDir); }
        catch (Exception ex) { Diag.Write("creating data folders failed: " + ex); }
        Settings.Load();
        Diag.Write($"settings: file={File.Exists(Path.Combine(ConfigDir, "settings.json"))} scanRoots={Settings.Current.ScanRoots.Count} recent={Settings.Current.Recent.Count} window={(Settings.Current.Window != null)}");
        Log.Info($"startup: main {Uptime} ms");

        var app = new App(files);
        return app.Run();
    }

    /// <summary>Settings &gt; Apps &gt; Uninstall. Keeps your settings/thumbnails (in AppData) unless you delete them.</summary>
    static int Uninstall()
    {
        var answer = System.Windows.MessageBox.Show(
            $"Uninstall {AppName}?\n\nYour models are not touched. Settings, thumbnails and the preview cache stay in\n{DataDir}\nand\n{ConfigDir}\n(delete those folders too if you want everything gone).",
            AppName, System.Windows.MessageBoxButton.OKCancel, System.Windows.MessageBoxImage.Question);
        if (answer != System.Windows.MessageBoxResult.OK) return 1;
        foreach (var p in System.Diagnostics.Process.GetProcessesByName("Meshbox"))
            if (p.Id != Environment.ProcessId) try { p.Kill(); } catch { }
        ShellIntegration.Unregister();
        try { Microsoft.Win32.Registry.CurrentUser.DeleteSubKeyTree(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\Meshbox", false); } catch { }
        foreach (var dir in new[] { Environment.GetFolderPath(Environment.SpecialFolder.Programs), Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory) })
            try { File.Delete(Path.Combine(dir, AppName + ".lnk")); } catch { }
        // The exe can't delete its own folder while running: let cmd do it once we exit.
        var installDir = BaseDir.TrimEnd('\\');
        if (installDir.Contains(@"\Programs\", StringComparison.OrdinalIgnoreCase))
        {
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("cmd.exe",
                $"/c timeout /t 2 /nobreak > nul & rmdir /s /q \"{installDir}\"") { CreateNoWindow = true, UseShellExecute = false });
        }
        return 0;
    }

    static string? SafeFullPath(string p)
    {
        try { return Path.GetFullPath(p.Trim('"')); } catch { return null; }
    }
}

public sealed class App : Application
{
    readonly string[] startupFiles;
    public static App Instance => (App)Current;

    public App(string[] files)
    {
        startupFiles = files;
        ShutdownMode = ShutdownMode.OnLastWindowClose;
        DispatcherUnhandledException += (_, e) =>
        {
            Log.Error("Unhandled UI exception", e.Exception);
            e.Handled = true;
        };
        AppDomain.CurrentDomain.UnhandledException += (_, e) => Log.Error("Unhandled exception", e.ExceptionObject as Exception);
    }

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        var dataFolder = Path.Combine(Program.DataDir, "WebView2");
        var options = new CoreWebView2EnvironmentOptions
        {
            AdditionalBrowserArguments = "--disable-features=msSmartScreenProtection,msEdgeEnhanceTextContrast --enable-gpu-rasterization",
        };
        Program.WebEnv = CoreWebView2Environment.CreateAsync(null, dataFolder, options);

        SingleInstance.Listen(files => Dispatcher.InvokeAsync(() => OpenFromOutside(files)));

        if (startupFiles.Length == 0) OpenWindow(null);
        else foreach (var f in startupFiles) OpenWindow(f);
    }

    public MainWindow OpenWindow(string? file)
    {
        var w = new MainWindow(file);
        w.Show();
        return w;
    }

    /// <summary>Files arriving from Explorer while we are already running.</summary>
    void OpenFromOutside(string[] files)
    {
        var target = Windows.OfType<MainWindow>().OrderByDescending(w => w.LastActivated).FirstOrDefault();
        if (files.Length == 0)
        {
            if (target != null) target.BringToFront(); else OpenWindow(null);
            return;
        }
        foreach (var f in files)
        {
            if (!Settings.Current.OpenInNewWindow && target != null && !target.IsBusy)
            {
                target.OpenFile(f);
                target.BringToFront();
            }
            else
            {
                var w = OpenWindow(f);
                w.BringToFront();
                target = w;
            }
        }
    }
}

/// <summary>One process for all windows: later launches forward their files through a named pipe.</summary>
static class SingleInstance
{
    static Mutex? mutex;
    // string.GetHashCode is randomized per process, so build a stable id from the session + user name.
    static readonly string Id = "Meshbox-" + System.Diagnostics.Process.GetCurrentProcess().SessionId + "-" +
        new string(Environment.UserName.Where(char.IsLetterOrDigit).ToArray());
    static string PipeName => Id + "-pipe";

    public static bool TryBecomePrimary(string[] files)
    {
        mutex = new Mutex(true, "Local\\" + Id, out bool created);
        if (created) return true;
        try
        {
            Native.AllowSetForegroundWindow(-1);
            using var client = new NamedPipeClientStream(".", PipeName, PipeDirection.Out);
            client.Connect(2000);
            var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(files));
            client.Write(bytes, 0, bytes.Length);
            client.Flush();
            return false;
        }
        catch
        {
            return true; // primary is not answering: run on our own
        }
    }

    public static void Listen(Action<string[]> onFiles)
    {
        var t = new Thread(() =>
        {
            while (true)
            {
                try
                {
                    using var server = new NamedPipeServerStream(PipeName, PipeDirection.In, 1,
                        PipeTransmissionMode.Byte, PipeOptions.None);
                    server.WaitForConnection();
                    using var ms = new MemoryStream();
                    server.CopyTo(ms);
                    var files = JsonSerializer.Deserialize<string[]>(Encoding.UTF8.GetString(ms.ToArray())) ?? [];
                    onFiles(files);
                }
                catch (Exception ex)
                {
                    Log.Error("Pipe", ex);
                    Thread.Sleep(500);
                }
            }
        })
        { IsBackground = true, Name = "single-instance-pipe" };
        t.Start();
    }
}

static class Log
{
    static readonly object gate = new();
    static string LogPath => Path.Combine(Program.DataDir, "log.txt");

    public static void Info(string msg) => Write("INFO", msg);
    public static void Error(string msg, Exception? ex = null) => Write("ERROR", msg + (ex != null ? ": " + ex : ""));

    static void Write(string level, string msg)
    {
        try
        {
            lock (gate)
            {
                var fi = new FileInfo(LogPath);
                if (fi.Exists && fi.Length > 2_000_000) fi.Delete();
                File.AppendAllText(LogPath, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} [{level}] {msg}{Environment.NewLine}");
            }
        }
        catch (Exception ex) { Diag.Write($"log write failed ({LogPath}): {ex.GetType().Name}: {ex.Message}"); }
    }
}

/// <summary>Startup diagnostics: written next to the exe only when a "diag.on" file is there.</summary>
static class Diag
{
    static readonly string? path = File.Exists(Path.Combine(AppContext.BaseDirectory, "diag.on"))
        ? Path.Combine(AppContext.BaseDirectory, "diag.log") : null;

    public static void Write(string msg)
    {
        if (path == null) return;
        try { File.AppendAllText(path, $"{DateTime.Now:HH:mm:ss.fff} {msg}{Environment.NewLine}"); } catch { }
    }
}
