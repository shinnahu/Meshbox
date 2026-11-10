import * as THREE from 'three';

// ---------------------------------------------------------------- humanoid bones
// Canonical names follow Unity's humanoid avatar. Matching tolerates Mixamo, Blender/Rigify, VRoid,
// MMD-ish and Unreal names (prefixes, .L/_l/Left, Up/Upper...).
const SYNONYMS = {
  hips: ['hips', 'hip', 'pelvis', 'root_pelvis'],
  spine: ['spine', 'spine0', 'spine00', 'spine01', 'spine001', 'abdomen', 'waist', 'lowerback'],
  chest: ['chest', 'spine1', 'spine02', 'spine002', 'upperbody', 'torso'],
  upperChest: ['upperchest', 'spine2', 'spine03', 'spine003', 'chest1', 'upperbody2'],
  neck: ['neck', 'neck1', 'neck01'],
  head: ['head'],
  shoulder: ['shoulder', 'clavicle', 'collar', 'collarbone'],
  upperArm: ['upperarm', 'arm', 'uparm', 'upper_arm', 'armupper', 'shoulderarm'],
  lowerArm: ['lowerarm', 'forearm', 'elbow', 'lower_arm', 'armlower', 'foreArm'],
  hand: ['hand', 'wrist'],
  upperLeg: ['upperleg', 'upleg', 'thigh', 'upper_leg', 'legupper', 'thighbone'],
  lowerLeg: ['lowerleg', 'leg', 'shin', 'calf', 'knee', 'lower_leg', 'leglower'],
  foot: ['foot', 'ankle'],
  toes: ['toes', 'toe', 'toebase', 'ball', 'toe_base', 'toes01', 'toe01'],
};
const SIDED = new Set(['shoulder', 'upperArm', 'lowerArm', 'hand', 'upperLeg', 'lowerLeg', 'foot', 'toes']);
const lookup = new Map();
for (const [canon, names] of Object.entries(SYNONYMS)) for (const n of names) lookup.set(n.toLowerCase().replace(/[^a-z0-9]/g, ''), canon);

export function canonicalBone(rawName) {
  let n = (rawName || '').toLowerCase();
  n = n.replace(/^.*[:|]/, '');
  // Twist/roll/IK/control helpers are never the main humanoid bone.
  if (/twist|roll|helper|pole|target|(^|_)ik(_|$)|(^|_)fk(_|$)|^c_|^mch|nub$|_end$|end$|^ctrl|_ctrl/.test(n)) return null;
  n = n.replace(/^(mixamorig\d*|bip0*1|bip|def|org|mch|valvebiped|cc_base|rig|armature|j_bip_[clr]|j_adj_[clr]|j_sec_[clr]|b_|bn_|bone_|jnt_|joint_)[_.\-\s]*/g, '');
  let side = null;
  const sideRe = [
    [/(^|[_.\-\s])(left|l)(?=$|[_.\-\s])/, 'L'], [/(^|[_.\-\s])(right|r)(?=$|[_.\-\s])/, 'R'],
    [/^left/, 'L'], [/^right/, 'R'], [/left$/, 'L'], [/right$/, 'R'],
    [/[_.\-]l$/, 'L'], [/[_.\-]r$/, 'R'], [/^l[_.\-]/, 'L'], [/^r[_.\-]/, 'R'],
  ];
  // VRoid style j_bip_l_upperarm was stripped above; recover its side from the raw name.
  const raw = (rawName || '').toLowerCase();
  if (/j_bip_l_|_l_|\bl_/.test(raw) && !/_r_/.test(raw)) side = 'L';
  if (/j_bip_r_/.test(raw)) side = 'R';
  for (const [re, s] of sideRe) {
    if (re.test(n)) { side = side || s; n = n.replace(re, '$1'); break; }
  }
  const key = n.replace(/[^a-z0-9]/g, '').replace(/stretch|deform|bind/g, '');
  let canon = lookup.get(key);
  if (!canon && !side) {
    // Side glued to the name: "footl", "handr", "headx" (Auto-Rig Pro after three.js strips the dots), or "lfoot".
    const last = key.slice(-1), base = key.slice(0, -1);
    const first = key[0], rest = key.slice(1);
    if ('lrx'.includes(last) && lookup.has(base)) { canon = lookup.get(base); side = last === 'l' ? 'L' : last === 'r' ? 'R' : null; }
    else if ('lr'.includes(first) && lookup.has(rest)) { canon = lookup.get(rest); side = first === 'l' ? 'L' : 'R'; }
  }
  if (!canon) return null;
  if (SIDED.has(canon)) {
    if (!side) return null;
    return (side === 'L' ? 'left' : 'right') + canon[0].toUpperCase() + canon.slice(1);
  }
  return canon;
}

