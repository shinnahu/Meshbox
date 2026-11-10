import * as THREE from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { canonicalBone, humanoidMap } from './analyze.js';

/** Plays clips on the loaded model; Sketchfab-like controls (clip, speed, loop, scrub, rest pose). */
export class AnimationController extends EventTarget {
  constructor() {
    super();
    this.mixer = null;
    this.root = null;
    this.clips = [];
    this.index = -1;
    this.action = null;
    this.playing = false;
    this.speed = 1;
    this.loop = 'repeat'; // repeat | once | pingpong
    this.restPose = new Map();
  }

  attach(root, clips) {
    this.dispose();
    this.root = root;
    this.clips = (clips || []).filter((c) => c && c.duration > 0 && c.tracks.length);
    this.clips.forEach((c, i) => { if (!c.name || /^(Take 001|mixamo\.com|Armature\|mixamo\.com)$/i.test(c.name)) c.userData = { ...(c.userData || {}), shownName: c.name || `Animation ${i + 1}` }; });
    root.traverse((o) => this.restPose.set(o, { p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() }));
    this.mixer = new THREE.AnimationMixer(root);
    this.mixer.addEventListener('finished', () => { this.playing = false; this.emit(); });
    this.index = -1;
    this.emit();
  }

  get current() { return this.clips[this.index] || null; }
  get duration() { return this.current?.duration || 0; }
  get time() { return this.action ? this.action.time : 0; }

  select(i, autoplay = true) {
    if (!this.mixer || !this.clips[i]) return;
    this.mixer.stopAllAction();
    this.index = i;
    this.action = this.mixer.clipAction(this.clips[i]);
    this.applyLoop();
    this.action.reset();
    this.action.timeScale = this.speed;
    this.action.play();
    this.action.paused = !autoplay;
    this.playing = autoplay;
    this.mixer.update(0);
    this.emit();
  }

  play() {
    if (!this.mixer || !this.clips.length) return;
    if (!this.action) return this.select(0, true);
    if (this.action.time >= this.duration - 1e-3 && this.loop === 'once') this.action.reset();
    this.action.paused = false;
    this.action.enabled = true;
    this.action.play();
    this.playing = true;
    this.emit();
  }

