// Changes material values inside a binary FBX without re-exporting it (no Blender). The file is read into its
// node tree with every property kept as the original bytes (arrays stay compressed), the few numbers are
// changed, and the tree is written back: the rest of the file stays byte for byte the same. Before anything is
// saved, the untouched tree must write back identical to the file, so an unusual layout is refused, not damaged.
using System.Buffers.Binary;
using System.Text;
using System.Text.Json.Nodes;

namespace ModelViewer;

static class FbxEdit
{
    /// <summary>Material values the Materials page may change (FBX names; Blender and Unity read them the same way).</summary>
    static readonly HashSet<string> Editable = new(StringComparer.Ordinal)
        { "EmissiveFactor", "Shininess", "ShininessExponent", "ReflectionFactor", "SpecularFactor" };

    sealed class Node
    {
        public byte[] Name = Array.Empty<byte>();
        public List<byte[]> Props = new();   // type byte + payload, exactly as in the file
        public List<Node> Children = new();
        public bool Nested;                   // the file has a child list (ended by a null record) for this node
        public string Id => Encoding.ASCII.GetString(Name);
    }

    sealed class Doc
    {
        public byte[] Header = Array.Empty<byte>();
        public bool V64;
        public List<Node> Nodes = new();
        public byte[] Footer = Array.Empty<byte>();
        public long FooterStart;
    }

    static readonly byte[] Magic = Encoding.ASCII.GetBytes("Kaydara FBX Binary  \0");
    static readonly byte[] FootMagic = { 0xf8, 0x5a, 0x8c, 0x6a, 0xde, 0xf5, 0xd9, 0x7e, 0xec, 0xe9, 0x0c, 0xe3, 0x75, 0x8f, 0x29, 0x0b };

    public static bool IsBinary(byte[] d) => d.Length > 27 && d.AsSpan(0, Magic.Length).SequenceEqual(Magic);

    /// <summary>"ok", "ascii" or why the file can't be rewritten safely (diagnostics: Meshbox.exe --fbx-check).</summary>
    public static string Check(string path)
    {
        try
        {
            var d = File.ReadAllBytes(path);
            if (!IsBinary(d)) return "ascii";
            return Write(Parse(d)).AsSpan().SequenceEqual(d) ? "ok" : "differs";
        }
        catch (Exception e) { return "error: " + e.Message; }
    }

    /// <summary>
    /// changes: { "Body": { "EmissiveFactor": 0 }, "Face": { "Shininess": 0, "ShininessExponent": 0 } }.
    /// Returns where the previous file went: { saved, recycled, backup, materials }.
    /// </summary>
    public static JsonObject SetMaterials(string path, JsonObject changes)
    {
        var original = File.ReadAllBytes(path);
        if (!IsBinary(original))
            throw new InvalidOperationException("This FBX is saved as text (ASCII). Meshbox can change binary FBX files only: export it again as binary FBX.");
        var doc = Parse(original);
        if (!Write(doc).AsSpan().SequenceEqual(original))
            throw new InvalidOperationException("Meshbox can't write this FBX back without touching other parts of it, so nothing was saved.");

        var objects = doc.Nodes.FirstOrDefault(n => n.Id == "Objects") ?? throw new InvalidDataException("This FBX has no objects.");
        var done = new JsonArray();
        foreach (var (name, values) in changes)
        {
            if (values is not JsonObject props) continue;
            var mats = objects.Children.Where(n => n.Id == "Material" && MaterialName(n) == name).ToList();
            if (mats.Count == 0) throw new InvalidOperationException($"There is no material called \"{name}\" in this file.");
            foreach (var (prop, v) in props)
            {
                if (!Editable.Contains(prop)) throw new ArgumentException($"Meshbox doesn't change \"{prop}\".");
                var value = v!.GetValue<double>();
                if (!double.IsFinite(value) || value < 0 || value > 1000) throw new ArgumentException($"{prop} = {value} is out of range.");
                foreach (var m in mats) SetNumber(m, prop, value);
            }
            done.Add(name);
        }

        var bytes = Write(doc);
        // read it back: same structure, new values in place
        var check = Parse(bytes);
        var checkObjects = check.Nodes.First(n => n.Id == "Objects");
        foreach (var (name, values) in changes)
        {
            if (values is not JsonObject props) continue;
            foreach (var m in checkObjects.Children.Where(n => n.Id == "Material" && MaterialName(n) == name))
                foreach (var (prop, v) in props)
                    if (Math.Abs((GetNumber(m, prop) ?? double.NaN) - v!.GetValue<double>()) > 1e-6)
                        throw new InvalidDataException($"Writing {name}.{prop} failed, nothing was saved.");
        }

        var (recycled, backup) = Replace(path, bytes);
        return new JsonObject { ["saved"] = path, ["recycled"] = recycled, ["backup"] = backup, ["materials"] = done };
    }

