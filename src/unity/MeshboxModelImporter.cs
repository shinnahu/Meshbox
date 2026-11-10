// Meshbox - Unity import helper (Editor script, put it in any Editor folder).
//
// Only touches FBX files exported by Meshbox, i.e. FBX files with a sibling
// "<name>.materials.json" manifest. For those it:
//   * imports with Scale Factor 1 + Convert Units, and bakes the axis conversion (no -90° X)
//   * makes a Humanoid avatar when the manifest says the rig is humanoid
//   * builds URP Lit (or Built-in Standard) materials from the manifest: base color, normal,
//     metallic/smoothness, emission, alpha clip/blend, double sided
//   * marks normal maps as Normal Map textures and data maps (metallic, roughness, AO) as linear
// Textures with standard names (T_Hero_Body_Normal, T_Hero_Body_Roughness...) get the same
// treatment even without a manifest. Everything else in the project is left alone.
// Delete this file to stop it.
#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using UnityEditor;
using UnityEditor.AssetImporters;
using UnityEngine;
using UnityEngine.Rendering;

public class MeshboxModelImporter : AssetPostprocessor
{
    const int Version = 1;
    static readonly HashSet<string> reimported = new HashSet<string>();

    public override uint GetVersion() => Version;

    static string ManifestFor(string assetPath) => Path.ChangeExtension(assetPath, ".materials.json");

    static Dictionary<string, object> ReadManifest(string assetPath)
    {
        var path = ManifestFor(assetPath);
        if (!File.Exists(path)) return null;
        try { return MiniJson.Parse(File.ReadAllText(path)) as Dictionary<string, object>; }
        catch (Exception e) { Debug.LogWarning($"[Meshbox] Could not read {path}: {e.Message}"); return null; }
    }

    // ------------------------------------------------------------------ model settings
    void OnPreprocessModel()
    {
        if (!assetPath.EndsWith(".fbx", StringComparison.OrdinalIgnoreCase)) return;
        var manifest = ReadManifest(assetPath);
        if (manifest == null) return;
        var mi = (ModelImporter)assetImporter;
        mi.globalScale = 1f;
        mi.useFileScale = true;
#if UNITY_2020_1_OR_NEWER
        mi.bakeAxisConversion = true;
#endif
        mi.importCameras = false;
        mi.importLights = false;
        mi.importBlendShapes = true;
        mi.materialImportMode = ModelImporterMaterialImportMode.ImportViaMaterialDescription;
        mi.materialLocation = ModelImporterMaterialLocation.InPrefab;

        if (Get<bool>(manifest, "humanoid") && mi.animationType != ModelImporterAnimationType.Human)
        {
            mi.animationType = ModelImporterAnimationType.Human;
            mi.avatarSetup = ModelImporterAvatarSetup.CreateFromThisModel;
        }
        // Use the viewer's bone mapping once Unity has filled in the skeleton (second import onwards).
        if (mi.animationType == ModelImporterAnimationType.Human && manifest.TryGetValue("humanoidBones", out var hb) && hb is Dictionary<string, object> bones)
        {
            var hd = mi.humanDescription;
            if (hd.skeleton != null && hd.skeleton.Length > 0)
            {
                var names = new HashSet<string>(HumanTrait.BoneName);
                var list = new List<HumanBone>();
                foreach (var kv in bones)
                {
                    // Limb names match Mecanim's ("LeftUpperLeg"); fingers would need spaces and are not mapped here.
                    if (!(kv.Value is string boneName) || !names.Contains(kv.Key)) continue;
                    list.Add(new HumanBone { humanName = kv.Key, boneName = boneName, limit = new HumanLimit { useDefaultValues = true } });
                }
                if (list.Count >= 15) { hd.human = list.ToArray(); mi.humanDescription = hd; }
            }
        }
    }

