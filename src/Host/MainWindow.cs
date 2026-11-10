using System.Windows;
using System.Windows.Media;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace ModelViewer;

public sealed class MainWindow : Window
{
    public const string AppHost = "app.viewer";
    readonly WebView2 web;
    readonly Bridge bridge;
    string? pendingFile;
    bool fullscreen;
    WindowState prevState;
    WindowStyle prevStyle;
    ResizeMode prevResize;

    public DateTime LastActivated { get; private set; } = DateTime.Now;
    /// <summary>Set by the web side while a long job (Blender, organize) runs, so Explorer opens go to a new window.</summary>
    public bool IsBusy { get; set; }
    public CoreWebView2? Core => web.CoreWebView2;
    public bool IsFullscreen => fullscreen;

    public MainWindow(string? file)
    {
        pendingFile = file;
        Title = file != null ? $"{Path.GetFileName(file)} - {Program.AppName}" : Program.AppName;
        Background = new SolidColorBrush(Color.FromRgb(0x1E, 0x1F, 0x22));
        MinWidth = 720;
        MinHeight = 480;
        ApplyPlacement();

        web = new WebView2
        {
            DefaultBackgroundColor = System.Drawing.Color.FromArgb(0x1E, 0x1F, 0x22),
            AllowExternalDrop = true,
        };
        Content = web;
        bridge = new Bridge(this);

        SourceInitialized += (_, _) => { Native.StyleTitleBar(this); Log.Info($"startup: window {Program.Uptime} ms"); };
        Activated += (_, _) => LastActivated = DateTime.Now;
        Loaded += async (_, _) => await InitAsync();
        Closing += (_, _) => SavePlacement();
        Closed += (_, _) => bridge.Dispose();
    }

    void ApplyPlacement()
    {
        var p = Settings.Current.Window;
        var others = Application.Current.Windows.OfType<MainWindow>().Count(w => w != this);
        if (p != null && p.Width > 200 && p.Height > 200)
        {
            Width = p.Width; Height = p.Height;
            var area = SystemParameters.VirtualScreenWidth > 0
                ? new Rect(SystemParameters.VirtualScreenLeft, SystemParameters.VirtualScreenTop, SystemParameters.VirtualScreenWidth, SystemParameters.VirtualScreenHeight)
                : SystemParameters.WorkArea;
            if (area.Contains(new Point(p.Left + 40, p.Top + 20)))
            {
                WindowStartupLocation = WindowStartupLocation.Manual;
                Left = p.Left + others * 28;
                Top = p.Top + others * 28;
            }
            else WindowStartupLocation = WindowStartupLocation.CenterScreen;
            if (p.Maximized && others == 0) WindowState = WindowState.Maximized;
        }
        else
        {
            Width = Math.Min(1500, SystemParameters.WorkArea.Width * 0.85);
            Height = Math.Min(940, SystemParameters.WorkArea.Height * 0.88);
            WindowStartupLocation = WindowStartupLocation.CenterScreen;
        }
    }

    void SavePlacement()
    {
        if (fullscreen) SetFullscreen(false);
        var r = WindowState == WindowState.Normal ? new Rect(Left, Top, Width, Height) : RestoreBounds;
        if (r.Width < 200 || double.IsInfinity(r.Width)) return;
        Settings.Update(s => s.Window = new WindowPlacement
        {
            Left = r.Left, Top = r.Top, Width = r.Width, Height = r.Height,
            Maximized = WindowState == WindowState.Maximized,
        });
        Settings.SaveNow();
    }

    async Task InitAsync()
    {
        try
        {
            var env = await Program.WebEnv;
            await web.EnsureCoreWebView2Async(env);
        }
        catch (Exception ex)
        {
            Log.Error("WebView2 init", ex);
            MessageBox.Show(this,
                "Microsoft Edge WebView2 Runtime could not start.\n\n" + ex.Message +
                "\n\nInstall it from https://developer.microsoft.com/microsoft-edge/webview2/",
                Program.AppName, MessageBoxButton.OK, MessageBoxImage.Error);
            Close();
            return;
        }

        var core = web.CoreWebView2;
        bool dev = Environment.GetEnvironmentVariable("MESHBOX_DEV") == "1";
        core.Settings.AreDevToolsEnabled = dev;
        core.Settings.AreDefaultContextMenusEnabled = dev;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.IsZoomControlEnabled = false;
        core.Settings.IsPinchZoomEnabled = false;
        core.Settings.IsSwipeNavigationEnabled = false;
        core.Settings.AreBrowserAcceleratorKeysEnabled = dev;
        core.Settings.IsGeneralAutofillEnabled = false;
        core.Settings.IsPasswordAutosaveEnabled = false;

        core.SetVirtualHostNameToFolderMapping(AppHost, Program.WebDir, CoreWebView2HostResourceAccessKind.Allow);
        FileServer.Attach(core, this);
        core.WebMessageReceived += bridge.OnMessage;
        core.NewWindowRequested += (_, e) =>
        {
            e.Handled = true;
            OpenExternal(e.Uri);
        };
        core.NavigationStarting += (_, e) =>
        {
            // Only our UI may load in the window; anything else goes to the default browser.
            if (!e.Uri.StartsWith($"https://{AppHost}/", StringComparison.OrdinalIgnoreCase))
            {
                e.Cancel = true;
                if (e.Uri.StartsWith("http", StringComparison.OrdinalIgnoreCase)) OpenExternal(e.Uri);
            }
        };
        core.ProcessFailed += (_, e) => Log.Error($"WebView2 process failed: {e.ProcessFailedKind} {e.Reason}");
        core.NavigationCompleted += (_, _) => Log.Info($"startup: page {Program.Uptime} ms");
        Log.Info($"startup: webview {Program.Uptime} ms");
        core.Navigate($"https://{AppHost}/index.html");
    }

    static void OpenExternal(string uri)
    {
        try
        {
            if (uri.StartsWith("http", StringComparison.OrdinalIgnoreCase))
                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(uri) { UseShellExecute = true });
        }
        catch { }
    }

    /// <summary>The file this window was launched with; handed to the UI once (app.init).</summary>
    public string? TakePendingFile()
    {
        var f = pendingFile;
        pendingFile = null;
        return f;
    }

    public void OpenFile(string path)
    {
        if (web.CoreWebView2 == null) { pendingFile = path; return; }
        bridge.Emit("open", new { path });
    }

    public void BringToFront() => Native.ForceForeground(this);

    public void SetFullscreen(bool on)
    {
        if (on == fullscreen) return;
        if (on)
        {
            prevState = WindowState; prevStyle = WindowStyle; prevResize = ResizeMode;
            WindowStyle = WindowStyle.None;
            ResizeMode = ResizeMode.NoResize;
            if (WindowState == WindowState.Maximized) WindowState = WindowState.Normal;
            WindowState = WindowState.Maximized;
        }
        else
        {
            WindowStyle = prevStyle;
            ResizeMode = prevResize;
            WindowState = prevState == WindowState.Minimized ? WindowState.Normal : prevState;
        }
        fullscreen = on;
        bridge.Emit("fullscreen", new { on });
    }
}