    /// <summary>Writes next to the file, keeps a copy of the original in Meshbox's backups and sends it to the
    /// Recycle Bin (fixed drives), then moves the new file into place.</summary>
    static (bool recycled, string backup) Replace(string path, byte[] bytes)
    {
        var tmp = path + ".meshbox-tmp";
        File.WriteAllBytes(tmp, bytes);
        try
        {
            var backups = Path.Combine(Program.DataDir, "backups");
            Directory.CreateDirectory(backups);
            var backup = Path.Combine(backups, $"{DateTime.Now:yyyyMMdd-HHmmss}-{Path.GetFileName(path)}");
            File.Copy(path, backup, true);
            foreach (var old in new DirectoryInfo(backups).GetFiles().OrderByDescending(f => f.CreationTimeUtc).Skip(40))
                try { old.Delete(); } catch { /* in use */ }

            bool recycled = false;
            try
            {
                var root = Path.GetPathRoot(Path.GetFullPath(path));
                if (root != null && new DriveInfo(root).DriveType == DriveType.Fixed)
                {
                    LibraryService.Recycle(new[] { path });
                    recycled = !File.Exists(path);
                }
            }
            catch { /* no Recycle Bin here: the backup copy is the safety net */ }
            File.Move(tmp, path, true);
            return (recycled, backup);
        }
        catch
        {
            if (File.Exists(tmp) && File.Exists(path)) try { File.Delete(tmp); } catch { }
            throw;
        }
    }

    // ------------------------------------------------------------------ materials
    /// <summary>"Body\0\u0001Material" → "Body".</summary>
    static string MaterialName(Node m)
    {
        if (m.Props.Count < 2 || m.Props[1][0] != (byte)'S') return "";
        var s = Encoding.UTF8.GetString(m.Props[1], 5, m.Props[1].Length - 5);
        var cut = s.IndexOf("\0\u0001", StringComparison.Ordinal);
        return cut >= 0 ? s[..cut] : s;
    }

    static string? StringProp(byte[] p) => p.Length >= 5 && p[0] == (byte)'S' ? Encoding.UTF8.GetString(p, 5, p.Length - 5) : null;

    static Node? FindP(Node mat, string prop) =>
        mat.Children.FirstOrDefault(c => c.Id == "Properties70")?.Children
            .FirstOrDefault(c => c.Id == "P" && c.Props.Count >= 5 && StringProp(c.Props[0]) == prop);

    static double? GetNumber(Node mat, string prop)
    {
        var p = FindP(mat, prop);
        if (p == null) return null;
        var v = p.Props[4];
        return (char)v[0] switch
        {
            'D' => BinaryPrimitives.ReadDoubleLittleEndian(v.AsSpan(1)),
            'F' => BinaryPrimitives.ReadSingleLittleEndian(v.AsSpan(1)),
            'I' => BinaryPrimitives.ReadInt32LittleEndian(v.AsSpan(1)),
            'L' => BinaryPrimitives.ReadInt64LittleEndian(v.AsSpan(1)),
            _ => null,
        };
    }

