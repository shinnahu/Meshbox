"""
meshbox_common.py - shared helpers for the Meshbox Blender scripts.

Runs inside Blender's bundled Python (3.6 .. 5.x).  Imported by preview.py, export_fbx.py and
organize.py, which add their own folder to sys.path first.

Protocol (stdout, one line each, flushed):
    @@PROGRESS <0..1> <ascii message>
    @@RESULT <single-line ASCII JSON>      (exactly once, last, on success)
    @@ERROR <ascii message>                (then exit code 3)

Safety rules implemented here:
  * The user's source file is never saved.  Nothing is written anywhere except below the output
    folder(s) handed in by the host (see _check_dest / TextureStager.allowed_roots).
  * Packed images are unpacked by writing their bytes ourselves; Image.unpack() is only ever
    called with method='REMOVE' (which writes nothing).
"""

import bpy
import sys
import os
import re
import json
import math
import time
import shutil
import struct
import zlib
import traceback
import unicodedata

try:
    import numpy as np
except Exception:  # pragma: no cover - numpy ships with Blender
    np = None

from mathutils import Matrix, Vector, Quaternion, Euler

BV = tuple(bpy.app.version)

# --------------------------------------------------------------------------------------------
# Protocol
# --------------------------------------------------------------------------------------------


class BBError(Exception):
    """An expected failure; the message is shown to the user as-is."""


def setup_stdio():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def ascii_safe(text, limit=500):
    s = " ".join(str(text).split())
    s = s.encode("ascii", "backslashreplace").decode("ascii")
    return s[:limit]


def progress(value, message=""):
    try:
        v = float(value)
    except Exception:
        v = 0.0
    if v != v:
        v = 0.0
    v = max(0.0, min(1.0, v))
    print("@@PROGRESS %.3f %s" % (v, ascii_safe(message, 200)), flush=True)


class Progress:
    """Maps a 0..1 sub-range of work onto a slice of the overall progress bar."""

    def __init__(self, start=0.0, end=1.0):
        self.start = float(start)
        self.end = float(end)

    def __call__(self, frac, message=""):
        progress(self.start + (self.end - self.start) * max(0.0, min(1.0, frac)), message)

    def sub(self, a, b):
        span = self.end - self.start
        return Progress(self.start + span * a, self.start + span * b)


def json_clean(o):
    """Make a value strictly JSON-safe (no NaN/inf, no Blender types)."""
    if o is None or isinstance(o, (bool, str)):
        return o
    if isinstance(o, int):
        return o
    if isinstance(o, float):
        if o != o or o in (float("inf"), float("-inf")):
            return None
        return round(o, 6)
    if isinstance(o, dict):
        return {str(k): json_clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple, set, frozenset)):
        return [json_clean(v) for v in o]
    if np is not None and isinstance(o, np.generic):
        return json_clean(o.item())
    if np is not None and isinstance(o, np.ndarray):
        return json_clean(o.tolist())
    if isinstance(o, (Vector, Quaternion, Euler)):
        return [json_clean(float(v)) for v in o]
    return str(o)


def emit_result(obj):
    line = json.dumps(json_clean(obj), ensure_ascii=True, separators=(",", ":"))
    print("@@RESULT " + line, flush=True)


def emit_error(message):
    print("@@ERROR " + ascii_safe(message, 2000), flush=True)


def read_args():
    argv = sys.argv
    rest = argv[argv.index("--") + 1:] if "--" in argv else []
    if not rest:
        return {}
    arg = rest[0]
    if arg.lstrip().startswith("{"):
        data = json.loads(arg)
    else:
        if not os.path.isfile(arg):
            raise BBError("Args file not found: %s" % arg)
        with open(arg, "r", encoding="utf-8-sig") as f:
            data = json.load(f)
    if not isinstance(data, dict):
        raise BBError("Args JSON must be an object")
    return data


def run(main):
    """Standard entry point: main(args) -> result dict (printed as @@RESULT)."""
    setup_stdio()
    t0 = time.time()
    try:
        args = read_args()
        res = main(args)
        if res is None:
            res = {}
        res["elapsedSec"] = round(time.time() - t0, 2)
        emit_result(res)
    except SystemExit:
        raise
    except BaseException as e:  # noqa: BLE001 - report everything to the host
        traceback.print_exc(file=sys.stderr)
        try:
            sys.stderr.flush()
        except Exception:
            pass
        if isinstance(e, BBError):
            emit_error(str(e))
        else:
            emit_error("%s: %s" % (type(e).__name__, e))
        sys.stdout.flush()
        sys.exit(3)


# --------------------------------------------------------------------------------------------
# Version-tolerant operator calls
# --------------------------------------------------------------------------------------------


def op_props(op):
    try:
        return set(op.get_rna_type().properties.keys())
    except Exception:
        return set()


def call_op(op, **kwargs):
    """Call an operator with only the keyword arguments this Blender version knows."""
    props = op_props(op)
    used = {k: v for k, v in kwargs.items() if k in props} if props else dict(kwargs)
    return op(**used), sorted(set(kwargs) - set(used))


def op_enum_items(op, prop):
    try:
        return [e.identifier for e in op.get_rna_type().properties[prop].enum_items]
    except Exception:
        return []


# --------------------------------------------------------------------------------------------
# Paths
# --------------------------------------------------------------------------------------------


def norm(p):
    return os.path.normcase(os.path.normpath(os.path.abspath(p)))


def same_path(a, b):
    try:
        return norm(a) == norm(b)
    except Exception:
        return False


def is_under(path, root):
    p, r = norm(path), norm(root)
    return p == r or p.startswith(r.rstrip("\\/") + os.sep)


def _check_dest(path, allowed_roots):
    for r in allowed_roots:
        if r and is_under(path, r):
            return
    raise BBError("Refusing to write outside the output folder: %s" % path)


def safe_write_bytes(path, data, allowed_roots):
    _check_dest(path, allowed_roots)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


def safe_copy(src, dst, allowed_roots):
    _check_dest(dst, allowed_roots)
    if same_path(src, dst):
        return
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    try:
        if os.path.isfile(dst):
            s1, s2 = os.stat(src), os.stat(dst)
            if s1.st_size == s2.st_size and int(s1.st_mtime) == int(s2.st_mtime):
                return  # identical copy from a previous run
    except OSError:
        pass
    shutil.copy2(src, dst)


def unit_to_meters():
    us = bpy.context.scene.unit_settings
    return float(us.scale_length) if us.system != 'NONE' else 1.0


# --------------------------------------------------------------------------------------------
# Loading sources
# --------------------------------------------------------------------------------------------

IMPORT_KINDS = {
    ".fbx": "fbx", ".glb": "gltf", ".gltf": "gltf", ".obj": "obj", ".stl": "stl", ".ply": "ply",
    ".usd": "usd", ".usda": "usd", ".usdc": "usd", ".usdz": "usd", ".dae": "dae", ".abc": "abc",
}


def is_blend_path(p):
    return bool(re.search(r"\.blend\d*$", p or "", re.I))


def clear_scene():
    """Remove all data from the factory scene so an imported file stands alone."""
    ids = []
    for name in ("objects", "meshes", "materials", "cameras", "lights", "armatures", "actions",
                 "curves", "images", "textures", "node_groups", "lattices", "metaballs",
                 "particles", "collections", "shape_keys"):
        coll = getattr(bpy.data, name, None)
        if coll is None or name == "shape_keys":
            continue
        for idb in coll:
            if name == "images" and idb.source == 'VIEWER':
                continue
            ids.append(idb)
    if ids:
        bpy.data.batch_remove(ids)


def load_source(source, warnings, fbx_units="meters"):
    """Make sure `source` is what the session contains.

    fbx_units: 'file'   -> FBX file units become the scene unit (roots keep scale 1; Unity export)
               'meters' -> Blender default import (roots get e.g. 0.01 scale; scene in meters)
    Returns {"kind": "blend"|"fbx"|"gltf"|..., "path": ...}
    """
    cur = bpy.data.filepath
    if not source:
        if cur:
            return {"kind": "blend", "path": cur}
        raise BBError("No source file was given")
    if not os.path.isfile(source):
        raise BBError("Source file not found: %s" % source)
    if is_blend_path(source):
        if not (cur and same_path(cur, source)):
            try:
                res, _ = call_op(bpy.ops.wm.open_mainfile, filepath=source, load_ui=False, use_scripts=False)
            except RuntimeError as e:
                raise BBError("Could not open %s: %s" % (source, e))
            if 'FINISHED' not in res:
                raise BBError("Could not open %s" % source)
        return {"kind": "blend", "path": source}
    ext = os.path.splitext(source)[1].lower()
    kind = IMPORT_KINDS.get(ext)
    if kind is None:
        raise BBError("Unsupported file type '%s'" % ext)
    clear_scene()
    import_model(source, kind, warnings, fbx_units)
    info = {"kind": kind, "path": source}
    if kind == "fbx":
        ren = clean_imported_action_names()
        if ren:
            info["renamedActions"] = ren
    return info


def _try_import(op_list, warnings, **kwargs):
    last = None
    for op in op_list:
        if op is None:
            continue
        try:
            res, _ = call_op(op, **kwargs)
            if 'FINISHED' in res:
                return True
        except RuntimeError as e:
            last = e
            warnings.append("Importer %s failed: %s" % (op.idname_py() if hasattr(op, "idname_py") else op, ascii_safe(e, 300)))
    if last:
        raise BBError("Import failed: %s" % ascii_safe(last, 500))
    return False


def _op(mod, name):
    m = getattr(bpy.ops, mod, None)
    return getattr(m, name, None) if m is not None and hasattr(m, name) else None


def import_model(path, kind, warnings, fbx_units="meters"):
    scene = bpy.context.scene
    if kind == "fbx":
        if fbx_units == "file":
            try:
                usf = fbx_read_info(path, details=False).get("unitScaleFactor")
            except Exception:
                usf = None
            if usf and usf > 0:
                scene.unit_settings.system = 'METRIC'
                scene.unit_settings.scale_length = float(usf) / 100.0
        ok = _try_import([_op("import_scene", "fbx"), _op("wm", "fbx_import")], warnings,
                         filepath=path, use_anim=True, use_image_search=True, use_custom_normals=True,
                         ignore_leaf_bones=False, automatic_bone_orientation=False)
    elif kind == "gltf":
        ok = _try_import([_op("import_scene", "gltf")], warnings, filepath=path)
    elif kind == "obj":
        ok = _try_import([_op("wm", "obj_import"), _op("import_scene", "obj")], warnings, filepath=path)
    elif kind == "stl":
        ok = _try_import([_op("wm", "stl_import"), _op("import_mesh", "stl")], warnings, filepath=path)
    elif kind == "ply":
        ok = _try_import([_op("wm", "ply_import"), _op("import_mesh", "ply")], warnings, filepath=path)
    elif kind == "usd":
        ok = _try_import([_op("wm", "usd_import")], warnings, filepath=path)
    elif kind == "dae":
        ok = _try_import([_op("wm", "collada_import")], warnings, filepath=path)
    elif kind == "abc":
        ok = _try_import([_op("wm", "alembic_import")], warnings, filepath=path)
    else:
        ok = False
    if not ok:
        raise BBError("No importer available for %s in Blender %s" % (kind, bpy.app.version_string))
    if len(scene.objects) == 0:
        raise BBError("The file imported but contains no objects: %s" % path)


# --------------------------------------------------------------------------------------------
# Object sets / visibility
# --------------------------------------------------------------------------------------------

GEOMETRY_TYPES = {'MESH', 'CURVE', 'SURFACE', 'FONT', 'META'}
EXPORT_TYPES = GEOMETRY_TYPES | {'ARMATURE', 'EMPTY'}


def _has_generative_modifier(o):
    return any(m.type not in ('ARMATURE',) and m.show_viewport for m in o.modifiers)


def has_geometry(o):
    if o.type == 'MESH':
        return len(o.data.polygons) > 0 or (_has_generative_modifier(o) and len(o.data.vertices) > 0
                                            and any(m.type == 'NODES' or m.type == 'SKIN' for m in o.modifiers))
    return o.type in GEOMETRY_TYPES


def object_depth(o):
    d = 0
    p = o.parent
    while p is not None and d < 1000:
        d += 1
        p = p.parent
    return d


def export_object_set(only_visible=True):
    """Visible (or all) exportable objects + the armatures that deform them + their parents."""
    vl = bpy.context.view_layer
    cand = [o for o in vl.objects if (o.visible_get() if only_visible else True)]
    chosen, seen = [], set()

    def add(o):
        if o is not None and o not in seen:
            seen.add(o)
            chosen.append(o)

    for o in cand:
        if o.type not in EXPORT_TYPES:
            continue
        if o.type == 'MESH' and not has_geometry(o):
            continue  # edge/vertex-only helpers such as rig widgets
        add(o)
    for o in list(chosen):
        for m in o.modifiers:
            if m.type == 'ARMATURE' and getattr(m, "object", None) is not None:
                add(m.object)
        if o.parent is not None and o.parent_type == 'ARMATURE':
            add(o.parent)
    for o in list(chosen):
        p = o.parent
        while p is not None:
            add(p)
            p = p.parent
    chosen.sort(key=lambda ob: (object_depth(ob), ob.name))
    return chosen


def make_exportable(objs):
    """Ensure every object is in the view layer, visible and selectable (session only)."""
    scene = bpy.context.scene
    vl = bpy.context.view_layer
    for o in objs:
        if vl.objects.get(o.name) is None:
            try:
                scene.collection.objects.link(o)
            except RuntimeError:
                pass
    vl.update()
    for o in objs:
        for attr in ("hide_viewport", "hide_select"):
            try:
                setattr(o, attr, False)
            except Exception:
                pass
        try:
            o.hide_set(False)
        except RuntimeError:
            pass
    vl.update()
    for o in objs:
        if not o.visible_get():
            try:
                if scene.collection.objects.get(o.name) is None:
                    scene.collection.objects.link(o)
                o.hide_set(False)
            except RuntimeError:
                pass
    vl.update()
    return [o.name for o in objs if not o.visible_get()]


def select_only(objs):
    vl = bpy.context.view_layer
    for o in vl.objects:
        try:
            o.select_set(False)
        except RuntimeError:
            pass
    for o in objs:
        try:
            o.select_set(True)
        except RuntimeError:
            pass
    if objs:
        try:
            vl.objects.active = objs[0]
        except Exception:
            pass


# --------------------------------------------------------------------------------------------
# Geometry statistics / measurement
# --------------------------------------------------------------------------------------------


def mesh_poly_stats(me):
    n = len(me.polygons)
    if n == 0:
        return {"faces": 0, "triangles": 0, "tris": 0, "quads": 0, "ngons": 0}
    if np is not None:
        lt = np.empty(n, dtype=np.int32)
        me.polygons.foreach_get("loop_total", lt)
        return {"faces": n, "triangles": int(np.maximum(lt - 2, 0).sum()), "tris": int((lt == 3).sum()),
                "quads": int((lt == 4).sum()), "ngons": int((lt > 4).sum())}
    tri = quads = ngons = t3 = 0
    for p in me.polygons:
        k = p.loop_total
        tri += max(k - 2, 0)
        t3 += k == 3
        quads += k == 4
        ngons += k > 4
    return {"faces": n, "triangles": tri, "tris": t3, "quads": quads, "ngons": ngons}


def measure_world_aabb(objs, rest_pose=True):
    """World AABB (Blender units, Z-up) of the evaluated geometry of `objs`.

    Armatures are temporarily switched to REST position so the measurement does not depend on the
    pose the file was saved in.  Returns (min, max, per_object_stats) with min/max None if empty.
    """
    changed = []
    if rest_pose:
        for a in bpy.data.armatures:
            if a.pose_position != 'REST':
                a.pose_position = 'REST'
                changed.append(a)
    mn = [math.inf] * 3
    mx = [-math.inf] * 3
    stats = {}
    try:
        dg = bpy.context.evaluated_depsgraph_get()
        dg.update()
        for o in objs:
            if o.type not in GEOMETRY_TYPES:
                continue
            ev = o.evaluated_get(dg)
            try:
                me = ev.to_mesh()
            except RuntimeError:
                continue
            if me is None:
                continue
            try:
                n = len(me.vertices)
                stats[o.name] = dict(vertices=n, **mesh_poly_stats(me))
                if n == 0:
                    continue
                M = ev.matrix_world
                if np is not None:
                    co = np.empty(n * 3, dtype=np.float32)
                    me.vertices.foreach_get("co", co)
                    co = co.reshape(-1, 3).astype(np.float64)
                    m = np.array(M, dtype=np.float64)
                    w = co @ m[:3, :3].T + m[:3, 3]
                    lo, hi = w.min(axis=0), w.max(axis=0)
                    for i in range(3):
                        mn[i] = min(mn[i], float(lo[i]))
                        mx[i] = max(mx[i], float(hi[i]))
                else:
                    for v in me.vertices:
                        p = M @ v.co
                        for i in range(3):
                            mn[i] = min(mn[i], p[i])
                            mx[i] = max(mx[i], p[i])
            finally:
                ev.to_mesh_clear()
    finally:
        for a in changed:
            a.pose_position = 'POSE'
        if changed:
            bpy.context.view_layer.update()
    if mn[0] == math.inf:
        return None, None, stats
    return mn, mx, stats