/**
 * Maps canonical humanoid names → bones. A rig counts as humanoid with both arms and legs mapped.
 * Files can hold several armatures with the same bone names (body + outfit): each is mapped on its own
 * and the most complete one wins, so left and right never come from different copies.
 */
export function humanoidMap(bones) {
  const groups = new Map();
  for (const b of bones) {
    let r = b;
    while (r.parent?.isBone) r = r.parent;
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(b);
  }
  let best = null;
  for (const list of groups.values()) {
    const res = mapBones(list);
    if (!best || res.mapped > best.mapped) best = res;
  }
  return best || mapBones([]);
}

// Advanced Skeleton (Maya) names mean different things: Hip_L is the thigh, Shoulder_L the upper arm.
const ADV = { root: 'hips', spine1: 'spine', spine: 'spine', spine2: 'chest', chest: 'chest', spine3: 'upperChest', neck: 'neck', neck1: 'neck', head: 'head',
  scapula: 'shoulder', shoulder: 'upperArm', elbow: 'lowerArm', wrist: 'hand', hip: 'upperLeg', knee: 'lowerLeg', ankle: 'foot', toes: 'toes', toe: 'toes' };
const strip = (n) => (n || '').replace(/^.*[:|]/, '');

function mapBones(bones) {
  const map = {};
  const adv = bones.some((b) => /^(root|spine\d*|chest|neck|head)_m$/i.test(strip(b.name)));
  for (const b of bones) {
    let c = null;
    if (adv) {
      const m = /^(.+?)_([lrm])$/i.exec(strip(b.name));
      const canon = m && ADV[m[1].toLowerCase()];
      if (canon) {
        const side = m[2].toLowerCase();
        const cap = canon[0].toUpperCase() + canon.slice(1);
        if (SIDED.has(canon)) c = side === 'l' ? 'left' + cap : side === 'r' ? 'right' + cap : null;
        else c = side === 'm' ? canon : null;
      }
    } else c = canonicalBone(b.name);
    if (c && !map[c]) map[c] = b;
  }
  // No bone called hips/pelvis (Auto-Rig Pro calls it root.x): the thighs' parent is the hips.
  if (!map.hips && map.leftUpperLeg && map.rightUpperLeg) {
    const up = new Set();
    for (let b = map.leftUpperLeg.parent; b?.isBone; b = b.parent) up.add(b);
    for (let b = map.rightUpperLeg.parent; b?.isBone; b = b.parent) if (up.has(b)) { map.hips = b; break; }
  }
  const need = ['hips', 'head', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm', 'leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg'];
  const missing = need.filter((n) => !map[n]);
  return { map, isHumanoid: missing.length <= 1 && !!map.leftUpperLeg && !!map.rightUpperLeg, missing, mapped: Object.keys(map).length };
}

// ---------------------------------------------------------------- facing / up detection
/**
 * For humanoids: forward = (left - right) × up from the hips/shoulders in the rest pose.
 * Returns {forward, up, fix: Quaternion|null, label} in the model's own (unit-corrected) space.
 */
export function detectFacing(space, human) {
  if (!human?.isHumanoid) return null;
  const m = human.map;
  space.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(space.matrixWorld).invert();
  const pos = (b) => b ? new THREE.Vector3().setFromMatrixPosition(b.matrixWorld).applyMatrix4(inv) : null;
  const L = pos(m.leftUpperLeg) || pos(m.leftUpperArm);
  const R = pos(m.rightUpperLeg) || pos(m.rightUpperArm);
  const head = pos(m.head) || pos(m.neck);
  if (!L || !R || !head) return null;
  const hips = pos(m.hips) || L.clone().add(R).multiplyScalar(0.5);
  const up = head.clone().sub(hips).normalize();
  const lateral = L.clone().sub(R).normalize();
  const forward = new THREE.Vector3().crossVectors(lateral, up).normalize();
  if (!isFinite(forward.x) || forward.lengthSq() < 0.5) return null;

  // Rotation that maps (forward, up) onto (+Z, +Y), snapped to 90° steps.
  const snap = (v) => {
    const a = [Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)];
    const i = a.indexOf(Math.max(...a));
    const s = new THREE.Vector3();
    s.setComponent(i, Math.sign(v.getComponent(i)));
    return s;
  };
  const f = snap(forward);
  let u = snap(up);
  if (Math.abs(f.dot(u)) > 0.5) u = new THREE.Vector3(0, 1, 0);
  const basis = new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(u, f), u, f);
  const q = new THREE.Quaternion().setFromRotationMatrix(basis).invert();
  const ok = f.z > 0.5 && u.y > 0.5;
  const axisName = (v) => (v.x > 0.5 ? '+X' : v.x < -0.5 ? '-X' : v.y > 0.5 ? '+Y' : v.y < -0.5 ? '-Y' : v.z > 0.5 ? '+Z' : '-Z');
  const angleOff = THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(forward.dot(new THREE.Vector3(0, 0, 1)), -1, 1)));
  return {
    forward, up, ok, fix: ok ? null : q, faces: axisName(f), upAxis: axisName(u),
    angleOff, label: ok ? 'Faces +Z (Unity forward)' : `Faces ${axisName(f)}${u.y > 0.5 ? '' : `, up is ${axisName(u)}`}`,
  };
}

