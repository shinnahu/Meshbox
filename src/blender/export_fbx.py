"""
export_fbx.py - write a Unity-ready FBX (+ optional PBR material manifest).

    blender -b --factory-startup -noaudio [input.blend] --python-exit-code 3 --python export_fbx.py -- args.json

args.json:
{
  "source": "<.blend/.fbx/.glb/.gltf/.obj/...>", "out": "<path>.fbx",
  "targetSizeCm": null | number, "targetAxis": "height"|"width"|"depth"|"max",
  "textures": "folder"|"embed"|"none", "texturesDir": "Textures",
  "animations": "all"|"active"|"none", "applyModifiers": true, "onlyVisible": true,
  "pbrManifest": true, "packUnityMaskMaps": false,
  "rotationQuat": null | [w, x, y, z],      # Blender-space rotation baked in before measuring/export
  "deformBonesOnly": false                 # optional: only deforming bones (cleaner Unity humanoid rigs)
}

The source file is never saved; everything happens in this Blender session.
"""

import os
import sys

sys.dont_write_bytecode = True
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import bpy  # noqa: E402
import meshbox_common as bb  # noqa: E402


def main(args):
    out = args.get("out")
    if not out:
        raise bb.BBError("Missing 'out' (path of the .fbx to write)")
    out = os.path.abspath(out)
    if not out.lower().endswith(".fbx"):
        out += ".fbx"
    opts = bb.fbx_options(args)
    warnings = []
    bb.progress(0.02, "Loading")
    load = bb.load_source(args.get("source"), warnings, fbx_units="meters")
    src = load["path"]
    if bb.same_path(src, out):
        raise bb.BBError("The output would overwrite the source file")
    src_dir = os.path.dirname(os.path.abspath(src))
    res = bb.export_unity_fbx(out, opts, warnings, bb.Progress(0.08, 0.99),
                              allowed_roots=[os.path.dirname(out)],
                              search_roots=[src_dir, os.path.dirname(src_dir)])
    res["source"] = src
    res["sourceKind"] = load["kind"]
    if load.get("renamedActions"):
        res["renamedActions"] = load["renamedActions"]
    res["blenderVersion"] = bpy.app.version_string
    res["warnings"] = list(dict.fromkeys(warnings))
    return res


bb.run(main)