    // ------------------------------------------------------------------ materials
    void OnPreprocessMaterialDescription(MaterialDescription description, Material material, AnimationClip[] clips)
    {
        if (!assetPath.EndsWith(".fbx", StringComparison.OrdinalIgnoreCase)) return;
        var manifest = ReadManifest(assetPath);
        if (manifest == null || !(manifest.TryGetValue("materials", out var mo) && mo is List<object> mats)) return;
        Dictionary<string, object> entry = null;
        foreach (var m in mats)
            if (m is Dictionary<string, object> d && string.Equals(Get<string>(d, "name"), description.materialName, StringComparison.Ordinal)) { entry = d; break; }
        if (entry == null) return;

        bool urp = GraphicsSettings.currentRenderPipeline != null && Shader.Find("Universal Render Pipeline/Lit") != null;
        var shader = urp ? Shader.Find("Universal Render Pipeline/Lit") : Shader.Find("Standard");
        if (shader == null) return;
        material.shader = shader;
        var folder = Path.GetDirectoryName(assetPath).Replace('\\', '/');
        bool missingTexture = false;

        Texture2D Tex(Dictionary<string, object> slot, string key = "texture")
        {
            var rel = slot != null ? Get<string>(slot, key) : null;
            if (string.IsNullOrEmpty(rel)) return null;
            var path = folder + "/" + rel.Replace('\\', '/');
            var t = AssetDatabase.LoadAssetAtPath<Texture2D>(path);
            if (t == null && File.Exists(path)) missingTexture = true; // not imported yet: import again afterwards
            return t;
        }

        // Base color
        var baseColor = Slot(entry, "baseColor");
        var color = ColorOf(baseColor, "factor", Color.white);
        var baseTex = Tex(baseColor);
        material.SetColor(urp ? "_BaseColor" : "_Color", color);
        if (baseTex) material.SetTexture(urp ? "_BaseMap" : "_MainTex", baseTex);

        // Normal
        var normal = Slot(entry, "normal");
        var nTex = Tex(normal);
        if (nTex)
        {
            material.SetTexture("_BumpMap", nTex);
            material.SetFloat("_BumpScale", (float)GetNum(normal, "strength", 1));
            material.EnableKeyword("_NORMALMAP");
        }

        // Metallic / smoothness (packed map from the viewer if present)
        var metallic = Slot(entry, "metallic");
        var roughness = Slot(entry, "roughness");
        material.SetFloat("_Metallic", (float)GetNum(metallic, "factor", 0));
        material.SetFloat(urp ? "_Smoothness" : "_Glossiness", 1f - (float)GetNum(roughness, "factor", 0.5));
        var packed = Tex(Slot(entry, "metallicSmoothness")) ?? Tex(entry, "metallicSmoothness");
        if (packed)
        {
            material.SetTexture("_MetallicGlossMap", packed);
            material.EnableKeyword(urp ? "_METALLICSPECGLOSSMAP" : "_METALLICGLOSSMAP");
            if (urp) material.SetFloat("_SmoothnessTextureChannel", 0);
        }

        // Emission
        var emission = Slot(entry, "emission");
        var eTex = Tex(emission);
        var eColor = ColorOf(emission, "color", Color.black) * (float)GetNum(emission, "strength", 1);
        if (eTex || eColor.maxColorComponent > 0.001f)
        {
            material.EnableKeyword("_EMISSION");
            material.SetColor("_EmissionColor", eTex && eColor.maxColorComponent < 0.001f ? Color.white : eColor);
            if (eTex) material.SetTexture("_EmissionMap", eTex);
            material.globalIlluminationFlags = MaterialGlobalIlluminationFlags.RealtimeEmissive;
        }

        // Alpha
        var alpha = Slot(entry, "alpha");
        var mode = alpha != null ? Get<string>(alpha, "mode") : "opaque";
        if (mode == "clip")
        {
            material.SetFloat("_Cutoff", (float)GetNum(alpha, "cutoff", 0.5));
            if (urp) { material.SetFloat("_AlphaClip", 1); material.EnableKeyword("_ALPHATEST_ON"); }
            else { material.SetFloat("_Mode", 1); material.EnableKeyword("_ALPHATEST_ON"); material.renderQueue = (int)RenderQueue.AlphaTest; }
        }
        else if (mode == "blend")
        {
            if (urp)
            {
                material.SetFloat("_Surface", 1);
                material.SetFloat("_Blend", 0);
                material.SetOverrideTag("RenderType", "Transparent");
                material.SetFloat("_SrcBlend", (float)BlendMode.SrcAlpha);
                material.SetFloat("_DstBlend", (float)BlendMode.OneMinusSrcAlpha);
                material.SetFloat("_ZWrite", 0);
                material.EnableKeyword("_SURFACE_TYPE_TRANSPARENT");
                material.renderQueue = (int)RenderQueue.Transparent;
            }
            else
            {
                material.SetFloat("_Mode", 3);
                material.SetOverrideTag("RenderType", "Transparent");
                material.SetFloat("_SrcBlend", (float)BlendMode.One);
                material.SetFloat("_DstBlend", (float)BlendMode.OneMinusSrcAlpha);
                material.SetFloat("_ZWrite", 0);
                material.EnableKeyword("_ALPHAPREMULTIPLY_ON");
                material.renderQueue = (int)RenderQueue.Transparent;
            }
        }
        if (urp && Get<bool>(entry, "doubleSided")) material.SetFloat("_Cull", 0);

        if (missingTexture && reimported.Add(assetPath))
        {
            var path = assetPath;
            EditorApplication.delayCall += () => AssetDatabase.ImportAsset(path, ImportAssetOptions.ForceUpdate);
        }
    }

