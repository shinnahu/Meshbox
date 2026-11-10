bl_info = {
    "name": "Save Milestone",
    "author": "Meshbox",
    "version": (1, 0, 0),
    "blender": (3, 6, 0),
    "location": "File > Save Milestone...",
    "description": "Save numbered, dated milestone copies of the current .blend into a Versions folder "
                   "(with history.json), optionally exporting a Unity-ready FBX",
    "category": "System",
}

# Single-file legacy add-on (Blender 3.6 - 5.x).  Self-contained on purpose: it does not import
# anything from the Meshbox install folder.

import datetime
import json
import os
import re
import shutil
import subprocess
import sys
import unicodedata

import bpy
from bpy.props import BoolProperty, StringProperty

VERSIONS_DIR = "Versions"
_SUFFIX_WORDS = ("final", "wip", "applied", "backup", "bak", "old", "new", "copy", "edit", "edited",
                 "fixed", "fix", "latest", "done", "test")


# ------------------------------------------------------------------------------------------------
# naming helpers
# ------------------------------------------------------------------------------------------------

def asset_name_from_stem(stem):
    """'Hero54Applied' -> 'Hero', 'dog3final' -> 'dog', 'Hero_v5_final' -> 'Hero'."""
    m = re.match(r"^(.*?[^\d\s_.\-])(?:[\s_.\-]+v(?:er(?:sion)?)?)?[\s_.\-]*\d", stem, re.I)
    name = m.group(1) if m else stem
    if not m:
        words = "|".join(_SUFFIX_WORDS)
        name = re.sub(r"[\s_.\-]+(?:%s)$" % words, "", name, flags=re.I)
    name = name.rstrip(" _.-")
    return name if len(name) >= 1 else stem


def slugify(text, limit=40):
    s = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode("ascii").lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s[:limit].strip("-")


def safe_file_part(text):
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", text).strip(" .") or "Asset"


def versions_dir_for(blend_path):
    d = os.path.dirname(blend_path)
    # a milestone that was opened from the Versions folder keeps saving next to itself
    if os.path.basename(d).lower() == VERSIONS_DIR.lower():
        return d
    return os.path.join(d, VERSIONS_DIR)


def load_history(vdir):
    path = os.path.join(vdir, "history.json")
    if not os.path.isfile(path):
        return [], path, None
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            return data, path, None
        raise ValueError("history.json is not a list")
    except Exception as e:  # keep the broken file, start a new list
        stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
        bad = os.path.join(vdir, "history.corrupt-%s.json" % stamp)
        try:
            os.replace(path, bad)
        except OSError:
            pass
        return [], path, "history.json was unreadable (%s); kept as %s" % (e, os.path.basename(bad))


def next_version(vdir, asset, history):
    rx = re.compile(r"^%s_v(\d+)_" % re.escape(asset), re.I)
    n = 0
    if os.path.isdir(vdir):
        for f in os.listdir(vdir):
            m = rx.match(f)
            if m:
                n = max(n, int(m.group(1)))
    for e in history:
        try:
            if str(e.get("assetName", asset)).lower() == asset.lower():
                n = max(n, int(e.get("version", 0)))
        except Exception:
            pass
    return n + 1


def milestone_target(blend_path, note):
    stem = os.path.splitext(os.path.basename(blend_path))[0]
    asset = safe_file_part(asset_name_from_stem(stem))
    vdir = versions_dir_for(blend_path)
    history, hpath, warn = load_history(vdir) if os.path.isdir(vdir) else ([], os.path.join(vdir, "history.json"), None)
    ver = next_version(vdir, asset, history)
    date = datetime.date.today().isoformat()
    slug = slugify(note)
    name = "%s_v%03d_%s%s.blend" % (asset, ver, date, ("_" + slug) if slug else "")
    return {"asset": asset, "dir": vdir, "version": ver, "file": name, "path": os.path.join(vdir, name),
            "history": history, "historyPath": hpath, "warning": warn}


def ntfs_compress(path):
    """Fire-and-forget NTFS (WOF/LZX) compression of the copy; silently ignored when unavailable."""
    if sys.platform != "win32":
        return False
    try:
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
        subprocess.Popen(["compact.exe", "/c", "/exe:lzx", "/q", path], creationflags=flags,
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         close_fds=True)
        return True
    except Exception:
        return False