  pause() {
    if (this.action) this.action.paused = true;
    this.playing = false;
    this.emit();
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  /** Back to the model's rest/bind pose (no clip). */
  stop() {
    if (!this.mixer) return;
    this.mixer.stopAllAction();
    this.action = null;
    this.index = -1;
    this.playing = false;
    for (const [o, t] of this.restPose) { o.position.copy(t.p); o.quaternion.copy(t.q); o.scale.copy(t.s); }
    this.root?.traverse((o) => { if (o.morphTargetInfluences) o.morphTargetInfluences.fill(0); });
    this.emit();
  }

  seek(t) {
    if (!this.action) this.select(Math.max(0, this.index), false);
    if (!this.action) return;
    this.action.paused = false;
    this.action.time = THREE.MathUtils.clamp(t, 0, this.duration);
    this.mixer.update(0);
    this.action.paused = !this.playing;
    this.emit('time');
  }

  setSpeed(s) { this.speed = s; if (this.action) this.action.timeScale = s; this.emit(); }

  setLoop(mode) { this.loop = mode; this.applyLoop(); this.emit(); }

  applyLoop() {
    if (!this.action) return;
    if (this.loop === 'once') { this.action.setLoop(THREE.LoopOnce, 1); this.action.clampWhenFinished = true; }
    else if (this.loop === 'pingpong') this.action.setLoop(THREE.LoopPingPong, Infinity);
    else this.action.setLoop(THREE.LoopRepeat, Infinity);
  }

  /** Advances time; returns true when something moved and a new frame is needed. */
  update(dt) {
    if (!this.mixer || !this.playing) return false;
    this.mixer.update(dt);
    this.emit('time');
    return true;
  }

  addClips(clips) {
    const start = this.clips.length;
    for (const c of clips) {
      let name = c.name, n = 2;
      while (this.clips.some((x) => x.name === name)) name = `${c.name} (${n++})`;
      c.name = name;
      this.clips.push(c);
    }
    this.emit();
    return start;
  }

  emit(kind = 'change') { this.dispatchEvent(new Event(kind)); }

  dispose() {
    this.mixer?.stopAllAction();
    if (this.mixer && this.root) this.mixer.uncacheRoot(this.root);
    this.mixer = null;
    this.action = null;
    this.clips = [];
    this.index = -1;
    this.playing = false;
    this.restPose.clear();
  }
}

// ---------------------------------------------------------------- animations from other files
function bonesOf(root) {
  const bones = [];
  root.traverse((o) => { if (o.isBone) bones.push(o); });
  return bones;
}

const norm = (n) => (n || '').replace(/^.*[:|]/, '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Makes clips from another file play on our model. Same rig (e.g. Hero@Run.fbx on Hero.fbx):
 * tracks are renamed by bone name. Different humanoid rigs (Mixamo on a Rigify/VRoid character):
 * SkeletonUtils.retargetClip with a humanoid bone map. Returns {clips, method, matched}.
 */
export function retargetClips(targetRoot, sourceRoot, clips, { targetSpace = null, sourceUnitScale = 1, targetRest = null, neutralize = null } = {}) {
  const tBones = bonesOf(targetRoot);
  const sBones = bonesOf(sourceRoot);
  if (!tBones.length) throw new Error('This model has no skeleton to animate.');
  // First occurrence wins, like the animation binding: some FBX files hold an identity copy of every bone
  // as a child of the real one (same name), and tracks must target the outer, real bone.
  const firstBy = (list, val) => { const m = new Map(); for (const b of list) { const k = norm(b.name); if (!m.has(k)) m.set(k, val(b)); } return m; };
  const tByNorm = firstBy(tBones, (b) => b.name);
  const tBoneByNorm = firstBy(tBones, (b) => b);
  const sBoneByNorm = firstBy(sBones, (b) => b);
  const trackBone = (name) => name.slice(0, name.lastIndexOf('.'));
  // Bone positions are local to the parent: files of the same rig can still differ in armature scale
  // (100 vs 1) or units (cm vs m). Scale position tracks by the ratio of the parents' world scales.
  sourceRoot.updateMatrixWorld(true);
  targetRoot.updateMatrixWorld(true);
  const inv = targetSpace ? new THREE.Matrix4().copy(targetSpace.matrixWorld).invert() : null;
  const scaleOf = (o, space) => new THREE.Vector3().setFromMatrixScale(space ? new THREE.Matrix4().multiplyMatrices(space, o.matrixWorld) : o.matrixWorld).x;
  const positionFactor = (boneName) => {
    const s = sBoneByNorm.get(norm(boneName)), t = tBoneByNorm.get(norm(boneName));
    if (!s?.parent || !t?.parent) return 1;
    const k = (scaleOf(s.parent, null) * sourceUnitScale) / scaleOf(t.parent, inv);
    return isFinite(k) && k > 0 ? k : 1;
  };

  // Same rig, different container: one file keeps the axis fix on an "Armature" node (-90°, ×100), another
  // puts the bones straight under the root in centimeters. Only the root bones see that difference:
  //   root bones:  q_t = A · q_s,  p_t = k · A · p_s,   A = Pt⁻¹ · Ps (parents' rest world rotations)
  //   other bones: q_t = q_s,      p_t = k · p_s       (k = ratio of the parents' world scales)
  // (Animation-only files often store frame 0 as their "rest", so per-bone rest maths would be wrong.)
  const tRest = (o) => targetRest?.(o) || { q: o.quaternion, p: o.position };
  const worldRestQ = (o, stop, restQ) => {
    const chain = [];
    for (let x = o; x && x !== stop; x = x.parent) chain.push(x);
    const q = new THREE.Quaternion();
    for (let i = chain.length - 1; i >= 0; i--) q.multiply(restQ(chain[i]));
    return q;
  };
  const corrections = new Map();
  const correctionFor = (boneName) => {
    const key = norm(boneName);
    if (corrections.has(key)) return corrections.get(key);
    const s = sBoneByNorm.get(key), t = tBoneByNorm.get(key);
    let c = null;
    if (s && t) {
      const root = !s.parent?.isBone || !t.parent?.isBone;
      const A = root
        ? worldRestQ(t.parent, targetSpace, (o) => tRest(o).q).invert().multiply(worldRestQ(s.parent, null, (o) => o.quaternion))
        : new THREE.Quaternion();
      const safe = (x) => new THREE.Vector3(x.x || 1, x.y || 1, x.z || 1);
      c = { A, k: positionFactor(boneName), sRestS: safe(s.scale), tRestS: (tRest(t).s || t.scale).clone() };
    }
    corrections.set(key, c);
    return c;
  };

  // 1) direct name match
  let hits = 0, total = 0;
  const boneNames = new Set(clips.flatMap((c) => c.tracks.map((t) => trackBone(t.name))));
  for (const b of boneNames) { total++; if (tByNorm.has(norm(b))) hits++; }
  if (total && hits / total >= 0.6) {
    const q = new THREE.Quaternion(), v = new THREE.Vector3();
    const out = clips.map((c) => {
      const tracks = [];
      for (const t of c.tracks) {
        const bone = trackBone(t.name);
        const target = tByNorm.get(norm(bone));
        if (!target) continue;
        const prop = t.name.slice(t.name.lastIndexOf('.') + 1);
        const copy = t.clone();
        copy.name = `${target}.${prop}`;
        const cor = correctionFor(bone);
        if (cor && prop === 'quaternion') {
          for (let i = 0; i < copy.values.length; i += 4) {
            q.fromArray(copy.values, i).premultiply(cor.A).normalize();
            q.toArray(copy.values, i);
          }
        } else if (cor && prop === 'position') {
          for (let i = 0; i < copy.values.length; i += 3) {
            v.fromArray(copy.values, i).multiplyScalar(cor.k).applyQuaternion(cor.A);
            v.toArray(copy.values, i);
          }
        } else if (cor && prop === 'scale') {
          // Squash & stretch relative to each file's rest scale (exports differ: 1 vs 100 on some nodes).
          for (let i = 0; i < copy.values.length; i += 3) {
            v.fromArray(copy.values, i).divide(cor.sRestS).multiply(cor.tRestS);
            v.toArray(copy.values, i);
          }
        }
        tracks.push(copy);
      }
      return new THREE.AnimationClip(c.name, c.duration, tracks);
    });
    return { clips: out, method: 'names', matched: hits };
  }

  // 2) humanoid retarget
  const th = humanoidMap(tBones);
  const sh = humanoidMap(sBones);
  if (!th.isHumanoid || !sh.isHumanoid) throw new Error('The bones do not match this model, and one of the two rigs is not a recognizable humanoid.');
  const names = {};
  for (const [canon, tb] of Object.entries(th.map)) if (sh.map[canon]) names[tb.name] = sh.map[canon].name;
  let tMesh = null, sMesh = null;
  targetRoot.traverse((o) => { if (!tMesh && o.isSkinnedMesh) tMesh = o; });
  sourceRoot.traverse((o) => { if (!sMesh && o.isSkinnedMesh) sMesh = o; });
  if (!tMesh) throw new Error('This model has bones but no skinned mesh to animate.');
  const saved = tBones.map((b) => [b, b.position.clone(), b.quaternion.clone(), b.scale.clone()]);
  const restoreSpace = neutralize?.();
  let out;
  try {
    for (const b of tBones) { const r = targetRest?.(b); if (r) { b.position.copy(r.p); b.quaternion.copy(r.q); b.scale.copy(r.s); } }
    targetRoot.updateMatrixWorld(true);
    out = clips.map((c) => retargetHumanoidClip(targetRoot, sourceRoot, c, th, sh, tBones));
  } finally {
    for (const [b, p, q, s] of saved) { b.position.copy(p); b.quaternion.copy(q); b.scale.copy(s); }
    restoreSpace?.();
    targetRoot.updateMatrixWorld(true);
  }
  return { clips: out, method: 'humanoid', matched: Object.keys(names).length };
}

// Which mapped bone each humanoid bone points at (used to line up rest poses, e.g. A-pose vs T-pose).
const POINTS_AT = {
  hips: 'spine', spine: 'chest', chest: 'neck', upperChest: 'neck', neck: 'head',
  leftShoulder: 'leftUpperArm', leftUpperArm: 'leftLowerArm', leftLowerArm: 'leftHand',
  rightShoulder: 'rightUpperArm', rightUpperArm: 'rightLowerArm', rightLowerArm: 'rightHand',
  leftUpperLeg: 'leftLowerLeg', leftLowerLeg: 'leftFoot', leftFoot: 'leftToes',
  rightUpperLeg: 'rightLowerLeg', rightLowerLeg: 'rightFoot', rightFoot: 'rightToes',
};

/**
 * Humanoid retarget between different rigs. Each mapped target bone gets the source bone's world-space
 * rotation change from its rest pose, applied on top of the target rest pose after lining up the two rest
 * poses bone by bone (so A-pose and T-pose rigs agree) and the two facings. Hips move by the source motion
 * scaled by leg length. The target must be at rest, in metres, at the origin (see `neutralize`).
 */
function retargetHumanoidClip(targetRoot, sourceRoot, clip, th, sh, tBones) {
  const V = () => new THREE.Vector3(), Q = () => new THREE.Quaternion();
  const wpos = (o) => o.getWorldPosition(V());
  const wq = (o) => o.getWorldQuaternion(Q());
  sourceRoot.updateMatrixWorld(true);

  // Facing of each rig (left - right) × up, flattened: rotate source deltas into the target's facing.
  const facingOf = (m) => {
    const L = m.leftUpperLeg || m.leftUpperArm, R = m.rightUpperLeg || m.rightUpperArm;
    const f = new THREE.Vector3().crossVectors(wpos(L).sub(wpos(R)), new THREE.Vector3(0, 1, 0));
    f.y = 0;
    return f.lengthSq() > 1e-12 ? f.normalize() : new THREE.Vector3(0, 0, 1);
  };
  const F = Q().setFromUnitVectors(facingOf(sh.map), facingOf(th.map));
  const Finv = F.clone().invert();

  const pairs = [];
  for (const [canon, t] of Object.entries(th.map)) {
    const s = sh.map[canon];
    if (!s) continue;
    const tRest = wq(t), sRest = wq(s);
    let align = Q();
    const child = POINTS_AT[canon];
    if (child && th.map[child] && sh.map[child]) {
      const dt = wpos(th.map[child]).sub(wpos(t)).normalize();
      const ds = wpos(sh.map[child]).sub(wpos(s)).normalize().applyQuaternion(F);
      if (dt.lengthSq() > 0.5 && ds.lengthSq() > 0.5) align = Q().setFromUnitVectors(dt, ds);
    }
    pairs.push({ canon, t, s, ref: align.multiply(tRest), sRestInv: sRest.invert() });
  }
  const pairOf = new Map(pairs.map((p) => [p.t, p]));
  const depth = (b) => { let d = 0; for (let x = b; x?.parent; x = x.parent) d++; return d; };
  const ordered = [...tBones].sort((a, b) => depth(a) - depth(b));
  const restLocal = new Map(tBones.map((b) => [b, b.quaternion.clone()]));
  const staticParentQ = new Map();
  for (const b of tBones) if (!b.parent?.isBone) staticParentQ.set(b, wq(b.parent));

  // Hips translation: source motion scaled by leg length, rotated into the target's facing.
  const tHips = th.map.hips, sHips = sh.map.hips;
  const legLen = (m) => (m.leftUpperLeg && m.leftFoot ? wpos(m.leftUpperLeg).distanceTo(wpos(m.leftFoot)) : 0);
  const k = legLen(sh.map) > 1e-6 ? legLen(th.map) / legLen(sh.map) : 1;
  const tHipsRest = tHips ? wpos(tHips) : null;
  const sHipsRest = sHips ? wpos(sHips) : null;
  const hipsParentInv = tHips ? new THREE.Matrix4().copy(tHips.parent.matrixWorld).invert() : null;

  const mixer = new THREE.AnimationMixer(sourceRoot);
  mixer.clipAction(clip).play();
  const fps = 30;
  const n = Math.max(2, Math.round(clip.duration * fps) + 1);
  const times = new Float32Array(n);
  const qv = new Map(pairs.map((p) => [p.t, new Float32Array(n * 4)]));
  const hv = tHips && sHips ? new Float32Array(n * 3) : null;
  const world = new Map();
  const tmp = Q(), local = Q();
  for (let f = 0; f < n; f++) {
    const time = (f / (n - 1)) * clip.duration;
    times[f] = time;
    mixer.setTime(time);
    sourceRoot.updateMatrixWorld(true);
    world.clear();
    for (const b of ordered) {
      const parentQ = b.parent?.isBone ? world.get(b.parent) : staticParentQ.get(b);
      const p = pairOf.get(b);
      let w;
      if (p) {
        tmp.multiplyQuaternions(wq(p.s), p.sRestInv);              // source world delta
        tmp.premultiply(F).multiply(Finv);                          // in the target's facing
        w = tmp.clone().multiply(p.ref);
        local.copy(parentQ).invert().multiply(w).normalize();
        const arr = qv.get(b);
        if (f > 0 && local.x * arr[(f - 1) * 4] + local.y * arr[(f - 1) * 4 + 1] + local.z * arr[(f - 1) * 4 + 2] + local.w * arr[(f - 1) * 4 + 3] < 0) {
          local.set(-local.x, -local.y, -local.z, -local.w);
        }
        local.toArray(arr, f * 4);
      } else w = parentQ.clone().multiply(restLocal.get(b));
      world.set(b, w);
    }
    if (hv) {
      const d = wpos(sHips).sub(sHipsRest).multiplyScalar(k).applyQuaternion(F);
      tHipsRest.clone().add(d).applyMatrix4(hipsParentInv).toArray(hv, f * 3);
    }
  }
  mixer.stopAllAction();
  mixer.uncacheRoot(sourceRoot);
  const tracks = pairs.map((p) => new THREE.QuaternionKeyframeTrack(`${p.t.name}.quaternion`, times, qv.get(p.t)));
  if (hv) tracks.push(new THREE.VectorKeyframeTrack(`${tHips.name}.position`, times, hv));
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}