// ---------------------------------------------------------------- statistics
export function analyze(root, clips = []) {
  const s = {
    meshes: 0, skinnedMeshes: 0, triangles: 0, vertices: 0, polygons: 0, hasPolygonInfo: true, drawCalls: 0,
    materials: new Set(), textures: new Map(), bones: new Set(), morphTargets: new Set(), lights: 0, cameras: 0,
    objects: 0, animations: clips.length, emptyMaterialSlots: 0,
  };
  root.traverse((o) => {
    if (o.userData.helper) return;
    s.objects++;
    if (o.isLight) s.lights++;
    if (o.isCamera) s.cameras++;
    if (o.isBone) s.bones.add(o);
    if (!(o.isMesh || o.isSkinnedMesh || o.isPoints || o.isLine)) return;
    const g = o.geometry;
    if (!g?.attributes?.position) return;
    s.meshes++;
    if (o.isSkinnedMesh) { s.skinnedMeshes++; o.skeleton?.bones.forEach((b) => s.bones.add(b)); }
    const inst = o.isInstancedMesh ? o.count : 1;
    const tris = o.isMesh ? (g.index ? g.index.count / 3 : g.attributes.position.count / 3) : 0;
    s.triangles += tris * inst;
    if (g.userData?.controlPoints != null) s.vertices += g.userData.controlPoints * inst;
    else s.vertices += g.attributes.position.count * inst;
    if (g.userData?.polygonCount != null) s.polygons += g.userData.polygonCount * inst;
    else { s.polygons += tris * inst; s.hasPolygonInfo = false; }
    for (const name of Object.keys(o.morphTargetDictionary || {})) s.morphTargets.add(name);
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    s.drawCalls += Math.max(1, g.groups?.length || 1);
    for (const m of mats) {
      if (!m) { s.emptyMaterialSlots++; continue; }
      s.materials.add(m);
      for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'alphaMap', 'bumpMap', 'specularMap', 'lightMap', 'displacementMap', 'gradientMap']) {
        const t = m[key];
        if (t?.isTexture) {
          if (!s.textures.has(t)) s.textures.set(t, new Set());
          s.textures.get(t).add(key);
        }
      }
    }
  });
  let topology = 'Triangles';
  if (s.hasPolygonInfo && s.polygons > 0) {
    const ratio = s.triangles / s.polygons;
    topology = ratio > 1.9 ? 'Quad' : ratio > 1.15 ? 'Mixed' : 'Triangles';
  }
  return {
    ...s, topology, materialCount: s.materials.size, textureCount: s.textures.size, boneCount: s.bones.size,
    morphCount: s.morphTargets.size, boneList: [...s.bones],
  };
}

/** Bounding box in the given space (skinned meshes measured in their current pose). */
export function measure(object, space = null) {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const tmp = new THREE.Box3();
  const inv = space ? new THREE.Matrix4().copy(space.matrixWorld).invert() : null;
  object.traverseVisible((o) => {
    if (o.userData.helper) return;
    if (!(o.isMesh || o.isSkinnedMesh || o.isPoints || o.isLine) || !o.geometry?.attributes?.position) return;
    // boneMatrices are only refreshed when a frame renders: sync them with the current pose first.
    if (o.isSkinnedMesh) { o.skeleton?.update(); o.computeBoundingBox(); tmp.copy(o.boundingBox); }
    else { if (!o.geometry.boundingBox) o.geometry.computeBoundingBox(); tmp.copy(o.geometry.boundingBox); }
    if (tmp.isEmpty()) return;
    tmp.applyMatrix4(o.matrixWorld);
    if (inv) tmp.applyMatrix4(inv);
    box.union(tmp);
  });
  if (box.isEmpty()) {
    // Animation-only files: size the view from the skeleton instead.
    const p = new THREE.Vector3();
    object.traverse((o) => { if (o.isBone) { p.setFromMatrixPosition(o.matrixWorld); if (inv) p.applyMatrix4(inv); box.expandByPoint(p); } });
  }
  return box;
}
