// Meshbox setup: one exe that installs Meshbox for the current Windows user (no admin rights).
//   MeshboxSetup.exe                    the setup window
//   MeshboxSetup.exe /quiet [/desktop]  silent install (exit code 0 = ok)
//   MeshboxSetup.exe /demo              shows every screen without installing anything
using System.Windows;

namespace MeshboxSetup;

static class Program
{
    [STAThread]
    static int Main(string[] args)
    {
        var flags = new HashSet<string>(args.Select(a => a.TrimStart('/', '-').ToLowerInvariant()));
        bool desktop = flags.Contains("desktop");
        if (flags.Contains("quiet") || flags.Contains("silent") || flags.Contains("s"))
        {
            try
            {
                foreach (var p in Installer.RunningInstances()) Installer.Kill(p);
                Installer.Install(desktop, null);
                return 0;
            }
            catch (Exception e)
            {
                Console.Error.WriteLine(e.Message);
                return 1;
            }
        }
        var app = new Application { ShutdownMode = ShutdownMode.OnMainWindowClose };
        var window = new SetupWindow(desktop, flags.Contains("demo"));
        app.Run(window);
        return window.Succeeded ? 0 : 1;
    }
}
