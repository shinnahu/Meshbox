using Microsoft.Win32;

namespace ModelViewer;

/// <summary>
/// Per-user registration (HKCU, no admin): the app appears in "Open with" for 3D formats and in
/// Settings &gt; Default apps. It never takes over a default on its own; Windows asks the user for that.
/// </summary>
public static class ShellIntegration
{
    const string ProgId = "Meshbox.Model";
    const string AppKey = @"Software\Meshbox";
    public static readonly string[] Extensions = [".fbx", ".glb", ".gltf", ".obj", ".blend", ".stl", ".ply", ".dae", ".3ds", ".3mf", ".vrm", ".usdz"];

    static string Exe => Environment.ProcessPath ?? Path.Combine(Program.BaseDir, Program.ExeName);

    public static bool IsRegistered()
    {
        using var k = Registry.CurrentUser.OpenSubKey($@"Software\Classes\{ProgId}\shell\open\command");
        var cmd = k?.GetValue(null) as string;
        return cmd != null && cmd.Contains(Exe, StringComparison.OrdinalIgnoreCase);
    }

    public static void Register()
    {
        var exe = Exe;
        using (var k = Registry.CurrentUser.CreateSubKey($@"Software\Classes\{ProgId}"))
        {
            k.SetValue(null, "3D model");
            k.SetValue("FriendlyTypeName", "3D model");
            using (var icon = k.CreateSubKey("DefaultIcon")) icon.SetValue(null, $"\"{exe}\",0");
            using (var cmd = k.CreateSubKey(@"shell\open\command")) cmd.SetValue(null, $"\"{exe}\" \"%1\"");
        }
        using (var app = Registry.CurrentUser.CreateSubKey($@"Software\Classes\Applications\{Program.ExeName}"))
        {
            app.SetValue("FriendlyAppName", Program.AppName);
            using (var cmd = app.CreateSubKey(@"shell\open\command")) cmd.SetValue(null, $"\"{exe}\" \"%1\"");
            using var types = app.CreateSubKey("SupportedTypes");
            foreach (var ext in Extensions) types.SetValue(ext, "");
        }
        foreach (var ext in Extensions)
        {
            using var k = Registry.CurrentUser.CreateSubKey($@"Software\Classes\{ext}\OpenWithProgids");
            k.SetValue(ProgId, Array.Empty<byte>(), RegistryValueKind.None);
        }
        using (var caps = Registry.CurrentUser.CreateSubKey($@"{AppKey}\Capabilities"))
        {
            caps.SetValue("ApplicationName", Program.AppName);
            caps.SetValue("ApplicationDescription", "Fast viewer and organizer for FBX, Blender and glTF models.");
            using var assoc = caps.CreateSubKey("FileAssociations");
            foreach (var ext in Extensions) assoc.SetValue(ext, ProgId);
        }
        using (var reg = Registry.CurrentUser.CreateSubKey(@"Software\RegisteredApplications"))
            reg.SetValue("Meshbox", $@"{AppKey}\Capabilities");

        Native.SHChangeNotify(0x08000000 /* SHCNE_ASSOCCHANGED */, 0, IntPtr.Zero, IntPtr.Zero);
    }

    public static void Unregister()
    {
        try { Registry.CurrentUser.DeleteSubKeyTree($@"Software\Classes\{ProgId}", false); } catch { }
        try { Registry.CurrentUser.DeleteSubKeyTree($@"Software\Classes\Applications\{Program.ExeName}", false); } catch { }
        foreach (var ext in Extensions)
        {
            try
            {
                using var k = Registry.CurrentUser.OpenSubKey($@"Software\Classes\{ext}\OpenWithProgids", true);
                k?.DeleteValue(ProgId, false);
            }
            catch { }
        }
        try { Registry.CurrentUser.DeleteSubKeyTree(AppKey, false); } catch { }
        try
        {
            using var reg = Registry.CurrentUser.OpenSubKey(@"Software\RegisteredApplications", true);
            reg?.DeleteValue("Meshbox", false);
        }
        catch { }
        Native.SHChangeNotify(0x08000000, 0, IntPtr.Zero, IntPtr.Zero);
    }
}
