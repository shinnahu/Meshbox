// What the setup does, without any UI: copy the app to %LOCALAPPDATA%\Programs\Meshbox, Start menu shortcut,
// "Open with" for 3D files (Meshbox.exe --register) and an entry in Settings > Apps for uninstalling.
// Settings, thumbnails and caches live in %APPDATA%\Meshbox and %LOCALAPPDATA%\Meshbox and are kept.
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Windows.Media.Imaging;
using Microsoft.Win32;

namespace MeshboxSetup;

static class Installer
{
    public const string AppName = "Meshbox";
    const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Meshbox";
    public static readonly string InstallDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", AppName);
    public static string ExePath => Path.Combine(InstallDir, "Meshbox.exe");
    public static string Version => typeof(Installer).Assembly.GetName().Version?.ToString(3) ?? "1.0.0";

    /// <summary>Version of the Meshbox already installed, or null.</summary>
    public static string? InstalledVersion() =>
        File.Exists(ExePath) ? FileVersionInfo.GetVersionInfo(ExePath).ProductVersion?.Split('+')[0] : null;

    public static void Install(bool desktop, IProgress<(int, string)>? progress)
    {
        void Report(int pct, string text) => progress?.Report((pct, text));
        using var payload = typeof(Installer).Assembly.GetManifestResourceStream("payload.zip")
            ?? throw new InvalidOperationException("This setup has no files inside. Build it with build.ps1.");
        using var zip = new ZipArchive(payload, ZipArchiveMode.Read);

        var parent = Path.GetDirectoryName(InstallDir)!;
        Directory.CreateDirectory(parent);
        var staging = InstallDir + ".new";
        if (Directory.Exists(staging)) Directory.Delete(staging, true);
        Directory.CreateDirectory(staging);
        var stagingRoot = Path.GetFullPath(staging) + Path.DirectorySeparatorChar;

        // 1. unpack next to the install folder, so a failure never leaves a half-installed app
        var entries = zip.Entries.Where(e => !string.IsNullOrEmpty(e.Name)).ToList();
        long total = Math.Max(1, entries.Sum(e => e.Length)), copied = 0;
        foreach (var e in entries)
        {
            var dest = Path.GetFullPath(Path.Combine(staging, e.FullName.Replace('/', Path.DirectorySeparatorChar)));
            if (!dest.StartsWith(stagingRoot, StringComparison.OrdinalIgnoreCase)) continue;
            Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
            e.ExtractToFile(dest, true);
            copied += e.Length;
            Report(3 + (int)(82 * copied / total), "Copying files");
        }
        if (!File.Exists(Path.Combine(staging, "Meshbox.exe")))
            throw new InvalidOperationException("The setup files are incomplete (Meshbox.exe is missing).");

        // 2. swap folders (falls back to copying over the old one if a file is locked)
        Report(87, "Replacing the old version");
        if (Directory.Exists(InstallDir))
        {
            var old = $"{InstallDir}.old-{DateTime.Now:yyyyMMddHHmmss}";
            try
            {
                Directory.Move(InstallDir, old);
                Directory.Move(staging, InstallDir);
                TryDelete(old);
            }
            catch (IOException)
            {
                if (Directory.Exists(old) && !Directory.Exists(InstallDir)) Directory.Move(old, InstallDir);
                CopyOver(staging, InstallDir);
                TryDelete(staging);
            }
        }
        else Directory.Move(staging, InstallDir);
        foreach (var d in Directory.GetDirectories(parent, AppName + ".old-*")) TryDelete(d);

        // 3. shortcuts, "Open with", Settings > Apps
        Report(91, "Adding the Start menu shortcut");
        CreateShortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), AppName + ".lnk"));
        if (desktop) CreateShortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), AppName + ".lnk"));
        Report(94, "Adding Meshbox to \"Open with\"");
        RunAndWait(ExePath, "--register");
        Report(97, "Adding Meshbox to Settings > Apps");
        WriteUninstallEntry();
        // Windows caches icons: refresh it so the Start menu and taskbar show a new icon right away
        try { using var p = Process.Start(new ProcessStartInfo("ie4uinit.exe", "-show") { UseShellExecute = false, CreateNoWindow = true }); p?.WaitForExit(5000); }
        catch { /* not available: the icon updates after the next sign-in */ }
        Report(100, "Done");
    }

    /// <summary>Walks through the same steps without touching anything (MeshboxSetup.exe /demo).</summary>
    public static async Task FakeInstall(IProgress<(int, string)> progress)
    {
        for (int i = 0; i <= 85; i += 5) { progress.Report((3 + i * 82 / 85, "Copying files")); await Task.Delay(90); }
        foreach (var (pct, text) in new[] { (87, "Replacing the old version"), (91, "Adding the Start menu shortcut"), (94, "Adding Meshbox to \"Open with\""), (97, "Adding Meshbox to Settings > Apps"), (100, "Done") })
        { progress.Report((pct, text)); await Task.Delay(350); }
    }

    public static void Launch()
    {
        if (!File.Exists(ExePath)) return;
        try { Process.Start(new ProcessStartInfo(ExePath) { UseShellExecute = true, WorkingDirectory = InstallDir }); }
        catch { /* the user can start it from the Start menu */ }
    }

    static void WriteUninstallEntry()
    {
        using var k = Registry.CurrentUser.CreateSubKey(UninstallKey);
        var version = FileVersionInfo.GetVersionInfo(ExePath).ProductVersion ?? Version;
        long kb = new DirectoryInfo(InstallDir).EnumerateFiles("*", SearchOption.AllDirectories).Sum(f => f.Length) / 1024;
        k.SetValue("DisplayName", AppName);
        k.SetValue("DisplayVersion", version.Split('+')[0]);
        k.SetValue("Publisher", AppName);
        k.SetValue("DisplayIcon", ExePath + ",0");
        k.SetValue("InstallLocation", InstallDir);
        k.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd"));
        k.SetValue("UninstallString", $"\"{ExePath}\" --uninstall");
        k.SetValue("EstimatedSize", (int)Math.Min(int.MaxValue, kb), RegistryValueKind.DWord);
        k.SetValue("NoModify", 1, RegistryValueKind.DWord);
        k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
    }

    static void CreateShortcut(string lnkPath)
    {
        var type = Type.GetTypeFromProgID("WScript.Shell") ?? throw new InvalidOperationException("Windows Script Host is not available");
        dynamic shell = Activator.CreateInstance(type)!;
        try
        {
            dynamic lnk = shell.CreateShortcut(lnkPath);
            try
            {
                lnk.TargetPath = ExePath;
                lnk.WorkingDirectory = InstallDir;
                lnk.IconLocation = ExePath + ",0";
                lnk.Description = "Fast viewer and organizer for FBX, Blender and glTF models";
                lnk.Save();
            }
            finally { Marshal.FinalReleaseComObject(lnk); }
        }
        finally { Marshal.FinalReleaseComObject(shell); }
    }

    // ------------------------------------------------------------------ helpers
    public static List<Process> RunningInstances()
    {
        var list = new List<Process>();
        foreach (var p in Process.GetProcessesByName(AppName))
        {
            try
            {
                var path = p.MainModule?.FileName;
                if (path != null && path.StartsWith(InstallDir + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) list.Add(p);
            }
            catch { /* another user's process */ }
        }
        return list;
    }

    public static void Kill(Process p)
    {
        try { p.CloseMainWindow(); if (!p.WaitForExit(2500)) { p.Kill(true); p.WaitForExit(5000); } }
        catch { /* already gone */ }
    }

    static void RunAndWait(string exe, string args)
    {
        using var p = Process.Start(new ProcessStartInfo(exe, args) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = InstallDir });
        p?.WaitForExit(30000);
    }

    static void CopyOver(string from, string to)
    {
        foreach (var dir in Directory.GetDirectories(from, "*", SearchOption.AllDirectories))
            Directory.CreateDirectory(Path.Combine(to, Path.GetRelativePath(from, dir)));
        foreach (var file in Directory.GetFiles(from, "*", SearchOption.AllDirectories))
            File.Copy(file, Path.Combine(to, Path.GetRelativePath(from, file)), true);
    }

    static void TryDelete(string dir)
    {
        try { if (Directory.Exists(dir)) Directory.Delete(dir, true); } catch { /* still in use: removed by the next update */ }
    }

    public static bool WebView2Installed()
    {
        const string id = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
        var keys = new[]
        {
            (Registry.LocalMachine, $@"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{id}"),
            (Registry.LocalMachine, $@"SOFTWARE\Microsoft\EdgeUpdate\Clients\{id}"),
            (Registry.CurrentUser, $@"Software\Microsoft\EdgeUpdate\Clients\{id}"),
        };
        foreach (var (hive, path) in keys)
        {
            try
            {
                using var k = hive.OpenSubKey(path);
                if (k?.GetValue("pv") is string pv && pv.Length > 0 && pv != "0.0.0.0") return true;
            }
            catch { }
        }
        return false;
    }

    /// <summary>The app icon's largest frame, for the setup window.</summary>
    public static BitmapSource? Logo()
    {
        try
        {
            var decoder = new IconBitmapDecoder(new Uri("pack://application:,,,/app.ico"), BitmapCreateOptions.None, BitmapCacheOption.OnLoad);
            return decoder.Frames.OrderByDescending(f => f.PixelWidth).First();
        }
        catch { return null; }
    }
}