    static void SetNumber(Node mat, string prop, double value)
    {
        var p = FindP(mat, prop);
        if (p != null) { p.Props[4] = Number(value, (char)p.Props[4][0]); return; }
        var p70 = mat.Children.FirstOrDefault(c => c.Id == "Properties70");
        if (p70 == null)
        {
            p70 = new Node { Name = Encoding.ASCII.GetBytes("Properties70"), Nested = true };
            mat.Children.Add(p70);
            mat.Nested = true;
        }
        p70.Nested = true;
        // P: "EmissiveFactor", "Number", "", "A", value - how Blender and the FBX SDK write a plain number
        p70.Children.Add(new Node { Name = Encoding.ASCII.GetBytes("P"), Props = { Str(prop), Str("Number"), Str(""), Str("A"), Number(value, 'D') } });
    }

    static byte[] Str(string s)
    {
        var b = Encoding.UTF8.GetBytes(s);
        var o = new byte[5 + b.Length];
        o[0] = (byte)'S';
        BinaryPrimitives.WriteInt32LittleEndian(o.AsSpan(1), b.Length);
        b.CopyTo(o, 5);
        return o;
    }

    static byte[] Number(double v, char type)
    {
        switch (type)
        {
            case 'F': { var o = new byte[5]; o[0] = (byte)'F'; BinaryPrimitives.WriteSingleLittleEndian(o.AsSpan(1), (float)v); return o; }
            case 'I': { var o = new byte[5]; o[0] = (byte)'I'; BinaryPrimitives.WriteInt32LittleEndian(o.AsSpan(1), (int)Math.Round(v)); return o; }
            case 'L': { var o = new byte[9]; o[0] = (byte)'L'; BinaryPrimitives.WriteInt64LittleEndian(o.AsSpan(1), (long)Math.Round(v)); return o; }
            default: { var o = new byte[9]; o[0] = (byte)'D'; BinaryPrimitives.WriteDoubleLittleEndian(o.AsSpan(1), v); return o; }
        }
    }

    // ------------------------------------------------------------------ read
    static Doc Parse(byte[] d)
    {
        uint version = BinaryPrimitives.ReadUInt32LittleEndian(d.AsSpan(23));
        var doc = new Doc { Header = d[..27], V64 = version >= 7500 };
        long pos = 27;
        doc.Nodes = ReadList(d, ref pos, doc.V64);
        doc.FooterStart = pos;
        doc.Footer = d[(int)pos..];
        return doc;
    }

    static List<Node> ReadList(byte[] d, ref long pos, bool v64)
    {
        var list = new List<Node>();
        for (var n = ReadNode(d, ref pos, v64); n != null; n = ReadNode(d, ref pos, v64)) list.Add(n);
        return list;
    }

    static Node? ReadNode(byte[] d, ref long pos, bool v64)
    {
        int hs = v64 ? 25 : 13;
        if (pos + hs > d.Length) throw new InvalidDataException("The FBX file ends too early.");
        var s = d.AsSpan((int)pos);
        long end = v64 ? (long)BinaryPrimitives.ReadUInt64LittleEndian(s) : BinaryPrimitives.ReadUInt32LittleEndian(s);
        long count = v64 ? (long)BinaryPrimitives.ReadUInt64LittleEndian(s[8..]) : BinaryPrimitives.ReadUInt32LittleEndian(s[4..]);
        long plen = v64 ? (long)BinaryPrimitives.ReadUInt64LittleEndian(s[16..]) : BinaryPrimitives.ReadUInt32LittleEndian(s[8..]);
        int nlen = s[hs - 1];
        if (end == 0) { pos += hs; return null; }   // null record: end of a list
        if (end > d.Length || end <= pos) throw new InvalidDataException("Broken node in the FBX file.");
        var n = new Node { Name = d.AsSpan((int)pos + hs, nlen).ToArray() };
        pos += hs + nlen;
        long propsStart = pos;
        for (long i = 0; i < count; i++)
        {
            int size = PropSize(d, (int)pos);
            n.Props.Add(d.AsSpan((int)pos, size).ToArray());
            pos += size;
        }
        if (pos - propsStart != plen) throw new InvalidDataException("Unexpected property list in the FBX file.");
        if (pos < end)
        {
            n.Nested = true;
            n.Children = ReadList(d, ref pos, v64);
        }
        if (pos != end) throw new InvalidDataException("Unexpected node layout in the FBX file.");
        return n;
    }