    // ------------------------------------------------------------------ textures
    void OnPreprocessTexture()
    {
        var dir = Path.GetDirectoryName(assetPath);
        if (dir == null) return;
        var role = TextureRole(assetPath, dir) ?? TextureRole(assetPath, Path.GetDirectoryName(dir)) ?? RoleFromName(assetPath);
        if (role == null) return;
        var ti = (TextureImporter)assetImporter;
        if (role == "normal") ti.textureType = TextureImporterType.NormalMap;
        else if (role == "data") ti.sRGBTexture = false;
    }

    // Standard names (T_<Asset>_<Part>_<Map>, as Meshbox writes them): the last word is the map.
    static readonly System.Text.RegularExpressions.Regex NormalName =
        new System.Text.RegularExpressions.Regex(@"^T_.+_Normal$");
    static readonly System.Text.RegularExpressions.Regex DataName =
        new System.Text.RegularExpressions.Regex(@"^T_.+_(Roughness|Metallic|AO|Height|Mask|Opacity|Specular|Smoothness|MetallicSmoothness|MetallicRoughness|[ORMASHE]{2,4})$");

    static string RoleFromName(string texturePath)
    {
        var name = Path.GetFileNameWithoutExtension(texturePath);
        if (NormalName.IsMatch(name)) return "normal";
        if (DataName.IsMatch(name)) return "data";
        return null;
    }

    static string TextureRole(string texturePath, string folder)
    {
        if (string.IsNullOrEmpty(folder) || !Directory.Exists(folder)) return null;
        var full = Path.GetFullPath(texturePath).Replace('\\', '/');
        foreach (var file in Directory.GetFiles(folder, "*.materials.json"))
        {
            var manifest = MiniJson.Parse(File.ReadAllText(file)) as Dictionary<string, object>;
            if (manifest == null || !(manifest.TryGetValue("materials", out var mo) && mo is List<object> mats)) continue;
            var baseDir = Path.GetDirectoryName(file);
            foreach (var m in mats)
            {
                if (!(m is Dictionary<string, object> d)) continue;
                bool Is(string slot)
                {
                    var rel = Get<string>(Slot(d, slot), "texture") ?? (slot == "metallicSmoothness" ? Get<string>(d, slot) : null);
                    return rel != null && string.Equals(Path.GetFullPath(Path.Combine(baseDir, rel)).Replace('\\', '/'), full, StringComparison.OrdinalIgnoreCase);
                }
                if (Is("normal")) return "normal";
                if (Is("metallic") || Is("roughness") || Is("occlusion") || Is("metallicSmoothness")) return "data";
            }
        }
        return null;
    }

