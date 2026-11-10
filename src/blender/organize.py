"""
organize.py - turn a model into a clean, self-contained library folder.

    blender -b --factory-startup -noaudio [<input.blend>] --python-exit-code 3 --python organize.py -- args.json

args.json:
{
  "source": "<.blend/.fbx/.glb/.obj...>", "assetDir": "<dir>", "assetName": "Hero", "texturesDir": "Textures",
  "textureNames": "standard" | "original",   # standard: T_Hero_Body_BaseColor.png, T_Hero_Body_Normal.png
  "saveBlend": true,                          # FBX/glTF/OBJ sources: also save <Asset>.blend from the import
  "exportFbx": true,
  "dryRun": false,                            # only report what would happen to each texture; writes nothing
  "fbx": { ...same options as export_fbx.py minus source/out... }
}

Result: <assetDir>/<assetName>.blend (compressed, images relative to //Textures/), every used
image copied/unpacked into <assetDir>/<texturesDir>/, and optionally <assetDir>/<assetName>.fbx
whose textures point at the same folder.  The source file is never modified.
"""

import os
import re
import sys

sys.dont_write_bytecode = True
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import bpy  # noqa: E402
import meshbox_common as bb  # noqa: E402


def _safe_name(name):
    n = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", str(name)).strip(" .")
    if not n:
        raise bb.BBError("assetName is empty")
    return n


