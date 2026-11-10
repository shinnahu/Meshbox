"""
preview.py - export what is visible to a GLB for the viewer and describe the scene.

    blender -b --factory-startup -noaudio [input.blend] --python-exit-code 3 --python preview.py -- args.json

args.json: { "out": "<path>.glb", "source": "<optional: .blend/.fbx/.glb/.gltf/.obj ... when no .blend is open>" }

The source file is never saved or modified; all changes (modifier baking, material wiring,
visibility) live only in this Blender session.
"""

import os
import sys

sys.dont_write_bytecode = True
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import bpy  # noqa: E402
import meshbox_common as bb  # noqa: E402


def _mesh_entry(o, visible, evaluated):
    me = o.data
    st = bb.mesh_poly_stats(me)
    key = me.shape_keys
    ref = key.reference_key.name if key and key.reference_key else None
    names = [kb.name for kb in key.key_blocks if kb.name != ref] if key else []
    e = {"name": o.name, "data": me.name, "visible": visible, "vertices": len(me.vertices)}
    e.update(st)
    e["shapeKeys"] = {"count": len(names), "basis": ref, "names": names[:50]}
    e["modifiers"] = [m.type for m in o.modifiers]
    e["uvLayers"] = [uv.name for uv in me.uv_layers]
    e["materials"] = [s.material.name if s.material else None for s in o.material_slots]
    if evaluated is not None and any(m.type != 'ARMATURE' and m.show_viewport for m in o.modifiers):
        e["evaluated"] = {"vertices": evaluated["vertices"], "faces": evaluated["faces"],
                          "triangles": evaluated["triangles"]}
    return e


def collect_info(load, warnings, unit_m):
    scene = bpy.context.scene
    us = scene.unit_settings
    fps = bb.scene_fps()
    info = {
        "blenderVersion": bpy.app.version_string,
        "fileVersion": ("%d.%d.%d" % tuple(bpy.data.version)) if load["kind"] == "blend" else None,
        "sourceKind": load["kind"],
        "source": load["path"],
        "units": {"system": us.system, "scaleLength": us.scale_length, "lengthUnit": getattr(us, "length_unit", None)},
        "scene": {"name": scene.name, "frameStart": scene.frame_start, "frameEnd": scene.frame_end,
                  "frameCurrent": scene.frame_current, "fps": fps},
    }
    counts, vis_counts = {}, {}
    for o in scene.objects:
        counts[o.type] = counts.get(o.type, 0) + 1
        if o.visible_get():
            vis_counts[o.type] = vis_counts.get(o.type, 0) + 1
    info["objects"] = counts
    info["visibleObjects"] = vis_counts

    # materials / image roles
    mats_all = bb.materials_of([o for o in scene.objects if o.type in bb.GEOMETRY_TYPES])
    used_by_visible = set(m.name for m in bb.materials_of([o for o in scene.objects
                                                         if o.type in bb.GEOMETRY_TYPES and o.visible_get()]))
    roles = bb.image_roles(mats_all)
    mats = []
    for m in mats_all:
        a = bb.analyze_material(m)
        tex = {}
        for role in ("baseColor", "metallic", "roughness", "emission", "alpha"):
            t = a[role].get("texture") if a.get(role) else None
            if t:
                tex[role] = t["image"]
        if a.get("normal") and a["normal"].get("texture"):
            tex["normal"] = a["normal"]["texture"]["image"]
        if a.get("occlusion") and a["occlusion"].get("texture"):
            tex["occlusion"] = a["occlusion"]["texture"]["image"]
        mats.append({"name": m.name, "usesPrincipled": a["usesPrincipled"], "shader": a.get("shader"),
                     "texturedInputs": sorted(tex.keys()), "textures": tex, "alphaMode": a["alpha"]["mode"],
                     "doubleSided": a["doubleSided"], "users": m.users, "visible": m.name in used_by_visible})
    info["materials"] = mats

    used_images = set(i.name for i in bb.images_of_materials(mats_all))
    vis_images = set(i.name for i in bb.images_of_materials([m for m in mats_all if m.name in used_by_visible]))
    images = []
    for img in bpy.data.images:
        if img.source == 'VIEWER':
            continue
        d = bb.image_info(img, roles)
        d["usedByMaterials"] = img.name in used_images
        d["visible"] = img.name in vis_images
        images.append(d)
        if d["visible"] and not d["packed"] and img.source in ('FILE', 'SEQUENCE', 'MOVIE') and not d["exists"]:
            warnings.append("Missing texture: %s (%s)" % (img.name, img.filepath))
    info["images"] = images

    libs = []
    for lib in bpy.data.libraries:
        ap = os.path.normpath(bpy.path.abspath(lib.filepath))
        ok = os.path.isfile(ap)
        libs.append({"name": lib.name, "filepath": lib.filepath, "absPath": ap, "exists": ok})
        if not ok:
            warnings.append("Missing linked library: %s" % lib.filepath)
    info["libraries"] = libs

    arms = []
    for o in scene.objects:
        if o.type != 'ARMATURE':
            continue
        g = bb.guess_humanoid(o)
        e = {"name": o.name, "visible": o.visible_get(), "boneCount": len(o.data.bones),
             "deformBones": sum(1 for b in o.data.bones if b.use_deform), "humanoid": g["humanoid"],
             "matchedBones": g["matched"], "missingBones": g["missing"], "issues": g.get("issues", []),
             "facing": None}
        f, src = bb.estimate_facing(o, g["matched"])
        if f is not None:
            e["facing"] = bb.yup_vec(f)
            e["facingFrom"] = src
        arms.append(e)
    info["armatures"] = arms
    info["actions"] = [bb.action_info(a, fps) for a in bpy.data.actions]
    return info