# ------------------------------------------------------------------------------------------------
# minimal Unity FBX export (duplicated on purpose; mirrors the Meshbox settings)
# ------------------------------------------------------------------------------------------------

def _filtered(op, kwargs):
    try:
        keys = set(op.get_rna_type().properties.keys())
    except Exception:
        return kwargs
    return {k: v for k, v in kwargs.items() if k in keys}


def export_unity_fbx(context, path):
    """Export visible objects (+ the armatures deforming them, temporarily unhidden) to a Unity FBX.
    The scene is restored afterwards; nothing is applied to the data."""
    scene = context.scene
    vl = context.view_layer
    visible = [o for o in vl.objects if o.visible_get()]
    needed = []
    for o in visible:
        for m in getattr(o, "modifiers", ()):
            if m.type == 'ARMATURE' and getattr(m, "object", None) is not None and m.object not in visible \
                    and m.object not in needed:
                needed.append(m.object)
        p = o.parent
        while p is not None:
            if p not in visible and p not in needed:
                needed.append(p)
            p = p.parent
    restore = []
    for o in needed:
        st = {"obj": o, "hide_viewport": o.hide_viewport, "hide": o.hide_get() if vl.objects.get(o.name) else None,
              "linked": False}
        try:
            if vl.objects.get(o.name) is None or not o.visible_get():
                o.hide_viewport = False
                if vl.objects.get(o.name) is not None:
                    o.hide_set(False)
                if not o.visible_get() and scene.collection.objects.get(o.name) is None:
                    scene.collection.objects.link(o)
                    st["linked"] = True
                    o.hide_set(False)
        except Exception:
            pass
        restore.append(st)
    has_arm = any(o.type == 'ARMATURE' for o in visible + needed)
    kwargs = dict(
        filepath=path, check_existing=False, use_selection=False, use_visible=True,
        use_active_collection=False, global_scale=1.0, apply_unit_scale=True,
        apply_scale_options='FBX_SCALE_ALL', use_space_transform=True, bake_space_transform=not has_arm,
        object_types={'ARMATURE', 'EMPTY', 'MESH', 'OTHER'}, use_mesh_modifiers=True,
        mesh_smooth_type='FACE', use_tspace=False, use_triangles=False, add_leaf_bones=False,
        primary_bone_axis='Y', secondary_bone_axis='X', armature_nodetype='NULL', bake_anim=True,
        bake_anim_use_all_bones=True, bake_anim_use_nla_strips=False, bake_anim_use_all_actions=True,
        bake_anim_force_startend_keying=True, path_mode='AUTO', embed_textures=False, batch_mode='OFF',
        axis_forward='-Z', axis_up='Y',
    )
    try:
        res = bpy.ops.export_scene.fbx(**_filtered(bpy.ops.export_scene.fbx, kwargs))
    finally:
        for st in restore:
            o = st["obj"]
            try:
                if st["linked"]:
                    scene.collection.objects.unlink(o)
                o.hide_viewport = st["hide_viewport"]
                if st["hide"] is not None and vl.objects.get(o.name) is not None:
                    o.hide_set(st["hide"])
            except Exception:
                pass
    return 'FINISHED' in res


# ------------------------------------------------------------------------------------------------
# operator / UI
# ------------------------------------------------------------------------------------------------

def _prefs(context):
    try:
        return context.preferences.addons[__name__].preferences
    except Exception:
        return None