def main(args):
    asset_dir = args.get("assetDir")
    if not asset_dir:
        raise bb.BBError("Missing 'assetDir'")
    asset_dir = os.path.abspath(asset_dir)
    dry = bool(args.get("dryRun"))
    naming = str(args.get("textureNames") or "standard").lower()
    if naming not in ("standard", "original"):
        raise bb.BBError("textureNames must be standard or original")
    warnings = []
    bb.progress(0.02, "Loading")
    load = bb.load_source(args.get("source"), warnings)
    kind = load["kind"]
    src = os.path.abspath(load["path"])
    name = _safe_name(args.get("assetName") or bb.asset_from_filename(src))
    tex_rel = str(args.get("texturesDir") or "Textures").replace("\\", "/").strip("/")
    if not tex_rel or ".." in tex_rel.split("/") or ":" in tex_rel:
        raise bb.BBError("texturesDir must be a simple relative folder name")
    blend_out = os.path.join(asset_dir, name + ".blend")
    if bb.same_path(blend_out, src):
        raise bb.BBError("Refusing to overwrite the source file: choose another assetDir or assetName")
    save_blend = kind == "blend" or bool(args.get("saveBlend", True))
    if not dry:
        os.makedirs(asset_dir, exist_ok=True)
    tex_abs = os.path.join(asset_dir, *tex_rel.split("/"))
    allowed = [asset_dir]
    src_dir = os.path.dirname(src)

    # 1. every external path absolute (relative to the source location) -> saving elsewhere with
    #    relative_remap=False keeps libraries/caches valid; images are re-pointed below.
    bb.progress(0.06, "Resolving paths")
    if kind == "blend":
        try:
            bpy.ops.file.make_paths_absolute()
        except RuntimeError as e:
            warnings.append("make_paths_absolute: %s" % bb.ascii_safe(e, 200))

    # 2. copy / unpack every used image into <assetDir>/<Textures>, under its standard name
    mats = [m for m in bpy.data.materials if m.users > 0]
    imgs = [img for img in bpy.data.images
            if img.source != 'VIEWER' and img.users > 0
            and (img.packed_file is not None or img.source in ('FILE', 'TILED', 'SEQUENCE', 'MOVIE'))]
    # images only the World uses (HDRIs) are not model textures: they keep their names
    world_imgs = set()
    for w in bpy.data.worlds:
        if w.node_tree is not None:
            for n, _st in bb._walk_nodes(w.node_tree):
                if getattr(n, "image", None) is not None:
                    world_imgs.add(n.image.name)
    extra = [img for img in imgs if img.name not in world_imgs]
    plan = bb.texture_name_plan(mats, name, extra_images=extra) if naming == "standard" else {}
    stager = bb.TextureStager(tex_abs, allowed, search_roots=[src_dir, os.path.dirname(src_dir)],
                              save_generated=False, dry_run=dry)
    for img in imgs:
        p = bb.image_abs_path(img)
        if p and bb.is_under(p, tex_abs) and os.path.isfile(p):
            stager.reserve_existing(p)
    textures, unpacked, report = [], [], []
    for i, img in enumerate(imgs):
        if i % 3 == 0:
            bb.progress(0.08 + 0.40 * i / max(1, len(imgs)), "Textures: %s" % img.name)
        pl = plan.get(img.name) or {}
        dest = stager.stage(img, stem=pl.get("stem"))
        how = (stager.sources.get(img.name) or {}).get("how")
        entry = {"image": img.name, "map": pl.get("map"), "materials": pl.get("materials", []),
                 "standard": bool(pl), "packed": img.packed_file is not None,
                 "from": (stager.sources.get(img.name) or {}).get("from") or (None if img.packed_file is not None else bb.image_abs_path(img)),
                 "how": how, "to": None}
        report.append(entry)
        if dest is None:
            entry["how"] = "missing" if any(m["image"] == img.name for m in stager.missing) else "skipped"
            continue
        rel = os.path.relpath(dest, asset_dir).replace("\\", "/")
        entry["to"] = rel
        if dry:
            continue
        if img.packed_file is not None:
            bb.unpack_remove(img)
            unpacked.append(img.name)
        img.filepath = ("//" + rel) if save_blend else dest
        textures.append(rel)
    relinked = {f["image"]: f["from"] for f in stager.found}
    for e in report:
        if e["image"] in relinked and e["to"]:
            e["how"] = "relinked"
            e["from"] = relinked[e["image"]]
    for s in stager.skipped:
        warnings.append("%s: %s" % (s["image"], s["reason"]))
    for m in stager.missing:
        warnings.append("Missing texture: %s (%s)" % (m["image"], m["path"]))

    if dry:
        return {"dryRun": True, "kind": kind, "source": src, "assetName": name,
                "textureAsset": bb.texture_asset_name(name), "textures": report,
                "missing": stager.missing, "warnings": list(dict.fromkeys(warnings))}

    # 3. save the organised copy (the session now *is* that file; the source is untouched)
    result = {"blend": None, "fbx": None, "textures": sorted(set(textures)), "textureReport": report,
              "missing": stager.missing, "unpacked": unpacked, "relinked": stager.found, "kind": kind}
    if save_blend:
        bb.progress(0.50, "Saving %s.blend" % name)
        res, _ = bb.call_op(bpy.ops.wm.save_as_mainfile, filepath=blend_out, compress=True, copy=False,
                            relative_remap=False, check_existing=False)
        if 'FINISHED' not in res or not os.path.isfile(blend_out):
            raise bb.BBError("Saving %s failed" % blend_out)
        result["blend"] = blend_out
        result["blendSizeBytes"] = os.path.getsize(blend_out)

    # 4. Unity FBX next to it, re-using the same Textures folder (no second copy)
    if args.get("exportFbx", True):
        raw = dict(args.get("fbx") or {})
        raw["texturesDir"] = tex_rel
        raw.setdefault("textures", "folder")
        raw["textureNames"] = naming
        raw["assetName"] = name
        opts = bb.fbx_options(raw)
        fbx_out = os.path.join(asset_dir, name + ".fbx")
        if bb.same_path(fbx_out, src):
            raise bb.BBError("Refusing to overwrite the source file: choose another assetDir or assetName")
        fres = bb.export_unity_fbx(fbx_out, opts, warnings, bb.Progress(0.55, 0.99),
                                   allowed_roots=allowed, search_roots=[src_dir, os.path.dirname(src_dir)])
        result["fbx"] = fres["fbx"]
        for t in fres.get("textures", []):
            if t not in result["textures"]:
                result["textures"].append(t)
        result["fbxResult"] = {k: v for k, v in fres.items() if k not in ("warnings",)}
    result["source"] = src
    result["warnings"] = list(dict.fromkeys(warnings))
    return result


bb.run(main)
