using System.Windows;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;

namespace MeshboxSetup;

/// <summary>The setup window: Welcome (install / update) → progress → Done or Error.</summary>
public partial class SetupWindow : Window
{
    enum Page { Welcome, Work, Done, Error }

    readonly bool demo;
    readonly string? installed;
    Page page = Page.Welcome;
    public bool Succeeded { get; private set; }

    public SetupWindow(bool desktopDefault, bool demo)
    {
        InitializeComponent();
        this.demo = demo;
        var logo = Installer.Logo();
        Logo.Source = logo;
        if (logo != null) Icon = logo;
        installed = Installer.InstalledVersion();
        var version = Installer.Version;
        VersionText.Text = $"Version {version}";
        LocationText.Text = Installer.InstallDir;
        LocationText.ToolTip = Installer.InstallDir;
        DesktopBox.IsChecked = desktopDefault;

        bool same = installed == version;
        WelcomeTitle.Text = installed == null ? "Install Meshbox" : same ? $"Reinstall Meshbox {version}" : "Update Meshbox";
        WelcomeText.Text = installed == null
            ? "View, organize and export your 3D models for Unity."
            : same ? "Copies Meshbox again. Your settings, thumbnails and library stay as they are."
            : $"From {installed} to {version}. Your settings, thumbnails and library stay as they are.";
        PrimaryBtn.Content = installed == null ? "Install" : same ? "Reinstall" : "Update";
        WorkTitle.Text = installed == null ? "Installing Meshbox" : "Updating Meshbox";
        DoneTitle.Text = installed == null ? "Meshbox is installed" : $"Meshbox {version} is ready";

        var notes = new List<string>();
        if (!demo && Installer.RunningInstances().Count > 0) notes.Add("Meshbox is open. It will be closed when you continue, so save any export in progress first.");
        if (!Installer.WebView2Installed()) notes.Add("Meshbox needs the Microsoft Edge WebView2 Runtime (part of Windows 11). Get it from microsoft.com/edge/webview2.");
        if (notes.Count > 0) { NoteText.Text = string.Join("\n\n", notes); Note.Visibility = Visibility.Visible; }

        PrimaryBtn.Click += async (_, _) => await OnPrimary();
        SecondaryBtn.Click += (_, _) => Close();
        CloseX.Click += (_, _) => Close();
        MouseLeftButtonDown += (_, e) => { if (!IsOnControl(e.OriginalSource as DependencyObject) && e.ButtonState == MouseButtonState.Pressed) DragMove(); };
        KeyDown += (_, e) => { if (e.Key == Key.Escape && page != Page.Work) Close(); };
        Closing += (_, e) => { if (page == Page.Work) e.Cancel = true; };
        Loaded += (_, _) => FadeIn(PageWelcome);
    }

    async Task OnPrimary()
    {
        switch (page)
        {
            case Page.Welcome: await RunInstall(); break;
            case Page.Done:
                if (LaunchBox.IsChecked == true && !demo) Installer.Launch();
                Close();
                break;
            default: Close(); break;
        }
    }

    async Task RunInstall()
    {
        Show(Page.Work);
        if (!demo) foreach (var p in Installer.RunningInstances()) Installer.Kill(p);
        var progress = new Progress<(int pct, string text)>(p => SetProgress(p.pct, p.text));
        try
        {
            bool desktop = DesktopBox.IsChecked == true;
            if (demo) await Installer.FakeInstall(progress);
            else await Task.Run(() => Installer.Install(desktop, progress));
            Succeeded = true;
            await Task.Delay(250);
            Show(Page.Done);
        }
        catch (Exception ex)
        {
            ErrorText.Text = ex.Message;
            Show(Page.Error);
        }
    }

    void SetProgress(int pct, string text)
    {
        StepText.Text = text;
        PctText.Text = $"{pct}%";
        var to = Math.Max(0, Track.ActualWidth * pct / 100.0);
        Fill.BeginAnimation(WidthProperty, new DoubleAnimation(to, TimeSpan.FromMilliseconds(220)) { EasingFunction = new QuadraticEase() });
    }

    void Show(Page next)
    {
        page = next;
        var pages = new Dictionary<Page, FrameworkElement> { [Page.Welcome] = PageWelcome, [Page.Work] = PageWork, [Page.Done] = PageDone, [Page.Error] = PageError };
        foreach (var (key, el) in pages) el.Visibility = key == next ? Visibility.Visible : Visibility.Collapsed;
        FadeIn(pages[next]);
        CloseX.IsEnabled = next != Page.Work;
        SecondaryBtn.Visibility = next == Page.Welcome ? Visibility.Visible : Visibility.Collapsed;
        PrimaryBtn.Visibility = next == Page.Work ? Visibility.Hidden : Visibility.Visible;
        PrimaryBtn.Content = next switch { Page.Done => "Finish", Page.Error => "Close", _ => PrimaryBtn.Content };
        if (next != Page.Work) PrimaryBtn.Focus();
    }

    static void FadeIn(UIElement el)
    {
        el.BeginAnimation(OpacityProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(180)));
        var shift = new TranslateTransform(0, 8);
        el.RenderTransform = shift;
        shift.BeginAnimation(TranslateTransform.YProperty, new DoubleAnimation(8, 0, TimeSpan.FromMilliseconds(220)) { EasingFunction = new QuadraticEase() });
    }

    /// <summary>Dragging the window works anywhere except on buttons, checkboxes and text boxes.</summary>
    static bool IsOnControl(DependencyObject? d)
    {
        for (; d != null; d = d is Visual || d is System.Windows.Media.Media3D.Visual3D ? VisualTreeHelper.GetParent(d) : LogicalTreeHelper.GetParent(d))
            if (d is ButtonBase || d is System.Windows.Controls.TextBox) return true;
        return false;
    }
}
