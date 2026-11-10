"""
install_addon.py - install + enable the Save Milestone add-on for the running Blender and save prefs.

Run WITHOUT --factory-startup (it must change the user's preferences):

    blender -b -noaudio --python-exit-code 3 --python install_addon.py -- args.json

args.json: { "addonFile": "<path to meshbox_milestones.py>" }
Result:    { "installedTo": "<user scripts>/addons/meshbox_milestones.py", "enabled": true, ... }
"""

import os
import shutil
import sys

sys.dont_write_bytecode = True
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import bpy  # noqa: E402
import addon_utils  # noqa: E402
import meshbox_common as bb  # noqa: E402


def main(args):
    src = args.get("addonFile") or os.path.join(_HERE, "meshbox_milestones.py")
    src = os.path.abspath(src)
    if not os.path.isfile(src):
        raise bb.BBError("Add-on file not found: %s" % src)
    if bpy.app.factory_startup if hasattr(bpy.app, "factory_startup") else False:
        raise bb.BBError("install_addon.py must run without --factory-startup")
    module = os.path.splitext(os.path.basename(src))[0]
    bb.progress(0.1, "Locating user add-ons folder")
    try:
        dest_dir = bpy.utils.user_resource('SCRIPTS', path="addons", create=True)
    except TypeError:  # very old signature
        dest_dir = bpy.utils.user_resource('SCRIPTS', "addons", create=True)
    if not dest_dir:
        raise bb.BBError("Could not resolve the user scripts/addons folder")
    os.makedirs(dest_dir, exist_ok=True)
    dest = os.path.join(dest_dir, os.path.basename(src))

    bb.progress(0.3, "Copying add-on")
    was_enabled = module in bpy.context.preferences.addons
    if was_enabled:
        try:
            addon_utils.disable(module, default_set=True)
        except Exception:
            pass
    if not bb.same_path(src, dest):
        shutil.copy2(src, dest)
    stale = os.path.join(dest_dir, "__pycache__")
    if os.path.isdir(stale):
        for f in os.listdir(stale):
            if f.startswith(module + "."):
                try:
                    os.remove(os.path.join(stale, f))
                except OSError:
                    pass

    bb.progress(0.6, "Enabling add-on")
    addon_utils.modules_refresh()
    err = None
    try:
        addon_utils.enable(module, default_set=True, persistent=True, handle_error=None)
    except Exception as e:  # fall back to the operator
        err = e
    if module not in bpy.context.preferences.addons:
        try:
            bpy.ops.preferences.addon_enable(module=module)
        except Exception as e:
            err = err or e
    enabled = module in bpy.context.preferences.addons

    bb.progress(0.85, "Saving preferences")
    saved = False
    if enabled:
        try:
            bpy.ops.wm.save_userpref()
            saved = True
        except Exception as e:
            err = err or e
    res = {"installedTo": dest, "enabled": enabled, "module": module, "preferencesSaved": saved,
           "blenderVersion": bpy.app.version_string, "wasEnabled": was_enabled}
    if err is not None and not enabled:
        raise bb.BBError("Installed to %s but enabling failed: %s" % (dest, err))
    if err is not None:
        res["warning"] = str(err)
    return res


bb.run(main)