class MESHBOX_OT_save_milestone(bpy.types.Operator):
    """Save the file, then keep a numbered, dated copy in the Versions folder"""
    bl_idname = "wm.meshbox_save_milestone"
    bl_label = "Save Milestone…"
    bl_options = {'REGISTER'}

    note: StringProperty(name="Note", description="Short description stored in history.json and the file name",
                         default="")

    def invoke(self, context, event):
        if not bpy.data.filepath:
            self.report({'ERROR'}, "Save the .blend once (File > Save As) before saving milestones")
            return {'CANCELLED'}
        return context.window_manager.invoke_props_dialog(self, width=420)

    def draw(self, context):
        layout = self.layout
        layout.prop(self, "note")
        try:
            t = milestone_target(bpy.data.filepath, self.note)
            layout.label(text="%s/%s" % (VERSIONS_DIR, t["file"]), icon='FILE_BLEND')
        except Exception:
            pass

    def execute(self, context):
        if not bpy.data.filepath:
            self.report({'ERROR'}, "Save the .blend once (File > Save As) before saving milestones")
            return {'CANCELLED'}
        try:
            res = bpy.ops.wm.save_mainfile()
            if 'FINISHED' not in res:
                self.report({'ERROR'}, "Saving the file failed")
                return {'CANCELLED'}
        except RuntimeError as e:
            self.report({'ERROR'}, "Saving the file failed: %s" % e)
            return {'CANCELLED'}
        src = bpy.data.filepath
        t = milestone_target(src, self.note)
        os.makedirs(t["dir"], exist_ok=True)
        dest = t["path"]
        while os.path.exists(dest):  # never overwrite an existing milestone
            t["version"] += 1
            slug = slugify(self.note)
            t["file"] = "%s_v%03d_%s%s.blend" % (t["asset"], t["version"], datetime.date.today().isoformat(),
                                                 ("_" + slug) if slug else "")
            dest = os.path.join(t["dir"], t["file"])
        try:
            shutil.copy2(src, dest)
        except OSError as e:
            self.report({'ERROR'}, "Could not copy the milestone: %s" % e)
            return {'CANCELLED'}
        entry = {"version": t["version"], "file": t["file"], "assetName": t["asset"],
                 "date": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
                 "note": self.note, "sizeBytes": os.path.getsize(dest),
                 "blenderVersion": bpy.app.version_string, "sourceFile": src}
        prefs = _prefs(context)
        fbx_msg = ""
        if prefs is not None and getattr(prefs, "export_fbx", False):
            fbx_path = os.path.join(os.path.dirname(src), t["asset"] + ".fbx")
            try:
                if export_unity_fbx(context, fbx_path):
                    entry["fbx"] = fbx_path
                    fbx_msg = " + %s" % os.path.basename(fbx_path)
            except Exception as e:
                self.report({'WARNING'}, "Milestone saved, but the FBX export failed: %s" % e)
        history = t["history"]
        history.append(entry)
        try:
            tmp = t["historyPath"] + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(history, f, indent=2, ensure_ascii=False)
            os.replace(tmp, t["historyPath"])
        except OSError as e:
            self.report({'WARNING'}, "Milestone saved, but history.json could not be written: %s" % e)
        if prefs is None or getattr(prefs, "compress", True):
            ntfs_compress(dest)
        if t.get("warning"):
            self.report({'WARNING'}, t["warning"])
        self.report({'INFO'}, "Milestone v%03d saved: %s/%s%s" % (t["version"], VERSIONS_DIR, t["file"], fbx_msg))
        return {'FINISHED'}


class MeshboxMilestonesPreferences(bpy.types.AddonPreferences):
    bl_idname = __name__

    export_fbx: BoolProperty(name="Also export Unity FBX on milestone", default=False,
                             description="After each milestone, export <AssetName>.fbx next to the .blend "
                                         "with Unity-ready settings")
    compress: BoolProperty(name="NTFS-compress milestone copies (Windows)", default=True,
                           description="Run compact.exe /exe:lzx on each copy (transparent, read-optimised)")

    def draw(self, context):
        col = self.layout.column()
        col.prop(self, "export_fbx")
        col.prop(self, "compress")


def menu_func(self, context):
    self.layout.separator()
    self.layout.operator(MESHBOX_OT_save_milestone.bl_idname, text="Save Milestone…", icon='FILE_TICK')


_classes = (MESHBOX_OT_save_milestone, MeshboxMilestonesPreferences)


def register():
    for c in _classes:
        bpy.utils.register_class(c)
    bpy.types.TOPBAR_MT_file.append(menu_func)


def unregister():
    bpy.types.TOPBAR_MT_file.remove(menu_func)
    for c in reversed(_classes):
        bpy.utils.unregister_class(c)


if __name__ == "__main__":
    register()