    // ------------------------------------------------------------------ helpers
    static Dictionary<string, object> Slot(Dictionary<string, object> d, string key) =>
        d != null && d.TryGetValue(key, out var v) ? v as Dictionary<string, object> : null;

    static T Get<T>(Dictionary<string, object> d, string key)
    {
        if (d == null || !d.TryGetValue(key, out var v) || v == null) return default;
        if (v is T t) return t;
        try { return (T)Convert.ChangeType(v, typeof(T), CultureInfo.InvariantCulture); } catch { return default; }
    }

    static double GetNum(Dictionary<string, object> d, string key, double fallback) =>
        d != null && d.TryGetValue(key, out var v) && v is double x ? x : fallback;

    static Color ColorOf(Dictionary<string, object> d, string key, Color fallback)
    {
        if (d == null || !d.TryGetValue(key, out var v) || !(v is List<object> l) || l.Count < 3) return fallback;
        float C(int i) => i < l.Count && l[i] is double x ? (float)x : 1f;
        // Blender stores linear values; Unity material colors are sRGB in the inspector.
        return new Color(C(0), C(1), C(2), l.Count > 3 ? C(3) : 1f).gamma;
    }

    /// <summary>Small JSON reader (objects, arrays, strings, numbers, booleans, null).</summary>
    static class MiniJson
    {
        public static object Parse(string json) { int i = 0; return Value(json, ref i); }

        static void Ws(string s, ref int i) { while (i < s.Length && char.IsWhiteSpace(s[i])) i++; }

        static object Value(string s, ref int i)
        {
            Ws(s, ref i);
            if (i >= s.Length) return null;
            char c = s[i];
            if (c == '{')
            {
                var d = new Dictionary<string, object>();
                i++; Ws(s, ref i);
                if (s[i] == '}') { i++; return d; }
                while (true)
                {
                    Ws(s, ref i);
                    var k = Str(s, ref i);
                    Ws(s, ref i); i++; // :
                    d[k] = Value(s, ref i);
                    Ws(s, ref i);
                    if (s[i] == ',') { i++; continue; }
                    i++; return d; // }
                }
            }
            if (c == '[')
            {
                var l = new List<object>();
                i++; Ws(s, ref i);
                if (s[i] == ']') { i++; return l; }
                while (true)
                {
                    l.Add(Value(s, ref i));
                    Ws(s, ref i);
                    if (s[i] == ',') { i++; continue; }
                    i++; return l; // ]
                }
            }
            if (c == '"') return Str(s, ref i);
            if (s.Substring(i).StartsWith("true")) { i += 4; return true; }
            if (s.Substring(i).StartsWith("false")) { i += 5; return false; }
            if (s.Substring(i).StartsWith("null")) { i += 4; return null; }
            int start = i;
            while (i < s.Length && "+-0123456789.eE".IndexOf(s[i]) >= 0) i++;
            return double.Parse(s.Substring(start, i - start), CultureInfo.InvariantCulture);
        }

        static string Str(string s, ref int i)
        {
            var sb = new StringBuilder();
            i++; // opening quote
            while (s[i] != '"')
            {
                if (s[i] == '\\')
                {
                    i++;
                    switch (s[i])
                    {
                        case 'n': sb.Append('\n'); break;
                        case 't': sb.Append('\t'); break;
                        case 'r': sb.Append('\r'); break;
                        case 'b': sb.Append('\b'); break;
                        case 'f': sb.Append('\f'); break;
                        case 'u': sb.Append((char)Convert.ToInt32(s.Substring(i + 1, 4), 16)); i += 4; break;
                        default: sb.Append(s[i]); break;
                    }
                }
                else sb.Append(s[i]);
                i++;
            }
            i++;
            return sb.ToString();
        }
    }
}
#endif
