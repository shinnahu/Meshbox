using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace ModelViewer;

public sealed class WindowPlacement
{
    public double Left { get; set; }
    public double Top { get; set; }
    public double Width { get; set; } = 1440;
    public double Height { get; set; } = 900;
    public bool Maximized { get; set; }
}

public sealed class HostSettings
{
    /// <summary>Files opened from Explorer while running: new window (true) or reuse the last one.</summary>
    public bool OpenInNewWindow { get; set; } = true;
    public string? BlenderPath { get; set; }
    /// <summary>Where organized assets live, e.g. E:\3D Library.</summary>
    public string? LibraryRoot { get; set; }
    /// <summary>Extra folders the library scans (project folders that are not organized yet).</summary>
    public List<string> ScanRoots { get; set; } = new();
    public List<string> TextureFolders { get; set; } = new();
    public List<string> Recent { get; set; } = new();
    public WindowPlacement? Window { get; set; }
    public string? UnityProject { get; set; }
    public string UnitySubfolder { get; set; } = "Assets/Models";
    public string? ScreenshotDir { get; set; }
    /// <summary>Free-form UI preferences the web side wants to keep host-side.</summary>
    public JsonObject Ui { get; set; } = new();
}

public static class Settings
{
    public static HostSettings Current { get; private set; } = new();
    static readonly object gate = new();
    static Timer? saveTimer;
    static string FilePath => Path.Combine(Program.ConfigDir, "settings.json");

    public static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DictionaryKeyPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        PropertyNameCaseInsensitive = true,
    };

    public static void Load()
    {
        try
        {
            if (File.Exists(FilePath))
                Current = JsonSerializer.Deserialize<HostSettings>(File.ReadAllText(FilePath), Json) ?? new();
        }
        catch (Exception ex)
        {
            Log.Error("Settings load", ex);
            Diag.Write($"settings load failed ({FilePath}): {ex.GetType().Name}: {ex.Message}");
            Current = new();
        }
    }

    public static void Update(Action<HostSettings> change)
    {
        lock (gate) change(Current);
        SaveSoon();
    }

    public static void SaveSoon()
    {
        lock (gate)
        {
            saveTimer?.Dispose();
            saveTimer = new Timer(_ => SaveNow(), null, 400, Timeout.Infinite);
        }
    }

    public static void SaveNow()
    {
        try
        {
            string text;
            lock (gate) text = JsonSerializer.Serialize(Current, Json);
            Directory.CreateDirectory(Program.ConfigDir);
            var tmp = FilePath + ".tmp";
            File.WriteAllText(tmp, text);
            File.Move(tmp, FilePath, true);
        }
        catch (Exception ex) { Log.Error("Settings save", ex); }
    }

    public static void AddRecent(string path)
    {
        Update(s =>
        {
            s.Recent.RemoveAll(p => string.Equals(p, path, StringComparison.OrdinalIgnoreCase));
            s.Recent.Insert(0, path);
            if (s.Recent.Count > 24) s.Recent.RemoveRange(24, s.Recent.Count - 24);
        });
    }
}