    static int PropSize(byte[] d, int p) => 1 + (char)d[p] switch
    {
        'Y' => 2,
        'C' => 1,
        'I' or 'F' => 4,
        'D' or 'L' => 8,
        'f' or 'd' or 'l' or 'i' or 'b' => 12 + (int)BinaryPrimitives.ReadUInt32LittleEndian(d.AsSpan(p + 9)),
        'S' or 'R' => 4 + (int)BinaryPrimitives.ReadUInt32LittleEndian(d.AsSpan(p + 1)),
        var t => throw new InvalidDataException($"Unknown property type '{t}' in the FBX file."),
    };

    // ------------------------------------------------------------------ write
    static byte[] Write(Doc doc)
    {
        using var ms = new MemoryStream();
        ms.Write(doc.Header);
        foreach (var n in doc.Nodes) WriteNode(ms, n, doc.V64);
        ms.Write(new byte[doc.V64 ? 25 : 13]);
        WriteFooter(ms, doc);
        return ms.ToArray();
    }

    static void WriteNode(MemoryStream ms, Node n, bool v64)
    {
        int hs = v64 ? 25 : 13;
        long start = ms.Position;
        ms.Write(new byte[hs - 1]);              // offsets, filled in below
        ms.WriteByte((byte)n.Name.Length);
        ms.Write(n.Name);
        long plen = 0;
        foreach (var p in n.Props) { ms.Write(p); plen += p.Length; }
        if (n.Nested)
        {
            foreach (var c in n.Children) WriteNode(ms, c, v64);
            ms.Write(new byte[hs]);
        }
        long end = ms.Position;
        Span<byte> h = stackalloc byte[24];
        if (v64)
        {
            BinaryPrimitives.WriteUInt64LittleEndian(h, (ulong)end);
            BinaryPrimitives.WriteUInt64LittleEndian(h[8..], (ulong)n.Props.Count);
            BinaryPrimitives.WriteUInt64LittleEndian(h[16..], (ulong)plen);
        }
        else
        {
            BinaryPrimitives.WriteUInt32LittleEndian(h, checked((uint)end));
            BinaryPrimitives.WriteUInt32LittleEndian(h[4..], (uint)n.Props.Count);
            BinaryPrimitives.WriteUInt32LittleEndian(h[8..], checked((uint)plen));
        }
        ms.Position = start;
        ms.Write(h[..(v64 ? 24 : 12)]);
        ms.Position = end;
    }

    /// <summary>
    /// Footer: a 16-byte id, 4 zero bytes, zero padding up to a 16-byte boundary (16 bytes when already on one),
    /// the version, 120 zero bytes and a 16-byte magic. Only the padding depends on where the footer starts.
    /// </summary>
    static void WriteFooter(MemoryStream ms, Doc doc)
    {
        var f = doc.Footer;
        const int tail = 4 + 120 + 16;
        if (f.Length < 20 + tail || !f.AsSpan(f.Length - 16).SequenceEqual(FootMagic)) { ms.Write(f); return; }
        static long Pad(long at) { long p = ((at + 15) & ~15L) - at; return p == 0 ? 16 : p; }
        long origPad = f.Length - 20 - tail;
        long newStart = ms.Position;
        ms.Write(f.AsSpan(0, 20));
        // the usual rule if the file follows it, otherwise keep the file's own alignment
        long pad = Pad(doc.FooterStart + 20) == origPad ? Pad(newStart + 20)
            : newStart == doc.FooterStart ? origPad
            : ((origPad + (doc.FooterStart - newStart)) % 16 + 16) % 16;
        ms.Write(new byte[pad]);
        ms.Write(f.AsSpan(f.Length - tail));
    }
}
