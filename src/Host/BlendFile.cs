using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.IO.Compression;
using System.Text;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace ModelViewer;

/// <summary>
/// Reads what a .blend says about itself without starting Blender: the version that saved it, whether
/// it is compressed (gzip &lt; 3.0, zstd 3.0+), and the embedded preview thumbnail ("TEST" block).
/// Handles the legacy header ("BLENDER-v405") and the 5.0+ header ("BLENDER17-01v0500").
/// </summary>
public static class BlendFile
{
    public sealed class Header
    {
        public string Version { get; set; } = "";      // "4.5", "5.2", "2.83"
        public string Compression { get; set; } = "none"; // none | gzip | zstd
        public int PointerSize { get; set; }
        public int FormatVersion { get; set; }          // 0 legacy, 1 = large bheads (5.0+)
        public int HeaderSize { get; set; }
    }

    static readonly ConcurrentDictionary<string, (DateTime stamp, byte[]? png)> thumbCache = new(StringComparer.OrdinalIgnoreCase);

    public static Stream OpenDecompressed(string path, out string compression)
    {
        var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 1 << 16);
        Span<byte> magic = stackalloc byte[4];
        int n = fs.Read(magic);
        fs.Position = 0;
        if (n >= 2 && magic[0] == 0x1F && magic[1] == 0x8B)
        {
            compression = "gzip";
            return new BufferedStream(new GZipStream(fs, CompressionMode.Decompress), 1 << 16);
        }
        if (n == 4 && magic[0] == 0x28 && magic[1] == 0xB5 && magic[2] == 0x2F && magic[3] == 0xFD)
        {
            compression = "zstd";
            return new BufferedStream(new ZstdSharp.DecompressionStream(fs), 1 << 16);
        }
        compression = "none";
        return fs;
    }

    public static Header? ReadHeader(string path)
    {
        try
        {
            using var s = OpenDecompressed(path, out var comp);
            var h = ParseHeader(s);
            if (h != null) h.Compression = comp;
            return h;
        }
        catch { return null; }
    }

    static Header? ParseHeader(Stream s)
    {
        var buf = new byte[17];
        if (!ReadExactly(s, buf, 12)) return null;
        if (Encoding.ASCII.GetString(buf, 0, 7) != "BLENDER") return null;
        var h = new Header();
        if (char.IsDigit((char)buf[7]) && char.IsDigit((char)buf[8]))
        {
            // BLENDER17-01v0500
            h.HeaderSize = int.Parse(Encoding.ASCII.GetString(buf, 7, 2));
            if (h.HeaderSize < 17 || h.HeaderSize > 64) return null;
            var tail = new byte[h.HeaderSize - 12];
            if (!ReadExactly(s, tail, tail.Length)) return null;
            var all = new byte[h.HeaderSize];
            Array.Copy(buf, all, 12);
            Array.Copy(tail, 0, all, 12, tail.Length);
            h.PointerSize = 8;
            h.FormatVersion = int.Parse(Encoding.ASCII.GetString(all, 10, 2));
            var v = int.Parse(Encoding.ASCII.GetString(all, 13, 4));
            h.Version = $"{v / 100}.{v % 100}";
        }
        else
        {
            h.HeaderSize = 12;
            h.PointerSize = buf[7] == (byte)'_' ? 4 : 8;
            h.FormatVersion = 0;
            var v = int.Parse(Encoding.ASCII.GetString(buf, 9, 3));
            h.Version = $"{v / 100}.{v % 100}";
        }
        return h;
    }

    /// <summary>The embedded preview as PNG bytes, or null when the file has none.</summary>
    public static byte[]? ReadThumbnailPng(string path)
    {
        try
        {
            var stamp = File.GetLastWriteTimeUtc(path);
            if (thumbCache.TryGetValue(path, out var c) && c.stamp == stamp) return c.png;
            var t = ReadThumbnail(path);
            var png = t == null ? null : EncodePng(t.Value.w, t.Value.h, t.Value.rgba);
            if (thumbCache.Count > 800) thumbCache.Clear();
            thumbCache[path] = (stamp, png);
            return png;
        }
        catch (Exception ex)
        {
            Log.Error("Blend thumbnail " + path, ex);
            return null;
        }
    }

    public static (int w, int h, byte[] rgba)? ReadThumbnail(string path)
    {
        using var s = OpenDecompressed(path, out _);
        var h = ParseHeader(s);
        if (h == null) return null;
        int bheadSize = h.FormatVersion >= 1 ? 32 : (h.PointerSize == 8 ? 24 : 20);
        var bh = new byte[bheadSize];
        for (int block = 0; block < 64; block++)
        {
            if (!ReadExactly(s, bh, bheadSize)) return null;
            var code = Encoding.ASCII.GetString(bh, 0, 4);
            long len = h.FormatVersion >= 1
                ? BinaryPrimitives.ReadInt64LittleEndian(bh.AsSpan(16, 8))
                : BinaryPrimitives.ReadInt32LittleEndian(bh.AsSpan(4, 4));
            if (len < 0 || len > 1L << 31) return null;
            if (code == "TEST")
            {
                var data = new byte[len];
                if (!ReadExactly(s, data, (int)len)) return null;
                int w = BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan(0, 4));
                int ht = BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan(4, 4));
                if (w <= 0 || ht <= 0 || w > 4096 || ht > 4096 || 8L + (long)w * ht * 4 > len) return null;
                var rgba = new byte[w * ht * 4];
                int stride = w * 4;
                // Rows are stored bottom-up.
                for (int y = 0; y < ht; y++)
                    Buffer.BlockCopy(data, 8 + (ht - 1 - y) * stride, rgba, y * stride, stride);
                return (w, ht, rgba);
            }
            if (code.StartsWith("ENDB") || code == "DNA1") return null;
            if (!Skip(s, len)) return null;
        }
        return null;
    }

    static byte[] EncodePng(int w, int h, byte[] rgba)
    {
        var bgra = new byte[rgba.Length];
        for (int i = 0; i < rgba.Length; i += 4)
        {
            bgra[i] = rgba[i + 2];
            bgra[i + 1] = rgba[i + 1];
            bgra[i + 2] = rgba[i];
            bgra[i + 3] = rgba[i + 3];
        }
        var bmp = BitmapSource.Create(w, h, 96, 96, PixelFormats.Bgra32, null, bgra, w * 4);
        bmp.Freeze();
        var enc = new PngBitmapEncoder();
        enc.Frames.Add(BitmapFrame.Create(bmp));
        using var ms = new MemoryStream();
        enc.Save(ms);
        return ms.ToArray();
    }

    static bool ReadExactly(Stream s, byte[] buf, int count)
    {
        int off = 0;
        while (off < count)
        {
            int n = s.Read(buf, off, count - off);
            if (n <= 0) return false;
            off += n;
        }
        return true;
    }

    static bool Skip(Stream s, long count)
    {
        if (s.CanSeek)
        {
            if (s.Position + count > s.Length) return false;
            s.Seek(count, SeekOrigin.Current);
            return true;
        }
        var tmp = new byte[81920];
        while (count > 0)
        {
            int n = s.Read(tmp, 0, (int)Math.Min(tmp.Length, count));
            if (n <= 0) return false;
            count -= n;
        }
        return true;
    }
}