def main(args):
    out = args.get("out")
    if not out:
        raise bb.BBError("Missing 'out' (path of the .glb to write)")
    out = os.path.abspath(out)
    if not out.lower().endswith(".glb"):
        out += ".glb"
    os.makedirs(os.path.dirname(out), exist_ok=True)
    warnings = []
    bb.progress(0.02, "Loading")
    load = bb.load_source(args.get("source"), warnings, fbx_units="meters")
    unit_m = bb.unit_to_meters()

    bb.progress(0.10, "Analyzing scene")
    scene = bpy.context.scene
    vis_geo = [o for o in scene.objects if o.visible_get() and o.type in bb.GEOMETRY_TYPES]
    mn, mx, stats = bb.measure_world_aabb(vis_geo)
    measured_from = "geometry"
    if mn is None:  # animation-only / skeleton-only file
        mn, mx = bb.measure_bones_aabb([o for o in scene.objects if o.type == 'ARMATURE'])
        measured_from = "bones" if mn is not None else "nothing"
    info = collect_info(load, warnings, unit_m)
    if load.get("renamedActions"):
        info["renamedActions"] = load["renamedActions"]
    info["measuredFrom"] = measured_from
    meshes = []
    for o in scene.objects:
        if o.type != 'MESH':
            continue
        vis = o.visible_get()
        if not vis and len(o.data.polygons) == 0:
            continue  # rig widgets and other helpers
        meshes.append(_mesh_entry(o, vis, stats.get(o.name)))
    info["meshes"] = meshes
    tot = {"vertices": 0, "faces": 0, "triangles": 0}
    for name, st in stats.items():
        for k in tot:
            tot[k] += st.get(k, 0)
    info["totals"] = tot
    info["dimensionsM"] = bb.yup_size(mn, mx, unit_m)
    info["pivotOffsetM"] = bb.yup_pivot_offset(mn, mx, unit_m)
    info["aabbM"] = bb.yup_aabb(mn, mx, unit_m)
    info["measuredInRestPose"] = True

    bb.progress(0.30, "Preparing export")
    objs = bb.export_object_set(only_visible=True)
    if not any(o.type in bb.GEOMETRY_TYPES for o in objs):
        warnings.append("No visible geometry" + (" (skeleton/animation only)" if any(o.type == 'ARMATURE' for o in objs) else ""))
    bb.make_exportable(objs)

    # missing textures: use a same-named file found near the source (session only) so the GLB shows it
    src_dir = os.path.dirname(os.path.abspath(load["path"]))
    finder = bb.NameIndex([src_dir, os.path.dirname(src_dir)])
    relinked = []
    for img in bb.images_of_materials(bb.materials_of([o for o in objs if o.type in bb.GEOMETRY_TYPES])):
        if img.packed_file is None and img.source == 'FILE' and not bb.image_available(img):
            alt = finder.find(img.filepath or img.name) or (finder.find(img.name) if "." in img.name else None)
            if alt:
                img.filepath = alt
                relinked.append({"image": img.name, "from": alt})
    if relinked:
        info["relinked"] = relinked
        found = {r["image"]: r["from"] for r in relinked}
        for d in info["images"]:
            if d["name"] in found:
                d["foundAt"] = found[d["name"]]
        warnings[:] = [w for w in warnings if not any(("Missing texture: %s " % n) in w for n in found)]
    reports = bb.bake_modifiers([o for o in objs if o.type == 'MESH'], warnings, bb.Progress(0.30, 0.50))
    if reports:
        info["bakedModifiers"] = reports
    converted = []
    for m in bb.materials_of([o for o in objs if o.type in bb.GEOMETRY_TYPES]):
        r = bb.make_material_exportable(m)
        if r:
            converted.append(r)
    if converted:
        info["convertedMaterials"] = converted
    arms = [o for o in objs if o.type == 'ARMATURE']
    if len(arms) == 1 and arms[0].animation_data is None and len(bpy.data.actions):
        arms[0].animation_data_create()
    bb.select_only(objs)

    bb.progress(0.55, "Writing GLB")
    kw = dict(
        filepath=out, check_existing=False, export_format='GLB', use_selection=True, use_visible=False,
        use_renderable=False, use_active_collection=False, use_active_scene=False, export_cameras=False,
        export_lights=False, export_apply=False, export_yup=True, export_texcoords=True, export_normals=True,
        export_tangents=False, export_materials='EXPORT', export_image_format='AUTO', export_skins=True,
        export_influence_nb=4, export_all_influences=False, export_morph=True, export_morph_normal=True,
        export_morph_tangent=False, export_morph_animation=True, export_try_sparse_sk=True,
        export_animations=True, export_animation_mode='ACTIONS', export_nla_strips=True,
        export_force_sampling=True, export_frame_range=False, export_anim_single_armature=True,
        export_reset_pose_bones=True, export_rest_position_armature=True, export_def_bones=False,
        export_optimize_animation_size=True, export_extras=False, export_draco_mesh_compression_enable=False,
        export_unused_images=False, export_unused_textures=False, export_gpu_instances=False,
        export_hierarchy_full_collections=False, will_save_settings=False, export_vertex_color='MATERIAL',
        export_attributes=False,
    )
    res, dropped = bb.call_op(bpy.ops.export_scene.gltf, **kw)
    if 'FINISHED' not in res or not os.path.isfile(out):
        raise bb.BBError("glTF export failed")
    info["warnings"] = list(dict.fromkeys(warnings))
    bb.progress(0.98, "Done")
    return {"glb": out, "sizeBytes": os.path.getsize(out), "info": info}


bb.run(main)
