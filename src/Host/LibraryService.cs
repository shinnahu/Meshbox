using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json.Nodes;

namespace ModelViewer;

/// <summary>File-level work for the library: scanning folders, hashing, copying, recycling, NTFS compression.</summary>
public static class LibraryService
{
    public static readonly HashSet<string> ModelExts = new(StringComparer.OrdinalIgnoreCase)
    { ".fbx", ".blend", ".glb", ".gltf", ".vrm", ".obj", ".stl", ".ply", ".dae", ".3ds", ".3mf", ".usdz", ".usd", ".usda", ".usdc" };

    static readonly HashSet<string> SkipDirs = new(StringComparer.OrdinalIgnoreCase)
    { "node_modules", "Library", "Temp", "Logs", "obj", "bin", "PackageCache", "$RECYCLE.BIN", "System Volume Information", "__pycache__", ".git", ".svn", ".vs", ".idea" };

    public static string ThumbDir => Path.Combine(Program.DataDir, "thumbs");
    public static string IndexPath => Path.Combine(Program.DataDir, "library-index.json");

    public sealed record ScanFile(string Path, string Name, string Ext, long Size, DateTime Modified);

    /// <summary>All model files under the roots, plus Blender auto-backups (.blend1, .blend2...) for cleanup.</summary>
    public static (List<ScanFile> models, List<ScanFile> backups, int dirs) Scan(IEnumerable<string> roots, Action<int, string>? progress, CancellationToken ct)
    {
        var models = new List<ScanFile>();
        var backups = new List<ScanFile>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        int dirs = 0;
        foreach (var root in roots.Where(Directory.Exists))
        {
            var stack = new Stack<string>();
            stack.Push(root);
            while (stack.Count > 0)
            {
                ct.ThrowIfCancellationRequested();
                var d = stack.Pop();
                if (!seen.Add(d)) continue;
                dirs++;
                if (dirs % 200 == 0) progress?.Invoke(models.Count, d);
                try
                {
                    foreach (var f in new DirectoryInfo(d).EnumerateFiles())
                    {
                        var ext = f.Extension;
                        if (ModelExts.Contains(ext))
                            models.Add(new ScanFile(f.FullName, f.Name, ext.ToLowerInvariant(), f.Length, f.LastWriteTime));
                        else if (ext.Length > 6 && ext.StartsWith(".blend", StringComparison.OrdinalIgnoreCase) && char.IsDigit(ext[6]))
                            backups.Add(new ScanFile(f.FullName, f.Name, ext.ToLowerInvariant(), f.Length, f.LastWriteTime));
                    }
                    foreach (var sub in Directory.EnumerateDirectories(d))
                    {
                        var name = Path.GetFileName(sub);
                        if (SkipDirs.Contains(name) || name.StartsWith('.')) continue;
                        var attr = File.GetAttributes(sub);
                        if ((attr & FileAttributes.System) != 0 || (attr & FileAttributes.ReparsePoint) != 0) continue;
                        stack.Push(sub);
                    }
                }
                catch (UnauthorizedAccessException) { }
                catch (IOException) { }
            }
        }
        return (models, backups, dirs);
    }

    public static string Sha256(string path)
    {
        using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite, 1 << 20, FileOptions.SequentialScan);
        return Convert.ToHexString(SHA256.HashData(fs)).ToLowerInvariant();
    }

    /// <summary>Copies a file; refuses to overwrite unless asked; verifies size afterwards; keeps timestamps.</summary>
    public static void CopyFile(string from, string to, bool overwrite)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(to)!);
        File.Copy(from, to, overwrite);
        var a = new FileInfo(from);
        var b = new FileInfo(to);
        if (a.Length != b.Length) throw new IOException($"Copy of {a.Name} is incomplete.");
        File.SetLastWriteTime(to, a.LastWriteTime);
    }

    public static void CopyDirectory(string from, string to, bool overwrite)
    {
        foreach (var f in Directory.EnumerateFiles(from, "*", SearchOption.AllDirectories))
        {
            var rel = Path.GetRelativePath(from, f);
            CopyFile(f, Path.Combine(to, rel), overwrite);
        }
    }

    /// <summary>Sends files or folders to the Recycle Bin (never a permanent delete).</summary>
    public static JsonObject Recycle(IEnumerable<string> paths)
    {
        var ok = new JsonArray();
        var failed = new JsonArray();
        long freed = 0;
        foreach (var p in paths)
        {
            try
            {
                if (File.Exists(p))
                {
                    var len = new FileInfo(p).Length;
                    Microsoft.VisualBasic.FileIO.FileSystem.DeleteFile(p,
                        Microsoft.VisualBasic.FileIO.UIOption.OnlyErrorDialogs,
                        Microsoft.VisualBasic.FileIO.RecycleOption.SendToRecycleBin);
                    freed += len;
                    ok.Add(p);
                }
                else if (Directory.Exists(p))
                {
                    var len = Directory.EnumerateFiles(p, "*", SearchOption.AllDirectories).Sum(f => new FileInfo(f).Length);
                    Microsoft.VisualBasic.FileIO.FileSystem.DeleteDirectory(p,
                        Microsoft.VisualBasic.FileIO.UIOption.OnlyErrorDialogs,
                        Microsoft.VisualBasic.FileIO.RecycleOption.SendToRecycleBin);
                    freed += len;
                    ok.Add(p);
                }
                else failed.Add(new JsonObject { ["path"] = p, ["error"] = "Not found" });
            }
            catch (Exception ex)
            {
                failed.Add(new JsonObject { ["path"] = p, ["error"] = ex.Message });
            }
        }
        return new JsonObject { ["ok"] = ok, ["failed"] = failed, ["freedBytes"] = freed };
    }

    /// <summary>
    /// Transparent NTFS compression (compact /EXE:LZX). Files stay normal files Blender opens directly,
    /// they just take less disk space. Used for archived versions. Returns bytes saved (best effort).
    /// </summary>
    public static async Task<long> CompressAsync(IEnumerable<string> files)
    {
        long saved = 0;
        foreach (var f in files.Where(File.Exists))
        {
            var before = new FileInfo(f).Length;
            var psi = new ProcessStartInfo("compact.exe")
            {
                UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, RedirectStandardError = true,
            };
            psi.ArgumentList.Add("/c");
            psi.ArgumentList.Add("/exe:lzx");
            psi.ArgumentList.Add("/q");
            psi.ArgumentList.Add(f);
            try
            {
                using var p = Process.Start(psi)!;
                await p.StandardOutput.ReadToEndAsync();
                await p.WaitForExitAsync();
                var after = CompressedSize(f);
                if (after > 0 && after < before) saved += before - after;
            }
            catch (Exception ex) { Log.Error("compact " + f, ex); }
        }
        return saved;
    }

    [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
    static extern uint GetCompressedFileSizeW(string lpFileName, out uint lpFileSizeHigh);

    public static long CompressedSize(string path)
    {
        uint low = GetCompressedFileSizeW(path, out uint high);
        if (low == 0xFFFFFFFF && System.Runtime.InteropServices.Marshal.GetLastWin32Error() != 0) return -1;
        return ((long)high << 32) + low;
    }

    public static string ThumbPath(string modelPath) =>
        Path.Combine(ThumbDir, BlenderService.Hash(modelPath.ToLowerInvariant()) + ".png");
}