def measure_bones_aabb(objs):
    """World AABB of armature bones (rest heads/tails) - used when there is no geometry (animation-only files)."""
    mn = [math.inf] * 3
    mx = [-math.inf] * 3
    for o in objs:
        if o.type != 'ARMATURE':
            continue
        M = o.matrix_world
        for b in o.data.bones:
            for p in (M @ b.head_local, M @ b.tail_local):
                for i in range(3):
                    mn[i] = min(mn[i], p[i])
                    mx[i] = max(mx[i], p[i])
    if mn[0] == math.inf:
        return None, None
    return mn, mx


def clean_imported_action_names():
    """FBX import names actions '<object>|<take>|<layer>'; strip object-name prefixes and default layer names."""
    obj_names = set(o.name for o in bpy.data.objects)
    renamed = {}
    acts = sorted(bpy.data.actions, key=lambda a: (a.name.startswith("Key|"), a.name))
    taken = set(a.name for a in bpy.data.actions)
    for a in acts:
        parts = a.name.split("|")
        while len(parts) > 1 and (parts[0] in obj_names or parts[0] == "Key"):
            parts = parts[1:]
        if len(parts) > 1 and parts[-1] in ("BaseLayer", "Base Layer", "Layer0", "AnimLayer1"):
            parts = parts[:-1]
        new = "|".join(parts)
        if new and new != a.name and new not in taken:
            taken.discard(a.name)
            renamed[a.name] = new
            a.name = new
            taken.add(new)
    return renamed


def yup_size(mn, mx, unit=1.0):
    """Blender (x,y,z) -> viewer/Unity Y-up (x, z, -y): width, height, depth."""
    if mn is None:
        return {"x": 0.0, "y": 0.0, "z": 0.0}
    return {"x": (mx[0] - mn[0]) * unit, "y": (mx[2] - mn[2]) * unit, "z": (mx[1] - mn[1]) * unit}


def yup_aabb(mn, mx, unit=1.0):
    if mn is None:
        return None
    return {"min": {"x": mn[0] * unit, "y": mn[2] * unit, "z": -mx[1] * unit},
            "max": {"x": mx[0] * unit, "y": mx[2] * unit, "z": -mn[1] * unit}}


def yup_pivot_offset(mn, mx, unit=1.0):
    """Vector from world origin to the bottom-centre of the AABB (Y-up convention)."""
    if mn is None:
        return {"x": 0.0, "y": 0.0, "z": 0.0}
    cx, cy = (mn[0] + mx[0]) * 0.5, (mn[1] + mx[1]) * 0.5
    return {"x": cx * unit, "y": mn[2] * unit, "z": -cy * unit}


def yup_vec(v):
    return {"x": v[0], "y": v[2], "z": -v[1]}


# --------------------------------------------------------------------------------------------
# Animation helpers (legacy fcurves and 4.4+ slotted/layered actions)
# --------------------------------------------------------------------------------------------


def action_channelbags(action):
    """Yield (owner, slot) where owner.fcurves is a collection: channelbags on 4.4+, the action itself before."""
    layers = getattr(action, "layers", None)
    if layers is not None and len(layers):
        for layer in layers:
            for strip in layer.strips:
                for cb in getattr(strip, "channelbags", ()):
                    yield cb, cb.slot
        return
    if hasattr(action, "fcurves"):
        yield action, None


def action_fcurves(action):
    out = []
    for owner, _slot in action_channelbags(action):
        out.extend(owner.fcurves)
    return out


def action_info(action, fps):
    fr = action.frame_range
    d = {"name": action.name, "frameStart": float(fr[0]), "frameEnd": float(fr[1]), "fps": fps,
         "users": action.users, "fakeUser": bool(action.use_fake_user),
         "fcurves": len(action_fcurves(action))}
    slots = getattr(action, "slots", None)
    if slots is not None:
        d["slots"] = [{"name": s.identifier, "idType": getattr(s, "target_id_type", None)} for s in slots]
    else:
        d["idRoot"] = getattr(action, "id_root", None)
    return d


def scene_fps():
    r = bpy.context.scene.render
    return float(r.fps) / float(r.fps_base or 1.0)


# --------------------------------------------------------------------------------------------
# Modifiers -> mesh data, keeping Armature modifiers and shape keys
# --------------------------------------------------------------------------------------------


def _key_settings(key):
    info = []
    for kb in key.key_blocks:
        info.append({"name": kb.name, "value": kb.value, "min": kb.slider_min, "max": kb.slider_max,
                     "mute": kb.mute, "interpolation": kb.interpolation,
                     "relative": kb.relative_key.name if kb.relative_key else None})
    return info


def _copy_anim_data(src_id, dst_id):
    """Copy action/slot, drivers and NLA tracks from one ID to another (used for Key datablocks)."""
    sad = getattr(src_id, "animation_data", None)
    if sad is None:
        return
    dad = dst_id.animation_data_create()
    try:
        if sad.action is not None:
            dad.action = sad.action
            if hasattr(sad, "action_slot") and sad.action_slot is not None:
                try:
                    dad.action_slot = sad.action_slot
                except Exception:
                    pass
    except Exception:
        pass
    for fc in sad.drivers:
        try:
            nfc = dad.drivers.from_existing(src_driver=fc)
            for var in nfc.driver.variables:
                for t in var.targets:
                    if getattr(t, "id", None) == src_id:
                        t.id = dst_id
        except Exception:
            pass
    for tr in sad.nla_tracks:
        try:
            nt = dad.nla_tracks.new()
            nt.name, nt.mute = tr.name, tr.mute
            for st in tr.strips:
                if st.action is None:
                    continue
                ns = nt.strips.new(st.name, int(st.frame_start), st.action)
                for attr in ("action_frame_start", "action_frame_end", "scale", "repeat", "blend_type",
                             "extrapolation", "mute", "influence", "use_auto_blend"):
                    try:
                        setattr(ns, attr, getattr(st, attr))
                    except Exception:
                        pass
                if hasattr(st, "action_slot") and st.action_slot is not None:
                    try:
                        ns.action_slot = st.action_slot
                    except Exception:
                        pass
        except Exception:
            pass


def _eval_coords(o, dg):
    dg.update()
    ev = o.evaluated_get(dg)
    me = ev.to_mesh()
    try:
        n = len(me.vertices)
        co = np.empty(n * 3, dtype=np.float32)
        me.vertices.foreach_get("co", co)
        return co
    finally:
        ev.to_mesh_clear()


