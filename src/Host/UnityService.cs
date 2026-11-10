using System.Text.Json.Nodes;

namespace ModelViewer;

/// <summary>Unity projects from Unity Hub, and copying an exported FBX + textures into a project's Assets.</summary>
public static class UnityService
{
    public static JsonArray Projects()
    {
        var list = new List<(string title, string path, string version, long modified, bool fav)>();
        try
        {
            var file = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "UnityHub", "projects-v1.json");
            if (File.Exists(file))
            {
                var root = JsonNode.Parse(File.ReadAllText(file));
                if (root?["data"] is JsonObject data)
                {
                    foreach (var (_, v) in data)
                    {
                        var path = v?["path"]?.GetValue<string>();
                        if (string.IsNullOrEmpty(path) || !Directory.Exists(Path.Combine(path, "Assets"))) continue;
                        list.Add((v?["title"]?.GetValue<string>() ?? Path.GetFileName(path), path,
                            v?["version"]?.GetValue<string>() ?? "",
                            TryLong(v?["lastModified"]), TryBool(v?["isFavorite"])));
                    }
                }
            }
        }
        catch (Exception ex) { Log.Error("Unity projects", ex); }

        var custom = Settings.Current.UnityProject;
        if (!string.IsNullOrEmpty(custom) && Directory.Exists(Path.Combine(custom, "Assets")) &&
            !list.Any(p => string.Equals(p.path, custom, StringComparison.OrdinalIgnoreCase)))
            list.Add((Path.GetFileName(custom), custom, "", 0, false));

        var arr = new JsonArray();
        foreach (var p in list.OrderByDescending(p => p.fav).ThenByDescending(p => p.modified))
            arr.Add(new JsonObject { ["title"] = p.title, ["path"] = p.path, ["version"] = p.version, ["favorite"] = p.fav });
        return arr;
    }

    static long TryLong(JsonNode? n) { try { return n?.GetValue<long>() ?? 0; } catch { return 0; } }
    static bool TryBool(JsonNode? n) { try { return n?.GetValue<bool>() ?? false; } catch { return false; } }

    /// <summary>
    /// Copies an FBX (and its Textures folder and .materials.json if present) to
    /// &lt;project&gt;/&lt;subfolder&gt;/&lt;assetName&gt;/. Unity re-imports when it regains focus.
    /// </summary>
    public static JsonObject Send(string fbx, string project, string subfolder, string? assetName, bool installImporter,
        IReadOnlyList<string>? textures = null)
    {
        if (!File.Exists(fbx)) throw new FileNotFoundException("FBX not found", fbx);
        if (!Directory.Exists(Path.Combine(project, "Assets"))) throw new DirectoryNotFoundException("Not a Unity project: " + project);
        subfolder = subfolder.Replace('/', '\\').Trim('\\');
        if (!subfolder.StartsWith("Assets", StringComparison.OrdinalIgnoreCase)) subfolder = Path.Combine("Assets", subfolder);
        assetName ??= Path.GetFileNameWithoutExtension(fbx);
        var dest = Path.Combine(project, subfolder, assetName);
        Directory.CreateDirectory(dest);

        var copied = new JsonArray();
        var fbxDest = Path.Combine(dest, Path.GetFileName(fbx));
        LibraryService.CopyFile(fbx, fbxDest, true);
        copied.Add(fbxDest);

        var srcDir = Path.GetDirectoryName(fbx)!;
        var manifest = Path.ChangeExtension(fbx, ".materials.json");
        if (File.Exists(manifest))
        {
            var m = Path.Combine(dest, Path.GetFileName(manifest));
            LibraryService.CopyFile(manifest, m, true);
            copied.Add(m);
        }
        var tex = Path.Combine(srcDir, "Textures");
        var listed = (textures ?? Array.Empty<string>())
            .Select(t => t.Replace('/', Path.DirectorySeparatorChar))
            .Where(t => !Path.IsPathRooted(t) && !t.Split(Path.DirectorySeparatorChar).Contains("..") && File.Exists(Path.Combine(srcDir, t)))
            .Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        if (textures != null)
        {
            // Only what this export references (the folder next to a source model may hold other models' textures).
            foreach (var t in listed)
            {
                var to = Path.Combine(dest, t);
                Directory.CreateDirectory(Path.GetDirectoryName(to)!);
                LibraryService.CopyFile(Path.Combine(srcDir, t), to, true);
            }
            copied.Add(Path.Combine(dest, "Textures"));
        }
        else if (Directory.Exists(tex))
        {
            LibraryService.CopyDirectory(tex, Path.Combine(dest, "Textures"), true);
            copied.Add(Path.Combine(dest, "Textures"));
        }

        string? importer = null;
        if (installImporter)
        {
            var src = Path.Combine(Program.BaseDir, "unity", "MeshboxModelImporter.cs");
            if (File.Exists(src))
            {
                importer = Path.Combine(project, "Assets", "Editor", "MeshboxModelImporter.cs");
                LibraryService.CopyFile(src, importer, true);
            }
        }
        Settings.Update(s => { s.UnityProject = project; s.UnitySubfolder = subfolder.Replace('\\', '/'); });
        return new JsonObject { ["dest"] = dest, ["copied"] = copied, ["importer"] = importer };
    }
}