def bake_modifiers(objs, warnings, prog=None):
    """Apply every non-Armature modifier of the given meshes (viewport settings, rest pose).

    Armature modifiers stay live (exporters turn them into skinning).  Shape keys survive: each key
    is evaluated through the modifier stack on its own and re-added when the vertex count matches.
    Returns a list of per-object reports.
    """
    targets = [o for o in objs if o.type == 'MESH' and any(m.type != 'ARMATURE' for m in o.modifiers)]
    reports = []
    if not targets:
        return reports
    dg = bpy.context.evaluated_depsgraph_get()
    for idx, o in enumerate(targets):
        if prog:
            prog(idx / max(1, len(targets)), "Applying modifiers: %s" % o.name)
        nonarm = [m for m in o.modifiers if m.type != 'ARMATURE']
        active = [m for m in nonarm if m.show_viewport]
        rep = {"object": o.name, "applied": [m.type for m in active], "removedDisabled": [m.type for m in nonarm if not m.show_viewport]}
        if not active:
            for m in nonarm:
                o.modifiers.remove(m)
            reports.append(rep)
            continue
        arm_mods = [m for m in o.modifiers if m.type == 'ARMATURE']
        saved_vis = [(m, m.show_viewport) for m in arm_mods]
        for m in arm_mods:
            m.show_viewport = False
        old = o.data
        key = old.shape_keys
        key_info = _key_settings(key) if key else None
        shapes, dropped = [], []
        saved = (o.show_only_shape_key, o.active_shape_key_index)
        mutes = [kb.mute for kb in key.key_blocks] if key else []
        try:
            if key and len(key.key_blocks) > 0:
                kbs = key.key_blocks
                ref_name = key.reference_key.name if key.reference_key else kbs[0].name
                ref_index = max(0, kbs.find(ref_name))
                o.show_only_shape_key = True
                for kb in kbs:
                    kb.mute = False
                o.active_shape_key_index = ref_index
                dg.update()
                new_me = bpy.data.meshes.new_from_object(o.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
                n = len(new_me.vertices)
                for i, kb in enumerate(kbs):
                    if i == ref_index:
                        continue
                    o.active_shape_key_index = i
                    co = _eval_coords(o, dg)
                    if len(co) == n * 3:
                        shapes.append((i, co))
                    else:
                        dropped.append(kb.name)
            else:
                dg.update()
                new_me = bpy.data.meshes.new_from_object(o.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
        finally:
            for m, v in saved_vis:
                m.show_viewport = v
            if key:
                for kb, mu in zip(key.key_blocks, mutes):
                    kb.mute = mu
                o.show_only_shape_key, o.active_shape_key_index = saved
        # swap the mesh in (vertex-group names live on the mesh in 3.0+, copy defensively)
        vg_names = [vg.name for vg in o.vertex_groups]
        old_name = old.name
        old.name = old_name + "_bbsrc"
        new_me.name = old_name
        o.data = new_me
        if vg_names and len(o.vertex_groups) == 0:
            for nm in vg_names:
                o.vertex_groups.new(name=nm)
        for m in nonarm:
            o.modifiers.remove(m)
        if key_info:
            basis_info = key_info[ref_index]
            basis = o.shape_key_add(name=basis_info["name"], from_mix=False)
            new_key = o.data.shape_keys
            for i, co in shapes:
                ki = key_info[i]
                kb = o.shape_key_add(name=ki["name"], from_mix=False)
                kb.data.foreach_set("co", co)
                try:
                    kb.slider_min, kb.slider_max = ki["min"], ki["max"]
                    kb.value = ki["value"]
                    kb.mute = ki["mute"]
                    kb.interpolation = ki["interpolation"]
                except Exception:
                    pass
            for i, _co in shapes:
                rel = key_info[i]["relative"]
                kb = new_key.key_blocks.get(key_info[i]["name"])
                if kb is not None and rel and new_key.key_blocks.get(rel) is not None:
                    kb.relative_key = new_key.key_blocks[rel]
            try:
                new_key.use_relative = key.use_relative
            except Exception:
                pass
            _copy_anim_data(key, new_key)
            rep["shapeKeysKept"] = len(shapes)
            if dropped:
                rep["shapeKeysDropped"] = dropped
                warnings.append("%s: %d shape key(s) dropped because the modifier stack changes their "
                                "vertex count: %s" % (o.name, len(dropped), ", ".join(dropped[:10])))
        if old.users == 0:
            try:
                bpy.data.meshes.remove(old)
            except Exception:
                pass
        reports.append(rep)
    return reports


# --------------------------------------------------------------------------------------------
# Materials: node graph analysis, PBR extraction, conversion for exporters
# --------------------------------------------------------------------------------------------

PRINCIPLED_INPUTS = {
    "baseColor": ("Base Color",),
    "metallic": ("Metallic",),
    "roughness": ("Roughness",),
    "normal": ("Normal",),
    "emission": ("Emission Color", "Emission"),
    "emissionStrength": ("Emission Strength",),
    "alpha": ("Alpha",),
    "specular": ("Specular IOR Level", "Specular"),
}
SHADER_COLOR_NODES = {'ShaderNodeBsdfDiffuse', 'ShaderNodeEmission', 'ShaderNodeBsdfToon',
                      'ShaderNodeBackground', 'ShaderNodeBsdfGlossy', 'ShaderNodeBsdfAnisotropic',
                      'ShaderNodeSubsurfaceScattering', 'ShaderNodeBsdfSheen', 'ShaderNodeBsdfTranslucent'}
SEPARATE_NODES = {'ShaderNodeSeparateRGB', 'ShaderNodeSeparateColor', 'ShaderNodeSeparateXYZ'}
CHANNEL_NAMES = {'R': 'R', 'G': 'G', 'B': 'B', 'Red': 'R', 'Green': 'G', 'Blue': 'B', 'X': 'R', 'Y': 'G', 'Z': 'B'}
DATA_INPUT_NAMES = {"Normal", "Vector", "Tangent", "Displacement", "Height", "Roughness", "Metallic",
                    "Specular", "Specular IOR Level", "Coat Normal", "Clearcoat Normal", "Anisotropic",
                    "Anisotropic Rotation", "IOR", "Weight"}


def material_tree(mat):
    if mat is None:
        return None
    nt = getattr(mat, "node_tree", None)
    if nt is None:
        return None
    if BV < (5, 0, 0) and not mat.use_nodes:
        return None
    return nt


def active_output(nt):
    outs = [n for n in nt.nodes if n.bl_idname == 'ShaderNodeOutputMaterial']
    if not outs:
        return None
    for n in outs:
        if getattr(n, "is_active_output", False) and getattr(n, "target", 'ALL') in ('ALL', 'EEVEE'):
            return n
    for n in outs:
        if getattr(n, "is_active_output", False):
            return n
    return outs[0]


def group_output(nt):
    outs = [n for n in nt.nodes if n.bl_idname == 'NodeGroupOutput']
    for n in outs:
        if getattr(n, "is_active_output", False):
            return n
    return outs[0] if outs else None


def _sock_by_id(sockets, identifier):
    for s in sockets:
        if s.identifier == identifier:
            return s
    return None


def linked_from(sock):
    """(node, socket) feeding an input socket, skipping reroutes and muted links."""
    if sock is None or not sock.is_linked:
        return None, None
    for link in sock.links:
        if getattr(link, "is_muted", False) or not getattr(link, "is_valid", True):
            continue
        n, s = link.from_node, link.from_socket
        guard = 0
        while n.bl_idname == 'NodeReroute' and guard < 64:
            guard += 1
            inp = n.inputs[0]
            if not inp.is_linked:
                return None, None
            l2 = inp.links[0]
            n, s = l2.from_node, l2.from_socket
        return n, s
    return None, None


def find_input(node, *names):
    for nm in names:
        s = node.inputs.get(nm)
        if s is not None:
            return s
    return None


def trace_image(sock, stack=(), channel=None, depth=0, via=None):
    """Follow links upstream from an input socket to the first Image Texture.

    Returns dict(image, node, output, channel, stack, via) or None.  `channel` is R/G/B/A when a
    Separate RGB/Color/XYZ node or the image's Alpha output is used.  Crosses node-group borders.
    """
    if depth > 64 or sock is None:
        return None
    via = list(via or [])
    n, s = linked_from(sock)
    if n is None:
        return None
    t = n.bl_idname
    if n.mute and t != 'ShaderNodeTexImage':
        return None
    if t == 'ShaderNodeTexImage':
        if n.image is None:
            return None
        ch = 'A' if s.name == 'Alpha' else channel
        return {"image": n.image, "node": n, "output": s.name, "channel": ch, "stack": stack, "via": via}
    if t == 'NodeGroupInput':
        if not stack:
            return None
        outer = _sock_by_id(stack[-1].inputs, s.identifier)
        return trace_image(outer, stack[:-1], channel, depth + 1, via)
    if t == 'ShaderNodeGroup':
        if n.node_tree is None:
            return None
        go = group_output(n.node_tree)
        inner = _sock_by_id(go.inputs, s.identifier) if go else None
        return trace_image(inner, stack + (n,), channel, depth + 1, via + ["Group"])
    if t in SEPARATE_NODES:
        ch = CHANNEL_NAMES.get(s.name, channel)
        return trace_image(n.inputs[0], stack, ch, depth + 1, via + [t])
    if t == 'ShaderNodeNormalMap':
        return trace_image(n.inputs.get("Color"), stack, channel, depth + 1, via + [t])
    if t in ('ShaderNodeBump', 'ShaderNodeDisplacement'):
        return trace_image(n.inputs.get("Height"), stack, channel, depth + 1, via + [t])
    inputs = [i for i in n.inputs if i.is_linked and i.type in ('RGBA', 'VALUE')]
    inputs.sort(key=lambda i: 1 if i.name in ("Fac", "Factor") else 0)
    for i in inputs:
        r = trace_image(i, stack, channel, depth + 1, via + [t])
        if r:
            return r
    return None


def upstream_images(sock, stack=(), depth=0, out=None, seen=None, skip_data=True):
    """All image-texture nodes reachable upstream of a socket, in depth-first order."""
    if out is None:
        out, seen = [], set()
    if depth > 64 or sock is None or not sock.is_linked:
        return out
    n, s = linked_from(sock)
    if n is None:
        return out
    key = (n.as_pointer(), s.identifier, tuple(g.as_pointer() for g in stack))
    if key in seen:
        return out
    seen.add(key)
    t = n.bl_idname
    if t == 'ShaderNodeTexImage':
        if n.image is not None:
            out.append({"image": n.image, "node": n, "output": s.name, "stack": stack})
        return out
    if t == 'NodeGroupInput':
        if stack:
            upstream_images(_sock_by_id(stack[-1].inputs, s.identifier), stack[:-1], depth + 1, out, seen, skip_data)
        return out
    if t == 'ShaderNodeGroup':
        if n.node_tree is not None:
            go = group_output(n.node_tree)
            if go is not None:
                upstream_images(_sock_by_id(go.inputs, s.identifier), stack + (n,), depth + 1, out, seen, skip_data)
        return out
    for i in n.inputs:
        if not i.is_linked:
            continue
        if skip_data and (i.name in DATA_INPUT_NAMES or i.type == 'VECTOR'):
            continue
        upstream_images(i, stack, depth + 1, out, seen, skip_data)
    return out


def find_principled(sock, stack=(), depth=0):
    """First Principled BSDF upstream of a shader socket (through mix/add shaders and groups)."""
    if depth > 32 or sock is None:
        return None, ()
    n, s = linked_from(sock)
    if n is None:
        return None, ()
    t = n.bl_idname
    if t == 'ShaderNodeBsdfPrincipled':
        return n, stack
    if t == 'ShaderNodeGroup' and n.node_tree is not None:
        go = group_output(n.node_tree)
        if go is not None:
            r = find_principled(_sock_by_id(go.inputs, s.identifier), stack + (n,), depth + 1)
            if r[0] is not None:
                return r
        return None, ()
    if t == 'NodeGroupInput' and stack:
        return find_principled(_sock_by_id(stack[-1].inputs, s.identifier), stack[:-1], depth + 1)
    for i in n.inputs:
        if i.type == 'SHADER' and i.is_linked:
            r = find_principled(i, stack, depth + 1)
            if r[0] is not None:
                return r
    return None, ()


def _walk_nodes(nt, stack=(), depth=0, out=None):
    """(node, stack) for every node of a tree, descending into node groups."""
    if out is None:
        out = []
    if depth > 16 or nt is None:
        return out
    for n in nt.nodes:
        out.append((n, stack))
        if n.bl_idname == 'ShaderNodeGroup' and n.node_tree is not None:
            _walk_nodes(n.node_tree, stack + (n,), depth + 1, out)
    return out


def _color4(v):
    try:
        c = list(v)
    except TypeError:
        c = [float(v)] * 3
    while len(c) < 4:
        c.append(1.0)
    return [float(x) for x in c[:4]]


def _float(v):
    try:
        return float(v)
    except Exception:
        try:
            return float(v[0])
        except Exception:
            return None


ROLE_PATTERNS = [
    ("normal", re.compile(r"(normal|nrm|nor$|_n$|_n_|norm\b)", re.I)),
    ("roughness", re.compile(r"(rough|rgh|_r$)", re.I)),
    ("metallic", re.compile(r"(metal|_m$|mtl)", re.I)),
    ("emission", re.compile(r"(emiss|emit|glow|_e$)", re.I)),
    ("alpha", re.compile(r"(alpha|opacity|transparen|_a$)", re.I)),
    ("occlusion", re.compile(r"(\bao\b|_ao|occlusion)", re.I)),
    ("baseColor", re.compile(r"(albedo|base.?colou?r|basecolor|diffuse|diff|_d$|_col$|colou?r|_bc$|_base)", re.I)),
]
NOT_BASE = re.compile(r"(normal|nrm|_n$|rough|metal|spec|gloss|\bao\b|_ao|occlu|mask|matcap|sphere|toon|shadow|shade|"
                      r"_ss$|_ss_|sss|emiss|height|disp|bump|opacity|ramp|lut|outline|rim|hylyt|highlight|_orm|_mra)", re.I)
LIKELY_BASE = re.compile(r"(albedo|base|diffuse|diff|_d$|_col|colou?r|main|_bc$)", re.I)


def image_stem(img):
    p = img.filepath or ""
    stem = os.path.splitext(os.path.basename(p.replace("\\", "/")))[0] if p else ""
    return stem or os.path.splitext(img.name)[0]


def guess_role_by_name(img):
    stem = image_stem(img)
    for role, rx in ROLE_PATTERNS:
        if rx.search(stem):
            return role
    return None


def _alpha_mode(mat, alpha_linked, alpha_value, clip_hint=False):
    rm = getattr(mat, "surface_render_method", None)
    bm = getattr(mat, "blend_method", None)
    if not alpha_linked and (alpha_value is None or alpha_value >= 0.999):
        return "opaque"
    if clip_hint:
        return "clip"
    if rm is not None:
        return "blend" if rm == 'BLENDED' else "clip"
    if bm == 'BLEND':
        return "blend"
    if bm in ('CLIP', 'HASHED'):
        return "clip"
    if bm == 'OPAQUE':
        return "opaque"
    return "blend"


def _tex_entry(tr):
    if not tr:
        return None
    return {"image": tr["image"].name, "channel": tr.get("channel"), "output": tr.get("output")}


def _clip_detected(sock):
    n, _s = linked_from(sock)
    if n is not None and n.bl_idname == 'ShaderNodeMath' and n.operation in ('ROUND', 'GREATER_THAN', 'LESS_THAN', 'SUBTRACT'):
        return True
    return False


def analyze_material(mat):
    """PBR description of a material (names of images, not paths)."""
    d = {"name": mat.name, "usesPrincipled": False, "texturedInputs": [], "converted": False,
         "doubleSided": not bool(getattr(mat, "use_backface_culling", False))}
    nt = material_tree(mat)
    base_factor = _color4(getattr(mat, "diffuse_color", (0.8, 0.8, 0.8, 1.0)))
    d["baseColor"] = {"factor": base_factor, "texture": None}
    d["metallic"] = {"factor": float(getattr(mat, "metallic", 0.0)), "texture": None}
    d["roughness"] = {"factor": float(getattr(mat, "roughness", 0.5)), "texture": None}
    d["normal"] = None
    d["emission"] = {"color": [0.0, 0.0, 0.0], "strength": 0.0, "texture": None}
    d["alpha"] = {"mode": "opaque", "factor": 1.0, "texture": None}
    d["occlusion"] = None
    if nt is None:
        return d
    out = active_output(nt)
    surf = out.inputs.get("Surface") if out else None
    bsdf, stack = find_principled(surf)
    if bsdf is None:
        d["shader"] = "custom"
        cands = upstream_images(surf) if surf else []
        best = pick_base_image(cands)
        if best:
            d["baseColor"]["texture"] = {"image": best["image"].name, "channel": None, "output": "Color"}
            d["texturedInputs"].append("baseColor")
            alpha_used = best["node"].outputs["Alpha"].is_linked
            if alpha_used:
                d["alpha"] = {"mode": _alpha_mode(mat, True, 1.0), "factor": 1.0,
                              "texture": {"image": best["image"].name, "channel": "A", "output": "Alpha"}}
                d["texturedInputs"].append("alpha")
        return d
    d["usesPrincipled"] = True
    d["shader"] = "principled"

    def inp(role):
        return find_input(bsdf, *PRINCIPLED_INPUTS[role])

    s = inp("baseColor")
    if s is not None:
        d["baseColor"]["factor"] = _color4(s.default_value)
        tr = trace_image(s, stack)
        d["baseColor"]["texture"] = _tex_entry(tr)
    for role in ("metallic", "roughness"):
        s = inp(role)
        if s is not None:
            d[role]["factor"] = _float(s.default_value)
            tr = trace_image(s, stack)
            d[role]["texture"] = _tex_entry(tr)
    s = inp("normal")
    if s is not None and s.is_linked:
        n, _ = linked_from(s)
        strength = 1.0
        if n is not None and n.bl_idname == 'ShaderNodeNormalMap':
            st = n.inputs.get("Strength")
            strength = _float(st.default_value) if st is not None else 1.0
        elif n is not None and n.bl_idname == 'ShaderNodeBump':
            st = n.inputs.get("Strength")
            strength = _float(st.default_value) if st is not None else 1.0
        tr = trace_image(s, stack)
        d["normal"] = {"texture": _tex_entry(tr), "strength": strength,
                       "kind": "bump" if (n is not None and n.bl_idname == 'ShaderNodeBump') else "normalMap"}
    s = inp("emission")
    if s is not None:
        d["emission"]["color"] = _color4(s.default_value)[:3]
        d["emission"]["texture"] = _tex_entry(trace_image(s, stack))
    s = inp("emissionStrength")
    if s is not None:
        d["emission"]["strength"] = _float(s.default_value)
    elif BV < (4, 0, 0):
        d["emission"]["strength"] = 1.0
    s = inp("alpha")
    if s is not None:
        tr = trace_image(s, stack)
        a = _float(s.default_value)
        clip = _clip_detected(s)
        d["alpha"] = {"mode": _alpha_mode(mat, s.is_linked, a, clip), "factor": a, "texture": _tex_entry(tr)}
        if d["alpha"]["mode"] == "clip":
            d["alpha"]["cutoff"] = float(getattr(mat, "alpha_threshold", 0.5)) if not clip else 0.5
    # occlusion: glTF Settings / glTF Material Output group input
    for n, st in _walk_nodes(nt):
        if n.bl_idname == 'ShaderNodeGroup' and n.node_tree is not None and "gltf" in n.node_tree.name.lower():
            occ = n.inputs.get("Occlusion")
            if occ is not None and occ.is_linked:
                d["occlusion"] = {"texture": _tex_entry(trace_image(occ, st))}
                break
    for role in ("baseColor", "metallic", "roughness", "emission", "alpha"):
        if d.get(role) and d[role].get("texture"):
            d["texturedInputs"].append(role)
    if d["normal"] and d["normal"].get("texture"):
        d["texturedInputs"].append("normal")
    if d["occlusion"] and d["occlusion"].get("texture"):
        d["texturedInputs"].append("occlusion")
    return d


def pick_base_image(cands):
    """Choose the most likely base-colour texture among upstream image nodes."""
    best, best_score = None, None
    for idx, c in enumerate(cands):
        img = c["image"]
        names = (image_stem(img), re.sub(r"(\.\w{2,4})?(\.\d{3})?$", "", img.name))
        sc = 0.0
        if any(NOT_BASE.search(n) for n in names) or _suffix_map(names[0]) not in (None, "BaseColor"):
            sc -= 10
        if any(LIKELY_BASE.search(n) for n in names):
            sc += 3
        try:
            if img.colorspace_settings.name.lower() in ("srgb", "srgb - texture", "srgb texture", "rec.709", "displayp3"):
                sc += 2
            elif "non" in img.colorspace_settings.name.lower():
                sc -= 4
        except Exception:
            pass
        if c.get("output") == "Color":
            sc += 1
        sc += max(0, 4 - idx)
        if image_available(img):
            sc += 2
        if best_score is None or sc > best_score:
            best, best_score = c, sc
    return best


def image_roles(materials):
    """{image_name: (role, source)} from Principled/shader connections, falling back to file names."""
    roles = {}

    def put(img, role, src):
        if img is None:
            return
        cur = roles.get(img.name)
        if cur is None or (cur[1] != "graph" and src == "graph"):
            roles[img.name] = (role, src)

    for mat in materials:
        nt = material_tree(mat)
        if nt is None:
            continue
        for n, st in _walk_nodes(nt):
            if n.bl_idname == 'ShaderNodeBsdfPrincipled':
                for role, names in PRINCIPLED_INPUTS.items():
                    if role in ("emissionStrength", "specular"):
                        continue
                    s = find_input(n, *names)
                    if s is not None and s.is_linked:
                        tr = trace_image(s, st)
                        if tr:
                            put(tr["image"], "alpha" if (role == "baseColor" and tr.get("channel") == "A") else role, "graph")
            elif n.bl_idname in SHADER_COLOR_NODES:
                s = n.inputs.get("Color")
                if s is not None and s.is_linked:
                    tr = trace_image(s, st)
                    if tr and tr["image"].name not in roles:
                        put(tr["image"], "baseColor", "shader")
        # non-Principled toon setups: the most likely base texture reaching the output
        out = active_output(nt)
        if out is not None:
            best = pick_base_image(upstream_images(out.inputs.get("Surface")))
            if best and best["image"].name not in roles:
                put(best["image"], "baseColor", "output")
    return roles


def make_material_exportable(mat):
    """If no Principled BSDF drives the output, wire one in (session only) so FBX/glTF writers
    export the best-guess base-colour texture (and its alpha).  Returns a report dict or None."""
    nt = material_tree(mat)
    if nt is None:
        return None
    out = active_output(nt)
    if out is None:
        return None
    surf = out.inputs.get("Surface")
    n, _s = linked_from(surf)
    outputs = [x for x in nt.nodes if x.bl_idname == 'ShaderNodeOutputMaterial']
    direct = None
    for x in [out] + outputs:
        xn, _xs = linked_from(x.inputs.get("Surface"))
        if xn is not None and xn.bl_idname == 'ShaderNodeBsdfPrincipled':
            direct = xn
            break
    if direct is not None:
        for x in outputs:
            xn, _xs = linked_from(x.inputs.get("Surface"))
            if xn is not direct and x.inputs.get("Surface") is not None:
                nt.links.new(direct.outputs[0], x.inputs["Surface"])
        return None
    cands = upstream_images(surf) if surf is not None else []
    if not cands:
        cands = [{"image": x.image, "node": x, "output": "Color", "stack": ()}
                 for x in nt.nodes if x.bl_idname == 'ShaderNodeTexImage' and x.image is not None]
    best = pick_base_image(cands)
    bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
    bsdf.name = "BB_Export_Principled"
    bsdf.location = (out.location[0] - 320, out.location[1] - 360)
    rep = {"material": mat.name, "baseTexture": None, "alpha": "opaque"}
    s_rough = find_input(bsdf, "Roughness")
    if s_rough is not None:
        s_rough.default_value = 1.0
    s_spec = find_input(bsdf, "Specular IOR Level", "Specular")
    if s_spec is not None:
        try:
            s_spec.default_value = 0.0
        except Exception:
            pass
    base_in = find_input(bsdf, "Base Color")
    if best is not None:
        node = best["node"]
        if best.get("stack"):
            node = nt.nodes.new('ShaderNodeTexImage')
            node.image = best["image"]
            try:
                node.interpolation = best["node"].interpolation
                node.extension = best["node"].extension
            except Exception:
                pass
            node.location = (bsdf.location[0] - 320, bsdf.location[1])
        nt.links.new(node.outputs["Color"], base_in)
        rep["baseTexture"] = best["image"].name
        if best["node"].outputs["Alpha"].is_linked:
            mode = _alpha_mode(mat, True, 1.0)
            a_in = find_input(bsdf, "Alpha")
            if mode == "clip":
                m = nt.nodes.new('ShaderNodeMath')
                m.operation = 'ROUND'
                m.location = (bsdf.location[0] - 160, bsdf.location[1] - 260)
                nt.links.new(node.outputs["Alpha"], m.inputs[0])
                nt.links.new(m.outputs[0], a_in)
            else:
                nt.links.new(node.outputs["Alpha"], a_in)
            rep["alpha"] = mode
    else:
        # flat colour: RGB node or the first colour input of the surface shader
        col = None
        if n is not None:
            if n.bl_idname == 'ShaderNodeRGB':
                col = tuple(n.outputs[0].default_value)
            else:
                ci = n.inputs.get("Color") or n.inputs.get("Base Color")
                if ci is not None and not ci.is_linked:
                    col = tuple(ci.default_value)
        if col is None:
            col = tuple(mat.diffuse_color)
        base_in.default_value = _color4(col)
    # keep an existing normal map
    for x in nt.nodes:
        if x.bl_idname == 'ShaderNodeNormalMap' and x.inputs["Color"].is_linked:
            nin = find_input(bsdf, "Normal")
            if nin is not None:
                nt.links.new(x.outputs["Normal"], nin)
            break
    # exporters disagree on which output is "the" output (per-target active flags, e.g. an active
    # Cycles-only output is ignored by the 5.2 glTF writer), so feed them all and make them target All
    first = None
    for x in nt.nodes:
        if x.bl_idname == 'ShaderNodeOutputMaterial':
            s = x.inputs.get("Surface")
            if s is not None:
                nt.links.new(bsdf.outputs[0], s)
            try:
                x.target = 'ALL'
            except Exception:
                pass
            first = first or x
    try:
        (out or first).is_active_output = True
    except Exception:
        pass
    return rep


def materials_of(objs):
    mats, seen = [], set()
    for o in objs:
        for slot in getattr(o, "material_slots", ()):
            m = slot.material
            if m is not None and m.name not in seen:
                seen.add(m.name)
                mats.append(m)
    return mats


def images_of_materials(mats, linked_only=True):
    """Images used by image-texture nodes of the materials (by default only nodes wired to something)."""
    imgs, seen = [], set()
    for mat in mats:
        nt = material_tree(mat)
        if nt is None:
            continue
        for n, _st in _walk_nodes(nt):
            if n.bl_idname in ('ShaderNodeTexImage', 'ShaderNodeTexEnvironment') and n.image is not None:
                if linked_only and not any(o.is_linked for o in n.outputs):
                    continue
                if n.image.name not in seen:
                    seen.add(n.image.name)
                    imgs.append(n.image)
    return imgs


# --------------------------------------------------------------------------------------------
# Images
# --------------------------------------------------------------------------------------------

FORMAT_EXT = {'PNG': '.png', 'JPEG': '.jpg', 'TARGA': '.tga', 'TARGA_RAW': '.tga', 'BMP': '.bmp',
              'OPEN_EXR': '.exr', 'OPEN_EXR_MULTILAYER': '.exr', 'HDR': '.hdr', 'TIFF': '.tif',
              'WEBP': '.webp', 'JPEG2000': '.jp2', 'DPX': '.dpx', 'CINEON': '.cin', 'IRIS': '.rgb'}


def magic_ext(data):
    if not data:
        return None
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png"
    if data[:3] == b"\xff\xd8\xff":
        return ".jpg"
    if data[:4] == b"8BPS":
        return ".psd"
    if data[:2] == b"BM":
        return ".bmp"
    if data[:4] in (b"GIF8",):
        return ".gif"
    if data[:4] in (b"II*\x00", b"MM\x00*"):
        return ".tif"
    if data[:4] == b"v/1\x01":
        return ".exr"
    if data[:10] == b"#?RADIANCE" or data[:6] == b"#?RGBE":
        return ".hdr"
    if data[:4] == b"DDS ":
        return ".dds"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    return None


def header_size(data, ext=None):
    """(width, height) parsed from common image headers without decoding, or None."""
    try:
        if data[:8] == b"\x89PNG\r\n\x1a\n":
            return struct.unpack(">II", data[16:24])
        if data[:3] == b"\xff\xd8\xff":
            i = 2
            while i + 9 < len(data):
                if data[i] != 0xFF:
                    i += 1
                    continue
                marker = data[i + 1]
                if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7 or marker == 0xFF:
                    i += 1 if marker == 0xFF else 2
                    continue
                seglen = struct.unpack(">H", data[i + 2:i + 4])[0]
                if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                    h, w = struct.unpack(">HH", data[i + 5:i + 9])
                    return w, h
                i += 2 + seglen
            return None
        if data[:4] == b"8BPS":
            h, w = struct.unpack(">II", data[14:22])
            return w, h
        if data[:2] == b"BM":
            w, h = struct.unpack("<ii", data[18:26])
            return w, abs(h)
        if data[:4] == b"GIF8":
            return struct.unpack("<HH", data[6:10])
        if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
            fmt = data[12:16]
            if fmt == b"VP8 ":
                w, h = struct.unpack("<HH", data[26:30])
                return w & 0x3FFF, h & 0x3FFF
            if fmt == b"VP8L":
                b = data[21:25]
                bits = int.from_bytes(b, "little")
                return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
            if fmt == b"VP8X":
                return int.from_bytes(data[24:27], "little") + 1, int.from_bytes(data[27:30], "little") + 1
        if ext and ext.lower() == ".tga" and len(data) >= 18:
            return struct.unpack("<HH", data[12:16])
    except Exception:
        return None
    return None


def image_abs_path(img):
    if not img.filepath:
        return ""
    try:
        p = bpy.path.abspath(img.filepath, library=img.library)
    except TypeError:
        p = bpy.path.abspath(img.filepath)
    return os.path.normpath(p)


def image_available(img):
    if img.packed_file is not None:
        return True
    if img.source == 'GENERATED':
        return True
    p = image_abs_path(img)
    if img.source == 'TILED' and "<UDIM>" in p.upper():
        return True
    return bool(p) and os.path.isfile(p)


def image_info(img, roles=None):
    d = {"name": img.name, "filepath": img.filepath, "absPath": image_abs_path(img) if img.filepath else "",
         "packed": img.packed_file is not None, "source": img.source, "users": img.users,
         "width": 0, "height": 0, "colorspace": None}
    try:
        d["colorspace"] = img.colorspace_settings.name or None
    except Exception:
        pass
    d["exists"] = bool(d["absPath"]) and os.path.isfile(d["absPath"])
    size = None
    try:
        if img.packed_file is not None:
            size = header_size(img.packed_file.data[:1 << 19], os.path.splitext(img.filepath)[1])
        elif d["exists"]:
            with open(d["absPath"], "rb") as f:
                size = header_size(f.read(1 << 19), os.path.splitext(d["absPath"])[1])
        if size is None and (img.packed_file is not None or d["exists"] or img.source == 'GENERATED'):
            size = tuple(img.size)
    except Exception:
        size = None
    if size:
        d["width"], d["height"] = int(size[0]), int(size[1])
    role = None
    if roles and img.name in roles:
        role, src = roles[img.name]
        d["roleSource"] = src
    else:
        role = guess_role_by_name(img)
        d["roleSource"] = "name" if role else None
    if role == "occlusion":
        role = "other"
    d["role"] = role or "other"
    return d


class NameIndex:
    """Case-insensitive file-name lookup in a few folder trees (read-only, bounded walk)."""

    def __init__(self, roots, depth=3, max_dirs=4000):
        self.roots = [r for r in roots if r and os.path.isdir(r)]
        self.depth = depth
        self.max_dirs = max_dirs
        self._idx = None

    def _build(self):
        idx, visited, budget = {}, set(), self.max_dirs
        for root in self.roots:
            base_depth = norm(root).rstrip("\\/").count(os.sep)
            for dirpath, dirnames, filenames in os.walk(root):
                k = norm(dirpath)
                if k in visited:
                    dirnames[:] = []
                    continue
                visited.add(k)
                budget -= 1
                if budget <= 0:
                    dirnames[:] = []
                    break
                if k.rstrip("\\/").count(os.sep) - base_depth >= self.depth:
                    dirnames[:] = []
                for f in filenames:
                    idx.setdefault(f.lower(), os.path.join(dirpath, f))
        self._idx = idx

    def find(self, filename):
        if not filename or not self.roots:
            return None
        if self._idx is None:
            self._build()
        return self._idx.get(os.path.basename(filename.replace("\\", "/")).lower())


def sanitize_stem(s, fallback="texture"):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii")
    s = re.sub(r"[^A-Za-z0-9._-]+", "_", s)
    s = re.sub(r"_+", "_", s).strip("._-")
    return (s[:80] or fallback)


class TextureStager:
    """Copies/unpacks images into one folder with unique, sanitized file names.

    Nothing is ever written outside `allowed_roots`.  Missing external files are searched by name in
    `search_roots` (each scanned up to `search_depth` folder levels).
    """

    def __init__(self, dest_dir, allowed_roots, search_roots=(), search_depth=3, save_generated=True, dry_run=False):
        self.dry_run = dry_run  # plan names only: nothing is copied, unpacked or saved
        self.sources = {}       # image name -> {"from": path | None, "how": copy/packed/kept/generated/udim}
        self.dest_dir = os.path.normpath(dest_dir)
        self.allowed_roots = [r for r in allowed_roots if r]
        self.search_roots = [r for r in search_roots if r and os.path.isdir(r)]
        self.search_depth = search_depth
        self.save_generated = save_generated
        self.names = {}         # lower-case file name -> key
        self.by_key = {}        # key -> abs dest
        self.result = {}        # image name -> abs dest
        self.missing = []       # {"image", "path"}
        self.found = []         # {"image", "from"}
        self.skipped = []
        self._index = None

    # -- name handling
    def _unique(self, stem, ext, key, src_path=None, data=None):
        """Pick a free file name.  An existing file on disk is only reused when it is byte-identical
        to what would be written (so user files that happen to share a name are never overwritten)."""
        stem = sanitize_stem(stem)
        ext = (ext or ".png").lower()
        i = 1
        while True:
            cand = stem + ext if i == 1 else "%s_%d%s" % (stem, i, ext)
            i += 1
            owner = self.names.get(cand.lower())
            if owner is not None and owner != key:
                continue
            path = os.path.join(self.dest_dir, cand)
            if owner is None and os.path.exists(path) and not _same_content(path, src_path, data):
                continue
            self.names[cand.lower()] = key
            return path

    def reserve_existing(self, abs_path):
        """A file already inside dest_dir keeps its name (organize -> export reuse)."""
        key = norm(abs_path)
        self.names[os.path.basename(abs_path).lower()] = key
        self.by_key[key] = abs_path

    # -- missing-file search
    def find_by_name(self, filename):
        if self._index is None:
            self._index = NameIndex(self.search_roots, self.search_depth)
        return self._index.find(filename)

    # -- staging
    def stage(self, img, stem=None):
        """Returns the absolute destination path for the image, or None (missing/unsupported).
        `stem` replaces the old file name (standard texture names); the extension is kept."""
        if img.name in self.result:
            return self.result[img.name]
        if img.source == 'VIEWER':
            return None
        dest = None
        if img.packed_file is not None:
            data = img.packed_file.data
            key = ("packed", len(data), zlib.crc32(data))
            if key in self.by_key:
                dest = self.by_key[key]
            else:
                ext = magic_ext(data[:16]) or os.path.splitext(img.filepath)[1] or FORMAT_EXT.get(img.file_format, ".png")
                dest = self._unique(stem or image_stem(img), ext, key, data=data)
                if not self.dry_run and not (os.path.isfile(dest) and _same_content(dest, None, data)):
                    safe_write_bytes(dest, data, self.allowed_roots)
                self.by_key[key] = dest
            self.sources[img.name] = {"from": None, "how": "packed"}
            if len(img.packed_files) > 1:
                self.skipped.append({"image": img.name, "reason": "multiple packed files (UDIM/views); only the first was unpacked"})
        elif img.source in ('FILE', 'SEQUENCE', 'MOVIE', 'TILED'):
            src = image_abs_path(img)
            if img.source == 'TILED' and "<UDIM>" in src.upper():
                return self._stage_udim(img, src)
            if not src or not os.path.isfile(src):
                alt = self.find_by_name(os.path.basename(src.replace("\\", "/"))) if src else None
                if alt is None and img.name and "." in img.name:
                    alt = self.find_by_name(img.name)
                if alt is None:
                    self.missing.append({"image": img.name, "path": img.filepath})
                    return None
                self.found.append({"image": img.name, "from": alt})
                src = alt
            key = norm(src)
            how = "copy"
            if key in self.by_key:
                dest = self.by_key[key]
            elif is_under(src, self.dest_dir):
                dest = src
                how = "kept"
                self.reserve_existing(src)
            else:
                old_stem, ext = os.path.splitext(os.path.basename(src))
                dest = self._unique(stem or old_stem, ext, key, src_path=src)
                if not self.dry_run and not (os.path.isfile(dest) and _same_content(dest, src, None)):
                    safe_copy(src, dest, self.allowed_roots)
                self.by_key[key] = dest
            self.sources[img.name] = {"from": src, "how": how}
            if img.source in ('SEQUENCE', 'MOVIE'):
                self.skipped.append({"image": img.name, "reason": "%s image: only the referenced frame/file was copied" % img.source.lower()})
        elif img.source == 'GENERATED' and self.save_generated:
            key = ("generated", img.name)
            dest = self._unique(stem or image_stem(img), ".png", key)
            _check_dest(dest, self.allowed_roots)
            if not self.dry_run:
                os.makedirs(self.dest_dir, exist_ok=True)
                try:
                    img.filepath_raw = dest
                    img.file_format = 'PNG'
                    img.save()
                except Exception as e:
                    self.skipped.append({"image": img.name, "reason": "generated image could not be saved: %s" % e})
                    return None
            self.by_key[key] = dest
            self.sources[img.name] = {"from": None, "how": "generated"}
        else:
            return None
        self.result[img.name] = dest
        return dest

    def _stage_udim(self, img, src_token):
        stem, ext = os.path.splitext(os.path.basename(src_token))
        stem = re.sub(r"<udim>", "", stem, flags=re.I).rstrip("._-")
        key = norm(src_token)
        base = self._unique(stem, ext, key)
        bstem, bext = os.path.splitext(base)
        any_ok = False
        for tile in img.tiles:
            p = re.sub(r"<udim>", str(tile.number), src_token, flags=re.I)
            if os.path.isfile(p):
                if not self.dry_run:
                    safe_copy(p, "%s.%d%s" % (bstem, tile.number, bext), self.allowed_roots)
                any_ok = True
        if not any_ok:
            self.missing.append({"image": img.name, "path": img.filepath})
            return None
        dest = "%s.<UDIM>%s" % (bstem, bext)
        self.result[img.name] = dest
        self.sources[img.name] = {"from": src_token, "how": "udim"}
        self.skipped.append({"image": img.name, "reason": "UDIM tiles copied; FBX cannot reference tiles"})
        return dest


def _file_crc(path, limit=None):
    crc = 0
    with open(path, "rb") as f:
        while True:
            chunk = f.read(1 << 20)
            if not chunk:
                break
            crc = zlib.crc32(chunk, crc)
    return crc


def _same_content(path, src_path=None, data=None):
    """True when the file at `path` already holds exactly `data` / the content of `src_path`."""
    try:
        size = os.path.getsize(path)
        if data is not None:
            return size == len(data) and _file_crc(path) == zlib.crc32(data)
        if src_path is not None and os.path.isfile(src_path):
            if size != os.path.getsize(src_path):
                return False
            if same_path(path, src_path):
                return True
            return _file_crc(path) == _file_crc(src_path)
    except OSError:
        return False
    return False


def unpack_remove(img):
    """Drop packed data without writing anything (method='REMOVE')."""
    if img.packed_file is None:
        return
    items = [e.identifier for e in bpy.types.Image.bl_rna.functions['unpack'].parameters['method'].enum_items]
    if 'REMOVE' not in items:
        raise BBError("This Blender version cannot drop packed data safely")
    img.unpack(method='REMOVE')


# --------------------------------------------------------------------------------------------
# Standard texture names for Unity:  T_<Asset>_<Part>_<Map>.<ext>
#   T_Hero_Body_BaseColor.png  T_Hero_Body_Normal.png  T_Hero_Eyes_BaseColor.png
# <Map> comes from how the image is wired (Base Color, Normal Map, Roughness...), falling back to
# the socket or the old file name's suffix; <Part> from the old file name ("Tex_Eyes" -> Eyes),
# or the material when the file name says nothing ("texture_0.png"). The map is always last.
# --------------------------------------------------------------------------------------------

MAP_NAMES = {"baseColor": "BaseColor", "normal": "Normal", "height": "Height", "roughness": "Roughness",
             "metallic": "Metallic", "occlusion": "AO", "emission": "Emission", "alpha": "Opacity",
             "specular": "Specular", "mask": "Mask"}
_PACK_LETTER = {"occlusion": "O", "roughness": "R", "metallic": "M", "alpha": "A", "specular": "S",
                "height": "H", "emission": "E"}
_DATA_ROLES = ("occlusion", "roughness", "metallic", "specular", "alpha", "height")
_MIX_NODES = {'ShaderNodeMix', 'ShaderNodeMixRGB', 'ShaderNodeMixShader'}
# file-name suffixes -> map ("Body_D", "Hair_SS", "Hero_Body_BaseColor", "rock_nrm")
_SUFFIX_MAP = {
    "basecolor": "BaseColor", "basecolour": "BaseColor", "basemap": "BaseColor", "albedo": "BaseColor",
    "albedotransparency": "BaseColor", "alb": "BaseColor", "diffuse": "BaseColor", "diff": "BaseColor",
    "dif": "BaseColor", "col": "BaseColor", "color": "BaseColor", "colour": "BaseColor", "bc": "BaseColor",
    "base": "BaseColor", "d": "BaseColor",
    "normal": "Normal", "normals": "Normal", "normalmap": "Normal", "nrm": "Normal", "nor": "Normal",
    "norm": "Normal", "nml": "Normal", "nm": "Normal", "n": "Normal",
    "roughness": "Roughness", "rough": "Roughness", "rgh": "Roughness", "r": "Roughness",
    "metallic": "Metallic", "metalness": "Metallic", "metal": "Metallic", "met": "Metallic", "m": "Metallic",
    "ao": "AO", "occlusion": "AO", "ambientocclusion": "AO", "occ": "AO",
    "emission": "Emission", "emissive": "Emission", "emit": "Emission", "glow": "Emission", "e": "Emission",
    "opacity": "Opacity", "alpha": "Opacity", "transparency": "Opacity",
    "height": "Height", "displacement": "Height", "disp": "Height", "bump": "Height", "h": "Height",
    "specular": "Specular", "spec": "Specular",
    "gloss": "Smoothness", "glossiness": "Smoothness", "smoothness": "Smoothness", "smooth": "Smoothness",
    "metallicsmoothness": "MetallicSmoothness", "metallicroughness": "MetallicRoughness",
    "mask": "Mask", "maskmap": "Mask", "id": "Mask", "orm": "ORM", "mra": "MRA", "rma": "RMA", "arm": "ARM",
    "matcap": "Matcap", "sphere": "Matcap", "ramp": "Ramp", "lut": "Ramp", "gradient": "Ramp",
    "ss": "Shadow", "sss": "Shadow", "shadow": "Shadow", "shade": "Shadow", "shading": "Shadow",
    "outline": "Outline", "rim": "Rim", "lightmap": "Lightmap", "lm": "Lightmap",
}
_NOISE = {"tex", "texture", "textures", "tx", "img", "image", "map", "maps", "mat", "material", "materials",
          "mtl", "final", "new", "copy", "baked", "bake", "png", "jpg", "jpeg", "tga", "psd", "tif", "tiff",
          "exr", "srgb", "linear", "gl", "dx", "directx", "opengl", "udim", "untitled", "default", "lambert",
          "phong", "blinn", "principled", "bsdf", "shader", "base", "mi"}
_PREFIXES = {"t", "m", "mi", "mat", "tex", "tx", "texture"}   # T_eyes, Tex_Eyes, M_Body
_GENERIC_RX = re.compile(r"^(lambert|phong|blinn|standardsurface|aistandardsurface|material|mat|default|"
                         r"defaultmaterial|initialshadinggroup|none|untitled|surface|shader|texture|image|"
                         r"rgb|object|mesh|unnamed|noname)[ _#-]*\d*$", re.I)
_RES_RX = re.compile(r"\d+k|v\d+|256|512|1024|2048|4096|8192")
_NUMBERED_NOISE = re.compile(r"(tex|texture|textures|img|image|images|map|mat|material|untitled)\d+")   # texture3, image01


def _name_tokens(s):
    s = unicodedata.normalize("NFKD", str(s or "")).encode("ascii", "ignore").decode("ascii")
    s = re.sub(r"\.\d{3}$", "", s)                          # Blender duplicates: Eyes.001
    s = re.sub(r"\.(png|jpe?g|tga|psd|tiff?|exr|hdr|bmp|webp|dds)$", "", s, flags=re.I)
    s = re.sub(r"\.\d{3}$", "", s)                          # Eyes.png.001
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", s)           # camelCase -> camel Case
    s = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1 \2", s)        # PBRMaterial -> PBR Material
    return [t for t in re.split(r"[^A-Za-z0-9]+", s) if t]


def _pascal(tokens, limit=32):
    out = ""
    for t in tokens:
        w = t[:1].upper() + (t[1:].lower() if (t.isupper() or t.islower()) else t[1:])
        if out and len(out) + len(w) > limit:
            break
        out += w
    return out


def texture_asset_name(name):
    """'Mini Hero' -> 'MiniHero' (the <Asset> part of T_<Asset>_<Part>_<Map>)."""
    toks = [t for t in _name_tokens(name) if t.lower() not in ("t", "tex", "texture")]
    return _pascal(toks, 40) or "Asset"


def _strip_tail(toks):
    """Drop resolution/version/noise tokens from the end ("Body_D_2k_final" -> Body, D)."""
    toks = list(toks)
    while toks and (toks[-1].lower() in _NOISE or _RES_RX.fullmatch(toks[-1].lower()) or toks[-1].isdigit() and len(toks) > 1 and len(toks[-1]) >= 3):
        if toks[-1].lower() == "base" and len(toks) > 1:
            break
        toks.pop()
    return toks


def _segments(name):
    """'Tex_Tee_SweetieMetal.png.001' -> ['Tex', 'Tee', 'SweetieMetal'] (no camelCase split)."""
    s = unicodedata.normalize("NFKD", str(name or "")).encode("ascii", "ignore").decode("ascii")
    s = re.sub(r"\.\d{3}$", "", s)
    s = re.sub(r"\.(png|jpe?g|tga|psd|tiff?|exr|hdr|bmp|webp|dds)$", "", s, flags=re.I)
    s = re.sub(r"\.\d{3}$", "", s)
    return [t for t in re.split(r"[^A-Za-z0-9]+", s) if t]


def _suffix_map(name):
    """Map named by the file's last segment: Body_D -> BaseColor, Hair_SS -> Shadow, rock_nrm_gl -> Normal.
    Only whole segments count, so Tee_SweetieMetal is not a metallic map."""
    toks = _strip_tail(_segments(name))
    if len(toks) < 2:
        return None
    low = [t.lower() for t in toks]
    if len(low) >= 3 and (low[-2] + low[-1]) in _SUFFIX_MAP:
        return _SUFFIX_MAP[low[-2] + low[-1]]
    if low[-1] in _SUFFIX_MAP:
        return _SUFFIX_MAP[low[-1]]
    if len(low) >= 3 and len(low[-2]) > 1 and low[-2] in _SUFFIX_MAP:   # Costume_Base_Short
        return _SUFFIX_MAP[low[-2]]
    return None


def _socket_map(text):
    """Map from the socket names an image feeds ('Shade Color' -> Shadow, 'Base Color' -> BaseColor)."""
    found = None
    for t in _name_tokens(text):
        m = _SUFFIX_MAP.get(t.lower()) if len(t) > 1 else None
        if m and m != "BaseColor":
            return m
        found = found or m
    return found


def _clean_part(name, asset_words, map_name=None, any_map=False):
    """Part name from an old file or material name: drops T_/Tex_ prefixes, the map suffix (only when it
    names `map_name`, or any map word with any_map), noise words, the asset's own name, resolutions
    and versions ("Tex_Hair_SS" + Shadow -> Hair, "Tee_SweetieMetal" + BaseColor -> TeeSweetieMetal).
    Returns (part, generic)."""
    base = re.sub(r"\.\d{3}$", "", str(name or "")).strip()
    toks = _name_tokens(base)
    if not toks or _GENERIC_RX.match(base):
        return "", True
    while len(toks) > 1 and toks[0].lower() in _PREFIXES:
        toks = toks[1:]
    def is_map(word):
        m = _SUFFIX_MAP.get(word.lower())
        return m is not None and (any_map or m == map_name)

    for _i in range(4):                                     # map words only count at the end
        toks = _strip_tail(toks)
        if len(toks) > 2 and is_map(toks[-2] + toks[-1]):
            toks = toks[:-2]
            continue
        if len(toks) > 1 and is_map(toks[-1]):
            toks = toks[:-1]
            continue
        break
    keep = [t for t in toks if t.lower() not in _NOISE and t.lower() not in asset_words
            and not _RES_RX.fullmatch(t.lower()) and not _NUMBERED_NOISE.fullmatch(t.lower())]
    if len(keep) == 1 and keep[0].lower() in _SUFFIX_MAP and len(toks) == 1:
        keep = []                                           # a file just called "normal.png"
    if keep and all(t.isdigit() for t in keep):
        keep = []
    generic = not keep and not any(t.lower() in asset_words for t in toks)
    return _pascal(keep), generic


def _role_walk(sock, role, stack, out, seen, depth=0, channel=None):
    """Every image reaching `sock`, with the role it plays there (Fac of a Mix = mask,
    Normal Map node = normal, Bump height = height, Separate RGB = channel)."""
    if depth > 64 or sock is None or not sock.is_linked:
        return
    n, s = linked_from(sock)
    if n is None:
        return
    key = (n.as_pointer(), s.identifier, tuple(g.as_pointer() for g in stack), role, channel)
    if key in seen:
        return
    seen.add(key)
    t = n.bl_idname
    if t == 'ShaderNodeTexImage':
        if n.image is not None and not n.mute:
            ch = 'A' if s.name == 'Alpha' else channel
            out.append((n.image, 'alpha' if role == 'baseColor' and ch == 'A' else role, ch))
        return
    if n.mute:
        return
    if t == 'NodeGroupInput':
        if stack:
            _role_walk(_sock_by_id(stack[-1].inputs, s.identifier), role, stack[:-1], out, seen, depth + 1, channel)
        return
    if t == 'ShaderNodeGroup':
        if n.node_tree is not None:
            go = group_output(n.node_tree)
            if go is not None:
                _role_walk(_sock_by_id(go.inputs, s.identifier), role, stack + (n,), out, seen, depth + 1, channel)
        return
    if t in SEPARATE_NODES:
        _role_walk(n.inputs[0], role, stack, out, seen, depth + 1, CHANNEL_NAMES.get(s.name, channel))
        return
    if t == 'ShaderNodeNormalMap':
        _role_walk(n.inputs.get("Color"), 'normal', stack, out, seen, depth + 1)
        return
    if t in ('ShaderNodeBump', 'ShaderNodeDisplacement'):
        _role_walk(n.inputs.get("Height"), 'height', stack, out, seen, depth + 1)
        _role_walk(n.inputs.get("Normal"), 'normal', stack, out, seen, depth + 1)
        return
    for i in n.inputs:
        if not i.is_linked or i.type in ('VECTOR', 'SHADER'):
            continue
        r = 'mask' if (t in _MIX_NODES and i.name in ("Fac", "Factor")) else role
        _role_walk(i, r, stack, out, seen, depth + 1, channel)


def _socket_hint(node):
    """Names of the sockets an image node feeds (custom toon groups: 'Shade Color', 'Matcap'...)."""
    names = []
    for o in node.outputs:
        for link in o.links:
            names.append(link.to_socket.name or "")
            if link.to_node.bl_idname == 'ShaderNodeGroup':
                names.append(link.to_node.label or "")
    return " ".join(names)


def texture_usage(mats):
    """{image name: {"image", "roles": {role: set(channels)}, "materials": [names], "hints": str,
    "rivals": set(other images in the same base-colour slot)}}"""
    use = {}

    def rec(img, mat):
        u = use.get(img.name)
        if u is None:
            u = use[img.name] = {"image": img, "roles": {}, "materials": [], "hints": "", "rivals": set()}
        if mat.name not in u["materials"]:
            u["materials"].append(mat.name)
        return u

    for mat in mats:
        nt = material_tree(mat)
        if nt is None:
            continue
        nodes = _walk_nodes(nt)
        found = []
        seen = set()
        has_principled = any(n.bl_idname == 'ShaderNodeBsdfPrincipled' for n, _st in nodes)
        for n, st in nodes:
            if n.mute:
                continue
            t = n.bl_idname
            if t == 'ShaderNodeBsdfPrincipled':
                for role, names in PRINCIPLED_INPUTS.items():
                    if role != "emissionStrength":
                        _role_walk(find_input(n, *names), role, st, found, seen)
                for nm in ("Coat Normal", "Clearcoat Normal"):
                    _role_walk(n.inputs.get(nm), 'normal', st, found, seen)
            elif t in SHADER_COLOR_NODES and t != 'ShaderNodeBackground':
                role = 'emission' if (t == 'ShaderNodeEmission' and has_principled) else 'baseColor'
                _role_walk(n.inputs.get("Color"), role, st, found, seen)
                _role_walk(n.inputs.get("Normal"), 'normal', st, found, seen)
            elif t == 'ShaderNodeGroup' and n.node_tree is not None and "gltf" in n.node_tree.name.lower():
                _role_walk(n.inputs.get("Occlusion"), 'occlusion', st, found, seen)
            elif t == 'ShaderNodeOutputMaterial':
                _role_walk(n.inputs.get("Displacement"), 'height', st, found, seen)
        for img, role, ch in found:
            rec(img, mat)["roles"].setdefault(role, set()).add(ch)
        bases = {img.name for img, role, _c in found if role == "baseColor"}
        for b in bases:
            use[b]["rivals"] |= bases - {b}
        # images wired to something but not reached above (custom groups, toon setups)
        for n, _st in nodes:
            if n.bl_idname in ('ShaderNodeTexImage', 'ShaderNodeTexEnvironment') and n.image is not None \
                    and any(o.is_linked for o in n.outputs):
                u = rec(n.image, mat)
                if not u["roles"]:
                    u["hints"] = (u["hints"] + " " + _socket_hint(n)).strip()
        # no base colour reached: the most likely base texture feeding the output
        if not bases:
            out = active_output(nt)
            best = pick_base_image(upstream_images(out.inputs.get("Surface"))) if out is not None else None
            if best is not None and _suffix_map(image_stem(best["image"])) not in (None, "BaseColor"):
                best = None
            if best is not None:
                u = rec(best["image"], mat)
                if not (set(u["roles"]) & {"normal", "roughness", "metallic", "occlusion", "height"}):
                    u["roles"].setdefault("baseColor", set()).add(None)
    return use


def _map_for(u, use):
    roles = u["roles"]
    rs = set(roles)
    img = u["image"]
    by_name = _suffix_map(image_stem(img)) or _suffix_map(img.name)
    if "baseColor" in rs:
        # toon setups mix a base and a shade colour into the same slot: the one whose file name
        # says Shadow/Matcap/... is that map, as long as another texture is the real base
        if by_name and by_name != "BaseColor":
            for r in u["rivals"]:
                ru = use.get(r)
                rn = (_suffix_map(image_stem(ru["image"])) or _suffix_map(r)) if ru else None
                if rn in (None, "BaseColor"):
                    return by_name
        return "BaseColor"
    if "normal" in rs:
        return "Normal"
    data = [r for r in _DATA_ROLES if r in rs]
    if len(data) >= 2:
        chans = {}
        for r in data:
            for ch in roles[r]:
                if ch in ("R", "G", "B", "A") and ch not in chans:
                    chans[ch] = r
        if len(chans) == len(data):
            return "".join(_PACK_LETTER[chans[c]] for c in "RGBA" if c in chans)   # ORM, MRA...
        return "Mask"
    if data:
        return MAP_NAMES[data[0]]
    if "emission" in rs:
        return "Emission"
    if "mask" in rs:
        return "Mask"
    return _socket_map(u.get("hints") or "") or by_name


def _source_key(img):
    if img.packed_file is not None:
        data = img.packed_file.data
        return ("packed", len(data), zlib.crc32(data))
    return norm(image_abs_path(img) or img.name)


_VERSION_TAIL = re.compile(r"(?:[\d_\-\s.]+(?i:applied|final|rigged|baked|export|unity|fixed|new|v\d+)?"
                           r"|(?<=[a-z])(?:Applied|Final|Rigged|Baked|Export|Unity|Fixed|New|V\d+))[\d_\-\s.]*$")


def asset_from_filename(path):
    """'D:/x/Hero54Applied.fbx' -> 'Hero' (drops @clip, versions and words like final/applied)."""
    st = os.path.splitext(os.path.basename(str(path or "")))[0].split("@")[0]
    cleaned = _VERSION_TAIL.sub("", st)
    return cleaned or st or "Asset"


def texture_stem(asset, part, map_name):
    return "_".join(x for x in ("T", asset, part, map_name) if x)


def texture_name_plan(mats, asset_name, extra_images=()):
    """{image name: {"stem", "map", "part", "materials", "roles"}} for every image the materials use
    (plus `extra_images`, named from their file names only)."""
    asset = texture_asset_name(asset_name)
    asset_words = {t.lower() for t in _name_tokens(asset_name)} | {asset.lower()}
    use = texture_usage(mats)
    for img in extra_images:
        if img.name not in use:
            use[img.name] = {"image": img, "roles": {}, "materials": [], "hints": "", "rivals": set()}
    plan, order = {}, []
    for name, u in use.items():
        img = u["image"]
        if img.source == 'VIEWER':
            continue
        map_name = _map_for(u, use)
        file_part, _g = _clean_part(image_stem(img), asset_words, map_name)
        mat_parts, generic = [], False
        for mn in u["materials"]:
            p, g = _clean_part(mn, asset_words, any_map=True)
            generic = generic or g
            if p not in mat_parts:
                mat_parts.append(p)
        mat_part = mat_parts[0] if len(mat_parts) == 1 and not generic else ""
        part = file_part or mat_part
        plan[name] = {"stem": texture_stem(asset, part, map_name), "map": map_name, "part": part,
                      "matPart": mat_part, "materials": list(u["materials"]), "key": repr(_source_key(img)),
                      "roles": sorted(u["roles"])}
        order.append(name)
    # one name per file: Image datablocks that point at the same file share the best-informed name
    by_key = {}
    for n in order:
        by_key.setdefault(plan[n]["key"], []).append(n)
    for names in by_key.values():
        if len(names) > 1:
            best = max(names, key=lambda n: (plan[n]["map"] is not None, len(plan[n]["materials"])))
            for n in names:
                for k in ("stem", "map", "part"):
                    plan[n][k] = plan[best][k]
    # different files that would get the same name: the one matching its material keeps it,
    # the others are numbered (Maid, Maid2...) so the map stays the last word
    groups = {}
    for n in order:
        groups.setdefault(plan[n]["stem"].lower(), {}).setdefault(plan[n]["key"], []).append(n)
    taken = {s for s in groups}
    for stem_l, keys in groups.items():
        if len(keys) < 2:
            continue
        ks = sorted(keys, key=lambda k: (plan[keys[k][0]]["part"] != plan[keys[k][0]]["matPart"], order.index(keys[k][0])))
        for idx, k in enumerate(ks[1:], start=2):
            e0 = plan[keys[k][0]]
            i = idx
            while True:
                stem = texture_stem(asset, (e0["part"] or "") + str(i), e0["map"])
                if stem.lower() not in taken:
                    break
                i += 1
            taken.add(stem.lower())
            for n in keys[k]:
                plan[n]["stem"] = stem
                plan[n]["part"] = (e0["part"] or "") + str(i)
    for e in plan.values():
        e.pop("key", None)
        e.pop("matPart", None)
    return plan


# --------------------------------------------------------------------------------------------
# Humanoid guess / facing
# --------------------------------------------------------------------------------------------

HUMANOID_REQUIRED = ["Hips", "Spine", "Head", "LeftUpperArm", "LeftLowerArm", "LeftHand", "RightUpperArm",
                     "RightLowerArm", "RightHand", "LeftUpperLeg", "LeftLowerLeg", "LeftFoot",
                     "RightUpperLeg", "RightLowerLeg", "RightFoot"]
_EXCLUDE_TOKENS = {"twist", "roll", "ik", "fk", "pole", "target", "helper", "offset", "end", "tip", "nub",
                   "ctrl", "control", "ctl", "mch", "vis", "ref", "socket", "attach", "prop", "weapon",
                   "corrective", "pin", "scale", "fix", "pre", "thumb", "index", "middle", "ring", "pinky",
                   "little", "finger", "fingers", "hair", "skirt", "dress", "tail", "ear", "breast", "bust",
                   "cloth", "jiggle", "dummy", "null", "lock", "track", "aim", "parent", "master", "traj",
                   "pos", "bend", "rot", "stretchy", "proxy", "copy", "def2", "tweak", "upv", "upvector",
                   "shape", "cs", "wgt", "widget", "eyelid", "lid", "brow", "lip", "tongue", "teeth", "cheek",
                   "nose", "mouth"}
_NOISE_TOKENS = {"j", "bip", "bip01", "bip001", "b", "mixamorig", "def", "org", "drv", "jnt", "joint", "bone",
                 "bn", "sk", "skel", "valvebiped", "cc", "base", "x", "c", "m", "stretch", "deform", "mmd",
                 "character", "char", "rig", "armature", "jbip", "jsec", "jadj", "ue", "unity"}
_JP_MAP = {"下半身": "hips", "上半身": "spine", "上半身2": "chest", "上半身3": "upperchest", "首": "neck",
           "頭": "head", "肩": "shoulder", "腕": "upperarm", "ひじ": "forearm", "手首": "hand", "足": "thigh",
           "ひざ": "knee", "足首": "foot", "つま先": "toes", "目": "eye"}


def _bone_tokens(name):
    s = unicodedata.normalize("NFKC", name)
    side = None
    if "左" in s:
        side = "L"
    elif "右" in s:
        side = "R"
    jp = s.replace("左", "").replace("右", "").strip()
    if jp in _JP_MAP:
        return side, [_JP_MAP[jp]], True
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", s)
    s = re.sub(r"([A-Za-z])(\d)", r"\1 \2", s)
    s = re.sub(r"(\d)([A-Za-z])", r"\1 \2", s)
    toks = [t for t in re.split(r"[^a-z0-9]+", s.lower()) if t]
    rest = []
    for t in toks:
        if t in ("l", "left", "lft"):
            side = side or "L"
        elif t in ("r", "right", "rgt", "rt"):
            side = side or "R"
        else:
            rest.append(t)
    return side, rest, False


def _classify_part(rest):
    """Return (part, index) or (None, None).  part is a normalized anatomical key."""
    if any(t in _EXCLUDE_TOKENS for t in rest):
        return None, None
    words = [t for t in rest if t not in _NOISE_TOKENS and not t.isdigit()]
    digits = [int(t) for t in rest if t.isdigit()]
    idx = digits[0] if digits else 0
    key = "".join(words)
    alias = {
        "hips": "hips", "hip": "hip", "pelvis": "hips", "lowerbody": "hips", "root": "root", "center": "center",
        "spine": "spine", "spine0": "spine", "torso": "spine", "abdomen": "spine", "waist": "spine",
        "upperbody": "spine", "chest": "chest", "upperchest": "upperchest", "neck": "neck", "head": "head",
        "shoulder": "shoulder", "clavicle": "clavicle", "collar": "clavicle", "collarbone": "clavicle",
        "scapula": "clavicle", "upperarm": "upperarm", "uparm": "upperarm", "armupper": "upperarm",
        "arm": "arm", "forearm": "forearm", "lowerarm": "forearm", "loarm": "forearm", "elbow": "forearm",
        "armlower": "forearm", "hand": "hand", "wrist": "hand", "upperleg": "thigh", "upleg": "thigh",
        "thigh": "thigh", "legupper": "thigh", "leg": "leg", "lowerleg": "shin", "loleg": "shin", "calf": "shin",
        "shin": "shin", "knee": "shin", "leglower": "shin", "foot": "foot", "ankle": "foot", "toe": "toes",
        "toes": "toes", "toebase": "toes", "ball": "toes", "eye": "eye", "jaw": "jaw",
    }
    part = alias.get(key)
    return part, idx


def guess_humanoid(arm_obj):
    """Heuristic Unity-humanoid mapping.  Returns dict(humanoid, matched{canonical: bone}, missing[])."""
    bones = arm_obj.data.bones

    def attempt(only_deform):
        cands = {}
        for b in bones:
            if only_deform and not b.use_deform:
                continue
            side, rest, _jp = _bone_tokens(b.name)
            part, idx = _classify_part(rest)
            if part is None:
                continue
            depth = 0
            p = b.parent
            while p is not None:
                depth += 1
                p = p.parent
            cands.setdefault((part, side), []).append((depth, idx, b.name))
        for v in cands.values():
            v.sort()
        m = {}

        def first(part, side=None):
            v = cands.get((part, side))
            return v[0][2] if v else None

        hips = first("hips") or first("hip") or first("pelvis")
        spines = sorted(cands.get(("spine", None), []), key=lambda t: (t[0], t[1]))
        if hips is None:
            hips = first("root") or first("center")
        if hips:
            m["Hips"] = hips
        chest = first("chest")
        upper_chest = first("upperchest")
        sp = [s[2] for s in spines if s[2] != hips]
        if sp:
            m["Spine"] = sp[0]
            if chest is None and len(sp) > 1:
                chest = sp[1]
            if upper_chest is None and len(sp) > 2:
                upper_chest = sp[2]
        elif chest:
            m["Spine"] = chest
            chest = upper_chest
            upper_chest = None
        if chest and chest != m.get("Spine"):
            m["Chest"] = chest
        if upper_chest and upper_chest not in (m.get("Spine"), m.get("Chest")):
            m["UpperChest"] = upper_chest
        for part, canon in (("neck", "Neck"), ("head", "Head"), ("jaw", "Jaw")):
            v = first(part)
            if v:
                m[canon] = v
        for side, pre in (("L", "Left"), ("R", "Right")):
            clav = first("clavicle", side)
            shoulder = first("shoulder", side)
            upper = first("upperarm", side)
            arm = first("arm", side)
            fore = first("forearm", side)
            if upper is None:
                if arm is not None:
                    upper = arm
                elif shoulder is not None and (clav is not None or fore is not None):
                    upper, shoulder = shoulder, None
            if clav is None and shoulder is not None and shoulder != upper:
                clav = shoulder
            if fore is None and arm is not None and arm != upper:
                fore = arm
            for canon, val in (("Shoulder", clav), ("UpperArm", upper), ("LowerArm", fore), ("Hand", first("hand", side))):
                if val:
                    m[pre + canon] = val
            thigh = first("thigh", side) or first("hip", side)
            leg = first("leg", side)
            shin = first("shin", side)
            if thigh is None and leg is not None and shin is not None:
                thigh = leg
            elif shin is None and leg is not None and thigh is not None:
                shin = leg
            elif thigh is None and shin is None and leg is not None:
                thigh = leg
            for canon, val in (("UpperLeg", thigh), ("LowerLeg", shin), ("Foot", first("foot", side)),
                               ("Toes", first("toes", side)), ("Eye", first("eye", side))):
                if val:
                    m[pre + canon] = val
        return m

    m = attempt(True)
    if sum(1 for k in HUMANOID_REQUIRED if k in m) < len(HUMANOID_REQUIRED):
        m2 = attempt(False)
        if sum(1 for k in HUMANOID_REQUIRED if k in m2) > sum(1 for k in HUMANOID_REQUIRED if k in m):
            m = m2
    missing = [k for k in HUMANOID_REQUIRED if k not in m]
    # every required slot needs its own bone (both arms: upper/lower/hand, both legs: upper/lower/foot,
    # hips, spine, head); a bone used twice means the guess is unreliable
    used = {}
    for k in HUMANOID_REQUIRED:
        if k in m:
            used.setdefault(m[k], []).append(k)
    dups = {b: ks for b, ks in used.items() if len(ks) > 1}
    issues = ["%s mapped to %s" % (b, "+".join(ks)) for b, ks in dups.items()]

    def is_ancestor(a, b):
        ba = bones.get(b)
        p = ba.parent if ba is not None else None
        while p is not None:
            if p.name == a:
                return True
            p = p.parent
        return False

    # sanity: each limb chain should hang below the hips (warn only; some rigs parent deform bones oddly)
    if not missing and not dups:
        for k in ("LeftUpperLeg", "RightUpperLeg", "Spine"):
            if not is_ancestor(m["Hips"], m[k]):
                issues.append("%s (%s) is not below Hips (%s)" % (k, m[k], m["Hips"]))
    return {"humanoid": not missing and not dups, "matched": m, "missing": missing, "issues": issues}


def estimate_facing(arm_obj, matched):
    """Forward direction (Blender world space) from rest pose: normalize(cross(left - right, up))."""
    bones = arm_obj.data.bones
    mw = arm_obj.matrix_world
    for lk, rk in (("LeftUpperLeg", "RightUpperLeg"), ("LeftUpperArm", "RightUpperArm"), ("LeftShoulder", "RightShoulder"),
                   ("LeftFoot", "RightFoot"), ("LeftHand", "RightHand")):
        lb, rb = bones.get(matched.get(lk, "")), bones.get(matched.get(rk, ""))
        if lb is None or rb is None:
            continue
        across = (mw @ lb.head_local) - (mw @ rb.head_local)
        f = across.cross(Vector((0.0, 0.0, 1.0)))
        if f.length > 1e-6:
            f.normalize()
            return f, lk[4:]
    return None, None


# --------------------------------------------------------------------------------------------
# FBX file inspection (binary + ASCII)
# --------------------------------------------------------------------------------------------


def fbx_read_info(path, details=True):
    """Read GlobalSettings (UnitScaleFactor, axes) and, with details, textures/takes/object counts."""
    with open(path, "rb") as f:
        data = f.read()
    if not data.startswith(b"Kaydara FBX Binary  \x00"):
        return _fbx_ascii_info(data.decode("utf-8", "replace"), details)
    version = struct.unpack_from("<I", data, 23)[0]
    wide = version >= 7500
    hdr = 25 if wide else 13

    def node_at(off):
        if wide:
            end, nprops, plen = struct.unpack_from("<QQQ", data, off)
            off += 24
        else:
            end, nprops, plen = struct.unpack_from("<III", data, off)
            off += 12
        nlen = data[off]
        name = data[off + 1:off + 1 + nlen].decode("ascii", "replace")
        poff = off + 1 + nlen
        return name, end, nprops, poff, poff + plen

    def children(start, end):
        off = start
        while off + hdr <= end:
            name, nend, nprops, poff, coff = node_at(off)
            if nend == 0:
                break
            yield name, nend, nprops, poff, coff
            off = nend

    def props(poff, n):
        out = []
        off = poff
        for _ in range(n):
            t = chr(data[off])
            off += 1
            if t == 'Y':
                out.append(struct.unpack_from("<h", data, off)[0]); off += 2
            elif t == 'C':
                out.append(bool(data[off])); off += 1
            elif t == 'I':
                out.append(struct.unpack_from("<i", data, off)[0]); off += 4
            elif t == 'F':
                out.append(struct.unpack_from("<f", data, off)[0]); off += 4
            elif t == 'D':
                out.append(struct.unpack_from("<d", data, off)[0]); off += 8
            elif t == 'L':
                out.append(struct.unpack_from("<q", data, off)[0]); off += 8
            elif t in "fdlibc":
                _alen, _enc, clen = struct.unpack_from("<III", data, off)
                off += 12 + clen
                out.append(None)
            elif t in "SR":
                ln = struct.unpack_from("<I", data, off)[0]
                off += 4
                raw = data[off:off + ln]
                off += ln
                out.append(raw.decode("utf-8", "replace") if t == 'S' else ("<%d bytes>" % ln))
            else:
                break
        return out

    def raw_len(poff):
        # length of a single R/S property without copying it
        t = chr(data[poff])
        if t in "SR":
            return struct.unpack_from("<I", data, poff + 1)[0]
        return 0

    info = {"binary": True, "version": version}
    top_end = len(data)
    models, parent_of = {}, {}
    for name, nend, nprops, poff, coff in children(27, top_end):
        if details and name == "Connections":
            for cn, cend, cnp, cpoff, ccoff in children(coff, nend):
                if cn == "C":
                    pv = props(cpoff, min(cnp, 3))
                    if len(pv) >= 3 and pv[0] == "OO":
                        parent_of.setdefault(pv[1], pv[2])
            continue
        if name == "GlobalSettings":
            for cn, cend, cnp, cpoff, ccoff in children(coff, nend):
                if cn != "Properties70":
                    continue
                for pn, pend, pnp, ppoff, pcoff in children(ccoff, cend):
                    if pn != "P":
                        continue
                    pv = props(ppoff, pnp)
                    if len(pv) >= 5:
                        info[pv[0][0].lower() + pv[0][1:]] = pv[4]
        elif details and name == "Objects":
            counts, textures, takes = {}, [], []
            for cn, cend, cnp, cpoff, ccoff in children(coff, nend):
                counts[cn] = counts.get(cn, 0) + 1
                if cn == "Model":
                    pv = props(cpoff, cnp)
                    m = {"name": pv[1].split("\x00\x01")[0] if len(pv) > 1 and isinstance(pv[1], str) else "",
                         "type": pv[2] if len(pv) > 2 else None,
                         "lclTranslation": [0.0, 0.0, 0.0], "lclRotation": [0.0, 0.0, 0.0], "lclScaling": [1.0, 1.0, 1.0]}
                    for gn, gend, gnp, gpoff, gcoff in children(ccoff, cend):
                        if gn != "Properties70":
                            continue
                        for qn, qend, qnp, qpoff, qcoff in children(gcoff, gend):
                            if qn != "P":
                                continue
                            qv = props(qpoff, qnp)
                            key = {"Lcl Translation": "lclTranslation", "Lcl Rotation": "lclRotation",
                                   "Lcl Scaling": "lclScaling", "PreRotation": "preRotation",
                                   "PostRotation": "postRotation"}.get(qv[0] if qv else None)
                            if key and len(qv) >= 7:
                                m[key] = [float(qv[4]), float(qv[5]), float(qv[6])]
                    models[pv[0]] = m
                    continue
                if cn in ("Video", "Texture", "AnimationStack"):
                    pv = props(cpoff, cnp)
                    obj_name = pv[1].split("\x00\x01")[0] if len(pv) > 1 and isinstance(pv[1], str) else ""
                    if cn == "AnimationStack":
                        takes.append(obj_name)
                        continue
                    entry = {"kind": cn, "name": obj_name}
                    for gn, gend, gnp, gpoff, gcoff in children(ccoff, cend):
                        if gn in ("RelativeFilename", "Filename", "FileName"):
                            v = props(gpoff, gnp)
                            entry["relativeFilename" if gn == "RelativeFilename" else "filename"] = v[0] if v else ""
                        elif gn == "Content":
                            entry["embeddedBytes"] = raw_len(gpoff) if gnp else 0
                    textures.append(entry)
            info["objectCounts"] = counts
            info["_models"] = models
            info["videos"] = [t for t in textures if t["kind"] == "Video"]
            info["textures"] = [t for t in textures if t["kind"] == "Texture"]
            info["takes"] = takes
    if details:
        mods = info.pop("_models", models)
        info["rootModels"] = [dict(m) for mid, m in mods.items() if parent_of.get(mid, 0) == 0]
    return info


def _fbx_ascii_info(text, details):
    info = {"binary": False}
    m = re.search(r"FBXVersion:\s*(\d+)", text)
    if m:
        info["version"] = int(m.group(1))
    for key in ("UnitScaleFactor", "OriginalUnitScaleFactor", "UpAxis", "UpAxisSign", "FrontAxis",
                "FrontAxisSign", "CoordAxis", "CoordAxisSign"):
        m = re.search(r'P:\s*"%s"\s*,\s*"[^"]*"\s*,\s*"[^"]*"\s*,\s*"[^"]*"\s*,\s*([-0-9.eE+]+)' % key, text)
        if m:
            v = float(m.group(1))
            info[key[0].lower() + key[1:]] = int(v) if "Axis" in key else v
    if details:
        info["takes"] = re.findall(r'AnimationStack:\s*\d+\s*,\s*"AnimStack::([^"]*)"', text)
        info["videos"] = [{"kind": "Video", "relativeFilename": x} for x in re.findall(r'RelativeFilename:\s*"([^"]*)"', text)]
    return info



# --------------------------------------------------------------------------------------------
# Transform baking for Unity: optional user rotation + Unity axis fix + root scale
# --------------------------------------------------------------------------------------------
#
# Every exported object gets its world rotation (and positive uniform scale) baked into its data,
# plus the classic "Unity fix": data rotated -90 deg about X, object left with +90 deg about X.
# The FBX writer's Z-up -> Y-up conversion (-90 deg X on root nodes) then cancels that +90, so in
# Unity every root node has rotation 0 and scale 1 while the world-space result is unchanged.
#
# Proof sketch (W = world matrix, Q = baked matrix, data' = Q data, world' = W Q^-1):
#   meshes:      world' data' = W data                                   (unchanged)
#   skinning:    vertices and bone rest poses are both expressed through Q_arm, so armature-space
#                positions become Q_arm p and bone matrices Q_arm B S^-1 -> deformation unchanged
#                (bone-local location keys are multiplied by the baked armature scale s).
#   animation:   object-level transform curves are re-sampled per frame: basis'(t) = L basis(t) Q^-1
#                with L = R (roots), PIinv Q_parent PI (object parent), PIinv S_parent PI (bone parent).

TRANSFORM_PATHS = ("location", "rotation_euler", "rotation_quaternion", "rotation_axis_angle", "scale")
UNITY_AXIS_FIX = Matrix.Rotation(math.radians(-90.0), 4, 'X')


def _paths_resolve(o, fcurves):
    for fc in fcurves:
        try:
            o.path_resolve(fc.data_path)
        except ValueError:
            return False
    return True


def _has_transform_curves(fcs):
    return any(fc.data_path in TRANSFORM_PATHS for fc in fcs)


def _is_bone_location(path):
    return path.startswith("pose.bones[") and path.endswith("].location")


def _has_bone_location_curves(fcs):
    return any(_is_bone_location(fc.data_path) for fc in fcs)


def _action_owners(o, want):
    """(fcurve owner, frame range, action name) for the active action, NLA strip actions and every
    other action whose F-Curves all resolve on `o` (what the FBX 'all actions' bake would use),
    filtered by want(fcurves)."""
    res = []
    ad = o.animation_data
    acts = []
    if ad is not None:
        if ad.action is not None:
            acts.append((ad.action, getattr(ad, "action_slot", None)))
        for tr in ad.nla_tracks:
            for st in tr.strips:
                if st.action is not None:
                    acts.append((st.action, getattr(st, "action_slot", None)))
    if ad is not None or o.type == 'ARMATURE':
        for a in bpy.data.actions:
            if all(a != x[0] for x in acts):
                acts.append((a, "validate"))
    seen = set()
    for act, slot in acts:
        for owner, oslot in action_channelbags(act):
            if slot not in (None, "validate") and oslot is not None and oslot != slot:
                continue
            fcs = list(owner.fcurves)
            if not fcs or not want(fcs):
                continue
            if slot == "validate" and not _paths_resolve(o, fcs):
                continue
            k = owner.as_pointer()
            if k in seen:
                continue
            seen.add(k)
            res.append((owner, tuple(act.frame_range), act.name))
    return res


def _resample_transform_channels(o, owner, frame_range, static, L, Qinv):
    """Rewrite object-level transform F-Curves so basis'(t) = L @ basis(t) @ Qinv (sampled per frame)."""
    fcs = {}
    for fc in owner.fcurves:
        if fc.data_path in TRANSFORM_PATHS:
            fcs[(fc.data_path, fc.array_index)] = fc
    if not fcs:
        return 0
    f0, f1 = frame_range
    frames = list(range(int(math.floor(f0)), int(math.ceil(f1)) + 1)) or [int(f0)]
    mode = static["rotation_mode"]
    samples = []
    prev_e, prev_q = None, None
    for t in frames:
        loc = Vector(static["location"])
        for i in range(3):
            fc = fcs.get(("location", i))
            if fc is not None:
                loc[i] = fc.evaluate(t)
        sca = Vector(static["scale"])
        for i in range(3):
            fc = fcs.get(("scale", i))
            if fc is not None:
                sca[i] = fc.evaluate(t)
        if mode == 'QUATERNION':
            q = Quaternion(static["rotation_quaternion"])
            for i in range(4):
                fc = fcs.get(("rotation_quaternion", i))
                if fc is not None:
                    q[i] = fc.evaluate(t)
            q.normalize()
        elif mode == 'AXIS_ANGLE':
            aa = list(static["rotation_axis_angle"])
            for i in range(4):
                fc = fcs.get(("rotation_axis_angle", i))
                if fc is not None:
                    aa[i] = fc.evaluate(t)
            q = Quaternion(Vector(aa[1:4]), aa[0])
        else:
            e = Euler(static["rotation_euler"], mode)
            for i in range(3):
                fc = fcs.get(("rotation_euler", i))
                if fc is not None:
                    e[i] = fc.evaluate(t)
            q = e.to_quaternion()
        M = Matrix.LocRotScale(loc, q, sca)
        loc2, q2, sca2 = (L @ M @ Qinv).decompose()
        if mode == 'QUATERNION':
            if prev_q is not None and prev_q.dot(q2) < 0:
                q2 = -q2
            prev_q = q2
            rot = list(q2)
        elif mode == 'AXIS_ANGLE':
            ax, ang = q2.to_axis_angle()
            rot = [ang, ax[0], ax[1], ax[2]]
        else:
            e2 = q2.to_euler(mode, prev_e) if prev_e is not None else q2.to_euler(mode)
            prev_e = e2
            rot = list(e2)
        samples.append((t, list(loc2), rot, list(sca2)))
    coll = owner.fcurves
    for fc in list(fcs.values()):
        coll.remove(fc)
    rot_path = {"QUATERNION": "rotation_quaternion", "AXIS_ANGLE": "rotation_axis_angle"}.get(mode, "rotation_euler")
    channels = [("location", i, lambda s, i=i: s[1][i]) for i in range(3)]
    channels += [(rot_path, i, lambda s, i=i: s[2][i]) for i in range(4 if rot_path != "rotation_euler" else 3)]
    channels += [("scale", i, lambda s, i=i: s[3][i]) for i in range(3)]
    for path, idx, getter in channels:
        fc = coll.new(path, index=idx)
        kp = fc.keyframe_points
        kp.add(len(samples))
        co = []
        for s in samples:
            co.extend((float(s[0]), float(getter(s))))
        kp.foreach_set("co", co)
        for k in kp:
            k.interpolation = 'LINEAR'
        fc.update()
    return len(samples)


def _scale_bone_locations(arm, s, done):
    """Bone-local translations are measured in armature units: scale them with the baked rest pose."""
    n = 0
    for owner, _fr, _name in _action_owners(arm, _has_bone_location_curves):
        k = owner.as_pointer()
        if k in done:
            continue
        done.add(k)
        for fc in owner.fcurves:
            if not _is_bone_location(fc.data_path):
                continue
            kps = fc.keyframe_points
            cnt = len(kps)
            if cnt:
                for attr in ("co", "handle_left", "handle_right"):
                    arr = [0.0] * (cnt * 2)
                    kps.foreach_get(attr, arr)
                    arr[1::2] = [v * s for v in arr[1::2]]
                    kps.foreach_set(attr, arr)
                fc.update()
            n += 1
    for pb in arm.pose.bones:
        pb.location = pb.location * s
    return n


def _mat_close(a, b, eps=1e-6):
    return all(abs(a[i][j] - b[i][j]) < eps for i in range(4) for j in range(4))


def bake_transforms(objs, warnings, rotation_quat=None, axis_fix=True, bake_scale=True):
    """Bake (optional) user rotation, every object's world rotation, positive uniform scale and the
    Unity axis fix into the data of `objs` (session only).  Call after bake_modifiers: local-space
    modifiers such as Mirror would otherwise change meaning.  Returns an info dict."""
    I4 = Matrix.Identity(4)
    R = I4
    info = {"rotationQuat": None, "axisFix": bool(axis_fix), "roots": [], "baked": [], "keptTransform": [],
            "bakedScale": {}, "resampledActions": [], "scaledBoneLocationCurves": 0}
    if rotation_quat is not None:
        q = Quaternion([float(v) for v in rotation_quat])
        if q.magnitude < 1e-9:
            raise BBError("rotationQuat must not be zero")
        q.normalize()
        info["rotationQuat"] = [q.w, q.x, q.y, q.z]
        info["angleDeg"] = math.degrees(q.angle)
        info["axis"] = list(q.axis) if q.angle > 1e-9 else [0.0, 0.0, 1.0]
        if q.angle > 1e-7:
            R = q.to_matrix().to_4x4()
    F = UNITY_AXIS_FIX if axis_fix else I4
    vl = bpy.context.view_layer
    oset = set(objs)
    order = sorted(objs, key=lambda ob: (object_depth(ob), ob.name))
    static = {}
    for o in order:
        static[o] = {"location": o.location.copy(), "scale": o.scale.copy(), "rotation_mode": o.rotation_mode,
                     "rotation_euler": o.rotation_euler.copy(), "rotation_quaternion": o.rotation_quaternion.copy(),
                     "rotation_axis_angle": tuple(o.rotation_axis_angle), "parentinv": o.matrix_parent_inverse.copy()}
        if any(abs(v) > 1e-9 for v in o.delta_location) or any(abs(v - 1.0) > 1e-9 for v in o.delta_scale) \
                or o.delta_rotation_quaternion.angle > 1e-9 or any(abs(v) > 1e-9 for v in o.delta_rotation_euler):
            warnings.append("%s has delta transforms; they are kept as-is" % o.name)
    anim, owned = {}, set()
    for o in order:
        lst = []
        for ow in _action_owners(o, _has_transform_curves):
            k = ow[0].as_pointer()
            if k in owned:
                warnings.append("Action '%s' animates several objects; its object transforms follow the first one" % ow[2])
                continue
            owned.add(k)
            lst.append(ow)
        anim[o] = lst
    roots = [o for o in order if o.parent is None or o.parent not in oset]
    info["roots"] = [o.name for o in roots]
    if not _mat_close(R, I4):
        for o in roots:
            o.matrix_world = R @ o.matrix_world
        vl.update()
    W = {o: o.matrix_world.copy() for o in order}
    Q, S, arm_scale = {}, {}, {}
    done_data = {}
    arms_changed = []
    for o in order:
        _loc, rot, sca = W[o].decompose()
        positive = min(sca) > 0
        uniform = positive and (max(sca) - min(sca)) <= 1e-5 * max(sca)
        Sm = I4
        s_u = 1.0
        if bake_scale and positive:
            if uniform and o.type in ('MESH', 'CURVE', 'SURFACE', 'LATTICE', 'ARMATURE', 'EMPTY'):
                s_u = float(sca[0])
                if abs(s_u - 1.0) > 1e-6:
                    Sm = Matrix.Scale(s_u, 4)
                else:
                    s_u = 1.0
            elif not uniform and o.type in ('MESH', 'CURVE', 'SURFACE', 'LATTICE'):
                Sm = Matrix.Diagonal((sca[0], sca[1], sca[2], 1.0))
            elif not uniform:
                warnings.append("%s keeps its non-uniform scale (cannot be baked into a %s)" % (o.name, o.type.lower()))
        elif bake_scale and not positive:
            warnings.append("%s has negative scale; its scale is kept on the transform" % o.name)
        Qm = F @ rot.to_matrix().to_4x4() @ Sm
        ok = True
        d = o.data
        if o.type == 'EMPTY':
            ok = o.instance_type != 'COLLECTION'
        elif d is None or o.type not in ('MESH', 'CURVE', 'SURFACE', 'LATTICE', 'META', 'ARMATURE'):
            ok = False
        elif o.type == 'META' and not _mat_close(Sm, I4):
            Sm = I4
            Qm = F @ rot.to_matrix().to_4x4()
        if ok and d is not None:
            prev = done_data.get(d.as_pointer())
            if prev is not None and not _mat_close(prev, Qm):
                o.data = d.copy()
                d = o.data
                prev = None
            if prev is None:
                if o.type in ('MESH', 'CURVE', 'SURFACE', 'LATTICE'):
                    d.transform(Qm, shape_keys=True)
                else:
                    d.transform(Qm)
                if o.type == 'MESH':
                    d.update()
                done_data[d.as_pointer()] = Qm
            if o.type == 'ARMATURE':
                # Armature.transform() does not tag the depsgraph: without this the pose matrices stay stale
                d.update_tag()
                o.update_tag(refresh={'OBJECT', 'DATA'})
                arms_changed.append(o)
        if not ok:
            Qm, Sm, s_u = I4, I4, 1.0
            info["keptTransform"].append(o.name)
            if o.type not in ('CAMERA', 'LIGHT'):
                warnings.append("%s (%s) keeps its transform; its data cannot be rotated" % (o.name, o.type))
        else:
            info["baked"].append(o.name)
        if o.type == 'EMPTY' and ok and s_u != 1.0:
            o.empty_display_size *= s_u
        if s_u != 1.0 or not _mat_close(Sm, I4):
            info["bakedScale"][o.name] = [float(Sm[0][0]), float(Sm[1][1]), float(Sm[2][2])]
        if o.type == 'ARMATURE' and s_u != 1.0:
            arm_scale[o] = s_u
        Q[o], S[o] = Qm, Sm
    vl.update()
    for a in arms_changed:
        # belt and braces: force a pose rebuild from the new rest pose (seen stale on 5.2 otherwise)
        pp = a.data.pose_position
        a.data.pose_position = 'REST' if pp == 'POSE' else 'POSE'
        vl.update()
        a.data.pose_position = pp
        vl.update()
    for o in order:  # parents first: the setter uses the parent's already-updated world matrix
        o.matrix_world = W[o] @ Q[o].inverted()
    done_loc = set()
    for a, s in arm_scale.items():
        info["scaledBoneLocationCurves"] += _scale_bone_locations(a, s, done_loc)
    for o in order:
        if not anim[o]:
            continue
        PI = static[o]["parentinv"]
        if o in roots:
            Lm = R
        elif o.parent_type == 'BONE':
            Lm = PI.inverted_safe() @ S.get(o.parent, I4) @ PI
        else:
            Lm = PI.inverted_safe() @ Q.get(o.parent, I4) @ PI
        for owner, frange, act_name in anim[o]:
            n = _resample_transform_channels(o, owner, frange, static[o], Lm, Q[o].inverted())
            info["resampledActions"].append({"object": o.name, "action": act_name, "frames": n})
    vl.update()
    try:
        bpy.context.scene.frame_set(bpy.context.scene.frame_current)
    except Exception:
        pass
    return info


def apply_rotation(objs, quat_wxyz, warnings, animations="all"):
    """Backwards-compatible wrapper: user rotation only (no axis fix / scale bake)."""
    return bake_transforms(objs, warnings, quat_wxyz, axis_fix=False, bake_scale=False)

# --------------------------------------------------------------------------------------------
# Unity FBX export (shared by export_fbx.py and organize.py)
# --------------------------------------------------------------------------------------------

FBX_DEFAULTS = {
    "targetSizeCm": None, "targetAxis": "height", "textures": "folder", "texturesDir": "Textures",
    "animations": "all", "applyModifiers": True, "onlyVisible": True, "pbrManifest": True,
    "packUnityMaskMaps": False, "rotationQuat": None, "deformBonesOnly": False, "unityAxisFix": True,
    "textureNames": "standard", "assetName": None,
}


def fbx_options(raw):
    o = dict(FBX_DEFAULTS)
    for k, v in (raw or {}).items():
        if k in o and v is not None:
            o[k] = v
        elif k in o:
            o[k] = FBX_DEFAULTS[k] if k not in ("targetSizeCm", "rotationQuat") else None
    o["textures"] = str(o["textures"]).lower()
    if o["textures"] not in ("folder", "embed", "none"):
        raise BBError("textures must be folder, embed or none")
    o["animations"] = str(o["animations"]).lower()
    if o["animations"] not in ("all", "active", "none"):
        raise BBError("animations must be all, active or none")
    o["textureNames"] = str(o["textureNames"] or "standard").lower()
    if o["textureNames"] not in ("standard", "original"):
        raise BBError("textureNames must be standard or original")
    o["targetAxis"] = str(o["targetAxis"]).lower()
    if o["targetAxis"] not in ("height", "width", "depth", "max"):
        raise BBError("targetAxis must be height, width, depth or max")
    td = str(o["texturesDir"] or "Textures").replace("\\", "/").strip("/")
    if not td or ".." in td.split("/") or os.path.isabs(td) or ":" in td:
        raise BBError("texturesDir must be a simple relative folder name")
    o["texturesDir"] = td
    if o["targetSizeCm"] is not None:
        try:
            o["targetSizeCm"] = float(o["targetSizeCm"])
        except Exception:
            raise BBError("targetSizeCm must be a number or null")
        if not (o["targetSizeCm"] > 0):
            raise BBError("targetSizeCm must be > 0")
    if o["rotationQuat"] is not None:
        rq = o["rotationQuat"]
        if not isinstance(rq, (list, tuple)) or len(rq) != 4:
            raise BBError("rotationQuat must be [w, x, y, z]")
        o["rotationQuat"] = [float(v) for v in rq]
    return o


def _vec_xyz(d):
    return {"x": d["x"], "y": d["y"], "z": d["z"]}


def export_unity_fbx(out_path, opts, warnings, prog=None, allowed_roots=None, search_roots=()):
    """Prepare the current session's scene and write a Unity-ready FBX.  Never saves the .blend."""
    prog = prog or Progress(0.0, 1.0)
    scene = bpy.context.scene
    out_path = os.path.abspath(out_path)
    if not out_path.lower().endswith(".fbx"):
        out_path += ".fbx"
    out_dir = os.path.dirname(out_path)
    os.makedirs(out_dir, exist_ok=True)
    allowed = list(allowed_roots or [out_dir])
    _check_dest(out_path, allowed)
    tex_dir = os.path.join(out_dir, *opts["texturesDir"].split("/"))
    res = {"fbx": out_path, "textures": [], "missing": [], "warnings": warnings}

    # units: Unity expects 1 unit = 1 m; a unit-less scene is treated as metres
    us = scene.unit_settings
    if us.system == 'NONE':
        us.system = 'METRIC'
        us.scale_length = 1.0
        warnings.append("Scene had no unit system; treated 1 Blender unit as 1 metre")
    unit_m = unit_to_meters()

    prog(0.02, "Collecting objects")
    objs = export_object_set(bool(opts["onlyVisible"]))
    geo = [o for o in objs if o.type in GEOMETRY_TYPES]
    if not geo and not any(o.type == 'ARMATURE' for o in objs):
        raise BBError("Nothing to export: no %sgeometry or armature in the scene" % ("visible " if opts["onlyVisible"] else ""))

    def measure():
        if geo:
            a, b, _s = measure_world_aabb(geo)
            if a is not None:
                return a, b
        return measure_bones_aabb(objs)   # animation-only file: size of the skeleton

    hidden_left = make_exportable(objs)
    if hidden_left:
        warnings.append("Could not make visible for export: %s" % ", ".join(hidden_left[:10]))
    has_armature = any(o.type == 'ARMATURE' for o in objs)
    res["objects"] = {"total": len(objs), "meshes": sum(1 for o in objs if o.type == 'MESH'),
                      "armatures": [o.name for o in objs if o.type == 'ARMATURE']}

    if opts["applyModifiers"]:
        prog(0.05, "Applying modifiers")
        res["modifiers"] = bake_modifiers(geo, warnings, prog.sub(0.05, 0.25))

    # user rotation + Unity axis fix + root scale -> Unity sees rotation 0 / scale 1 on every root node
    prog(0.26, "Baking transforms")
    mn0, mx0 = measure()
    binfo = bake_transforms(objs, warnings, opts.get("rotationQuat"), axis_fix=bool(opts.get("unityAxisFix", True)),
                            bake_scale=True)
    mn1, mx1 = measure()
    res["transformBake"] = {k: binfo[k] for k in ("axisFix", "roots", "baked", "keptTransform", "bakedScale",
                                                  "resampledActions", "scaledBoneLocationCurves")}
    if binfo.get("rotationQuat") is not None:
        res["rotationApplied"] = binfo["rotationQuat"]
        res["rotationInfo"] = {"quat": binfo["rotationQuat"], "angleDeg": binfo.get("angleDeg"),
                               "axis": binfo.get("axis"), "roots": binfo["roots"],
                               "aabbBeforeM": yup_aabb(mn0, mx0, unit_m), "aabbAfterM": yup_aabb(mn1, mx1, unit_m)}
    else:
        res["rotationApplied"] = None

    prog(0.30, "Preparing materials")
    mats = materials_of(geo)
    converted = []
    for m in mats:
        r = make_material_exportable(m)
        if r:
            converted.append(r)
    if converted:
        res["convertedMaterials"] = converted

    prog(0.33, "Measuring")
    mn, mx = measure()
    res["measuredFrom"] = "geometry" if geo else "bones"
    size_before = {k: v * 100.0 for k, v in yup_size(mn, mx, unit_m).items()}
    factor = 1.0
    if opts["targetSizeCm"]:
        axis = {"height": "y", "width": "x", "depth": "z"}.get(opts["targetAxis"])
        cur = max(size_before.values()) if opts["targetAxis"] == "max" else size_before[axis]
        if cur <= 1e-9:
            raise BBError("Cannot scale: the model has no extent along %s" % opts["targetAxis"])
        factor = float(opts["targetSizeCm"]) / cur
    gs, extra = factor, 1.0
    if gs < 0.001:
        extra, gs = gs / 0.001, 0.001
    elif gs > 1000.0:
        extra, gs = gs / 1000.0, 1000.0
    saved_scale_length = us.scale_length
    if extra != 1.0:
        us.scale_length = us.scale_length * extra
    expected_usf = 100.0 * us.scale_length * gs
    res["scaleFactor"] = factor
    res["sizeCmBefore"] = size_before
    res["sizeCmAfter"] = {k: v * factor for k, v in size_before.items()}

    # textures
    prog(0.36, "Collecting textures")
    imgs = images_of_materials(mats)
    stager = None
    rel_of = {}
    plan = {}
    if opts["textureNames"] == "standard" and opts["textures"] in ("folder", "embed"):
        plan = texture_name_plan(mats, opts.get("assetName") or asset_from_filename(out_path))
        res["textureNames"] = {k: v["stem"] for k, v in plan.items()}
    if opts["textures"] in ("folder", "embed"):
        if opts["textures"] == "folder":
            stage_dir = tex_dir
        else:
            import tempfile
            stage_dir = tempfile.mkdtemp(prefix="bb_fbx_tex_")
        stager = TextureStager(stage_dir, allowed + ([stage_dir] if opts["textures"] == "embed" else []),
                               search_roots=search_roots)
        for img in imgs:
            p = image_abs_path(img)
            if p and img.packed_file is None and is_under(p, stage_dir) and os.path.isfile(p):
                stager.reserve_existing(p)
        written = set()
        for i, img in enumerate(imgs):
            if i % 4 == 0:
                prog(0.36 + 0.14 * i / max(1, len(imgs)), "Textures: %s" % img.name)
            dest = stager.stage(img, stem=(plan.get(img.name) or {}).get("stem"))
            if dest is None:
                if opts["textures"] == "folder" and img.source in ('FILE', 'TILED') and img.packed_file is None:
                    # missing file: reference it inside the Textures folder so dropping it there later works
                    base = os.path.basename((img.filepath or img.name).replace("\\", "/")) or img.name
                    stem, ext = os.path.splitext(base)
                    ghost = os.path.join(tex_dir, sanitize_stem(stem) + (ext or ".png"))
                    img.filepath = ghost
                    rel_of[img.name] = os.path.relpath(ghost, out_dir).replace("\\", "/")
                continue
            img.filepath = dest
            if opts["textures"] == "folder":
                rel_of[img.name] = os.path.relpath(dest, out_dir).replace("\\", "/")
            else:
                rel_of[img.name] = os.path.basename(dest)
            written.add(rel_of[img.name])
        res["missing"] = stager.missing
        if stager.found:
            res["relinked"] = stager.found
        for s in stager.skipped:
            warnings.append("%s: %s" % (s["image"], s["reason"]))
        res["textures"] = sorted(written)
    else:
        for img in imgs:
            if img.source == 'VIEWER':
                continue
            if not image_available(img):
                res["missing"].append({"image": img.name, "path": img.filepath})
            rel_of[img.name] = os.path.basename(image_abs_path(img) or img.name)
    for m in res["missing"]:
        warnings.append("Missing texture: %s (%s)" % (m["image"], m["path"]))

    # animations
    anim = opts["animations"]
    if anim == "all":
        for o in objs:
            if o.type == 'ARMATURE' and o.animation_data is None and len(bpy.data.actions):
                o.animation_data_create()
    frame_saved = (scene.frame_start, scene.frame_end)
    if anim == "active":
        acts = [o.animation_data.action for o in objs if o.animation_data and o.animation_data.action]
        if acts:
            fr = acts[0].frame_range
            scene.frame_start, scene.frame_end = int(math.floor(fr[0])), int(math.ceil(fr[1]))

    select_only(objs)
    kw = dict(
        filepath=out_path, check_existing=False, use_selection=True, use_visible=False,
        use_active_collection=False, global_scale=gs, apply_unit_scale=True,
        apply_scale_options='FBX_SCALE_ALL', use_space_transform=True,
        bake_space_transform=(not has_armature) and not opts.get("unityAxisFix", True), object_types={'ARMATURE', 'EMPTY', 'MESH', 'OTHER'},
        use_mesh_modifiers=bool(opts["applyModifiers"]), use_mesh_modifiers_render=True,
        mesh_smooth_type='FACE', use_subsurf=False, use_mesh_edges=False, use_tspace=False,
        use_triangles=False, use_custom_props=False, add_leaf_bones=False, primary_bone_axis='Y',
        secondary_bone_axis='X', use_armature_deform_only=bool(opts.get("deformBonesOnly")),
        armature_nodetype='NULL', bake_anim=(anim != "none"), bake_anim_use_all_bones=True,
        bake_anim_use_nla_strips=False, bake_anim_use_all_actions=(anim == "all"),
        bake_anim_force_startend_keying=True, bake_anim_step=1.0, bake_anim_simplify_factor=1.0,
        path_mode={"folder": 'RELATIVE', "embed": 'COPY', "none": 'STRIP'}[opts["textures"]],
        embed_textures=(opts["textures"] == "embed"), batch_mode='OFF', use_batch_own_dir=False,
        use_metadata=True, axis_forward='-Z', axis_up='Y', colors_type='SRGB',
    )
    prog(0.52, "Writing FBX")
    t0 = time.time()
    try:
        r, dropped = call_op(bpy.ops.export_scene.fbx, **kw)
    finally:
        us.scale_length = saved_scale_length
        scene.frame_start, scene.frame_end = frame_saved
        if opts["textures"] == "embed" and stager is not None:
            shutil.rmtree(stager.dest_dir, ignore_errors=True)
    if 'FINISHED' not in r or not os.path.isfile(out_path):
        raise BBError("FBX export failed")
    res["exportSec"] = round(time.time() - t0, 2)
    res["sizeBytes"] = os.path.getsize(out_path)
    if dropped:
        res["droppedOptions"] = dropped

    prog(0.85, "Verifying FBX")
    try:
        fi = fbx_read_info(out_path, details=True)
    except Exception as e:
        fi = {}
        warnings.append("Could not read back the FBX header: %s" % e)
    usf = fi.get("unitScaleFactor")
    res["unitScaleFactor"] = usf
    res["expectedUnitScaleFactor"] = expected_usf
    if usf is not None and abs(usf - expected_usf) > 1e-4 * max(1.0, abs(expected_usf)):
        warnings.append("UnitScaleFactor %.6g differs from the expected %.6g" % (usf, expected_usf))
    res["fbxInfo"] = {"version": fi.get("version"), "upAxis": fi.get("upAxis"), "frontAxis": fi.get("frontAxis"),
                      "takes": fi.get("takes", []), "objectCounts": fi.get("objectCounts", {}),
                      "textureRefs": sorted(set(v.get("relativeFilename", "") for v in fi.get("videos", []))),
                      "embeddedTextures": sum(1 for v in fi.get("videos", []) if v.get("embeddedBytes"))}

    # humanoid
    hum = None
    for o in objs:
        if o.type == 'ARMATURE':
            g = guess_humanoid(o)
            if hum is None or (g["humanoid"] and not hum["humanoid"]):
                hum = dict(g, armature=o.name)
    res["humanoid"] = bool(hum and hum["humanoid"])

    if opts["pbrManifest"]:
        prog(0.9, "Writing material manifest")
        man_path = os.path.splitext(out_path)[0] + ".materials.json"
        _check_dest(man_path, allowed)
        manifest = build_manifest(mats, rel_of, res, hum, opts, tex_dir, out_dir, allowed, warnings,
                                  set(c["material"] for c in converted), plan)
        with open(man_path, "w", encoding="utf-8") as f:
            json.dump(json_clean(manifest), f, indent=2, ensure_ascii=False)
        res["manifest"] = man_path
    else:
        res["manifest"] = None
    prog(0.98, "FBX done")
    return res


def _tex_ref(entry, rel_of):
    if not entry:
        return None
    return rel_of.get(entry["image"])


def build_manifest(mats, rel_of, res, hum, opts, tex_dir, out_dir, allowed, warnings, converted_names=(), plan=None):
    out = {"version": 1, "generator": "Meshbox (Blender %s)" % bpy.app.version_string,
           "fbx": os.path.basename(res["fbx"]), "unitScaleFactor": res.get("unitScaleFactor"),
           "scaleFactor": res.get("scaleFactor"), "humanoid": bool(hum and hum["humanoid"]),
           "humanoidBones": hum["matched"] if hum else {}, "texturesDir": opts["texturesDir"],
           "materials": []}
    for mat in mats:
        a = analyze_material(mat)
        conv = mat.name in converted_names
        e = {"name": mat.name, "usesPrincipled": a["usesPrincipled"] and not conv,
             "shader": "custom" if conv else a.get("shader"), "converted": conv,
             "doubleSided": a["doubleSided"],
             "baseColor": {"factor": a["baseColor"]["factor"], "texture": _tex_ref(a["baseColor"]["texture"], rel_of)},
             "normal": None, "metallic": None, "roughness": None, "emission": None, "alpha": None,
             "occlusion": None}
        if a["normal"]:
            e["normal"] = {"texture": _tex_ref(a["normal"]["texture"], rel_of), "strength": a["normal"]["strength"],
                           "kind": a["normal"].get("kind")}
        for role in ("metallic", "roughness"):
            t = a[role]["texture"]
            e[role] = {"factor": a[role]["factor"], "texture": _tex_ref(t, rel_of),
                       "channel": t.get("channel") if t else None}
        em = a["emission"]
        e["emission"] = {"color": em["color"], "strength": em["strength"], "texture": _tex_ref(em["texture"], rel_of)}
        al = a["alpha"]
        e["alpha"] = {"mode": al["mode"], "factor": al.get("factor"), "texture": _tex_ref(al.get("texture"), rel_of),
                      "channel": (al.get("texture") or {}).get("channel")}
        if al.get("cutoff") is not None:
            e["alpha"]["cutoff"] = al["cutoff"]
        if a["occlusion"]:
            t = a["occlusion"]["texture"]
            e["occlusion"] = {"texture": _tex_ref(t, rel_of), "channel": t.get("channel") if t else None}
        if opts["packUnityMaskMaps"] and (a["metallic"]["texture"] or a["roughness"]["texture"]):
            try:
                stem = None
                if opts.get("textureNames") == "standard":
                    asset = texture_asset_name(opts.get("assetName") or asset_from_filename(res["fbx"]))
                    part, _g = _clean_part(mat.name, {t.lower() for t in _name_tokens(opts.get("assetName") or "")} | {asset.lower()}, any_map=True)
                    stem = texture_stem(asset, part, "MetallicSmoothness")
                p = pack_metallic_smoothness(mat.name, a, tex_dir, allowed, stem)
                if p:
                    e["metallicSmoothness"] = os.path.relpath(p, out_dir).replace("\\", "/")
                    res.setdefault("textures", []).append(e["metallicSmoothness"])
            except Exception as ex:
                warnings.append("%s: could not pack MetallicSmoothness map: %s" % (mat.name, ex))
        out["materials"].append(e)
    return out


def _image_pixels(img, w, h):
    """float32 array (h, w, 4) of an image, resampled to w x h when needed (works on a copy)."""
    src = img
    tmp = None
    if tuple(img.size) != (w, h):
        tmp = img.copy()
        tmp.scale(w, h)
        src = tmp
    try:
        px = np.empty(w * h * 4, dtype=np.float32)
        src.pixels.foreach_get(px)
        return px.reshape(h, w, 4)
    finally:
        if tmp is not None:
            bpy.data.images.remove(tmp)


def pack_metallic_smoothness(mat_name, a, tex_dir, allowed, stem=None):
    """Write <Material>_MetallicSmoothness.png (or <stem>.png): RGB = metallic, A = 1 - roughness."""
    if np is None:
        raise BBError("numpy unavailable")
    srcs = {}
    for role in ("metallic", "roughness"):
        t = a[role]["texture"]
        img = bpy.data.images.get(t["image"]) if t else None
        if img is not None and (img.size[0] == 0 or img.size[1] == 0):
            img = None
        srcs[role] = (img, (t or {}).get("channel"), a[role]["factor"])
    sizes = [tuple(s[0].size) for s in srcs.values() if s[0] is not None]
    if not sizes:
        return None
    w, h = max(sizes, key=lambda s: s[0] * s[1])
    chan = {'R': 0, 'G': 1, 'B': 2, 'A': 3}

    def plane(role, default):
        img, ch, fac = srcs[role]
        if img is None:
            return np.full((h, w), float(fac if fac is not None else default), dtype=np.float32)
        return _image_pixels(img, w, h)[:, :, chan.get(ch or 'R', 0)]

    metal = plane("metallic", 0.0)
    rough = plane("roughness", 0.5)
    outp = np.empty((h, w, 4), dtype=np.float32)
    outp[:, :, 0] = metal
    outp[:, :, 1] = metal
    outp[:, :, 2] = metal
    outp[:, :, 3] = 1.0 - rough
    np.clip(outp, 0.0, 1.0, out=outp)
    path = os.path.join(tex_dir, (sanitize_stem(stem) if stem else sanitize_stem(mat_name, "Material") + "_MetallicSmoothness") + ".png")
    _check_dest(path, allowed)
    os.makedirs(tex_dir, exist_ok=True)
    im = bpy.data.images.new("BB_MS_" + mat_name, w, h, alpha=True, float_buffer=False)
    try:
        try:
            im.colorspace_settings.name = 'Non-Color'
        except Exception:
            pass
        im.alpha_mode = 'STRAIGHT'
        im.pixels.foreach_set(outp.ravel())
        im.filepath_raw = path
        im.file_format = 'PNG'
        im.save()
    finally:
        bpy.data.images.remove(im)
    return path
