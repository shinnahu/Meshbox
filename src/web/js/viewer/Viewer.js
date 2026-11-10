import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { loadEnvironment } from './environment.js';
import { Grid, ContactShadow, HELPER_LAYER } from './ground.js';
import { MaterialModes } from './materials.js';
import { StylePost } from './post.js';
import { analyze, measure, humanoidMap, detectFacing } from './analyze.js';
import { AnimationController } from './animation.js';
import { FlyControls } from './fly.js';
import { AxisGizmo, viewDirection } from './gizmo.js';
import { loadModel } from './loaders.js';
import { SettingsHistory } from './history.js';

export const DEFAULT_SETTINGS = {
  env: 'studio', envStrength: 1, envRotation: 0, envAutoRotate: false,
  background: 'gradient', bgBlur: 0.55, bgColor: '#2a2c30', exposure: 1, toneMapping: 'neutral',
  grid: true, gizmo: true, stats: true, dims: true, shadow: true,
  viewMode: 'textured', wireframe: false, flat: false, sketchVariant: 'pencil',
  nav: 'orbit', ortho: false, turntable: false, autoplay: true, importedLights: false,
  bloom: false, bloomStrength: 0.5, bloomRadius: 0.4, bloomThreshold: 1,
  thumbAngle: 'front',
};

const TONE = { neutral: THREE.NeutralToneMapping, aces: THREE.ACESFilmicToneMapping, agx: THREE.AgXToneMapping, none: THREE.NoToneMapping };

/** Camera distance so the box fits the view from direction `dir` (unit, target → camera). */
export function fitDistance(box, dir, fovY, aspect, margin = 1.06) {
  const center = box.getCenter(new THREE.Vector3());
  const forward = dir.clone().negate();
  const upRef = Math.abs(forward.y) > 0.99 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(forward, upRef).normalize();
  const up = new THREE.Vector3().crossVectors(right, forward).normalize();
  const tanY = Math.tan(THREE.MathUtils.degToRad(fovY) / 2);
  const tanX = tanY * aspect;
  let dist = 0;
  const c = new THREE.Vector3();
  for (let i = 0; i < 8; i++) {
    c.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(center);
    const x = Math.abs(c.dot(right)), y = Math.abs(c.dot(up)), z = c.dot(dir);
    dist = Math.max(dist, x / tanX + z, y / tanY + z);
  }
  return Math.max(dist * margin, 1e-4);
}

export function directionFromAngles(yawDeg, elevDeg) {
  const y = THREE.MathUtils.degToRad(yawDeg), e = THREE.MathUtils.degToRad(elevDeg);
  return new THREE.Vector3(Math.sin(y) * Math.cos(e), Math.sin(e), Math.cos(y) * Math.cos(e)).normalize();
}

export class Viewer extends EventTarget {
  constructor(canvas, wrap, settings = {}) {
    super();
    this.canvas = canvas;
    this.wrap = wrap;
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.history = new SettingsHistory();
    this.model = null;
    this.info = null;
    this.dirty = true;
    this.shadowDirty = true;
    this.fix = { quaternion: new THREE.Quaternion(), scale: 1 };

    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.setClearColor(0x000000, 0);

    this.scene = new THREE.Scene();
    this.stage = new THREE.Group(); this.stage.name = '__stage';
    this.place = new THREE.Group(); this.place.name = '__place';
    this.fixGroup = new THREE.Group(); this.fixGroup.name = '__fix';
    this.unit = new THREE.Group(); this.unit.name = '__unit';
    this.scene.add(this.stage);
    this.stage.add(this.place);
    this.place.add(this.fixGroup);
    this.fixGroup.add(this.unit);

    this.grid = new Grid();
    this.scene.add(this.grid);
    this.shadow = new ContactShadow(r);
    this.scene.add(this.shadow);

    // Lights only for the anime / sketch passes (the textured view is lit by the HDRI alone).
    this.styleLights = new THREE.Group();
    this.styleLights.name = '__styleLights';
    this.hemi = new THREE.HemisphereLight(0xffffff, 0xc9c2e6, 1.9);
    this.key = new THREE.DirectionalLight(0xffffff, 1.55);
    this.styleLights.add(this.hemi, this.key, this.key.target);
    this.styleLights.visible = false;
    this.scene.add(this.styleLights);

    this.persp = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 1000);
    for (const cam of [this.persp, this.ortho]) cam.layers.enable(HELPER_LAYER);
    this.camera = this.persp;
    this.persp.position.set(0, 1.2, 4);

    this.controls = new OrbitControls(this.camera, canvas);
    Object.assign(this.controls, { enableDamping: true, dampingFactor: 0.12, screenSpacePanning: true, zoomToCursor: true, rotateSpeed: 0.9, autoRotateSpeed: 2.2 });
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    this.controls.addEventListener('change', () => { this.dirty = true; });
    this.controls.addEventListener('start', () => wrap.classList.add('dragging-view'));
    this.controls.addEventListener('end', () => wrap.classList.remove('dragging-view'));

    this.fly = new FlyControls(this.camera, canvas);
    this.anim = new AnimationController();
    this.anim.addEventListener('change', () => { this.dirty = true; this.shadowDirty = true; });
    this.post = new StylePost(r);
    this.outputPass = new OutputPass();

    this.gizmoEl = wrap.querySelector('.gizmo');
    this.gizmo = new AxisGizmo(this.gizmoEl, (id) => this.viewFrom(id));

    canvas.addEventListener('dblclick', (e) => this.focusAt(e));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(wrap);
    this.resize();
    this.applyAll();

    this.clock = new THREE.Clock();
    const tick = () => { this.frameId = requestAnimationFrame(tick); this.tick(); };
    tick();
  }

  // ---------------------------------------------------------------- settings
  /**
   * Change one setting (or several: set({ a, b })). record: false keeps it out of undo;
   * merge / seal: a slider drag (many changes) that should undo as one step.
   */
  set(key, value, { record = true, merge = false, seal = false } = {}) {
    const changes = typeof key === 'object' ? key : { [key]: value };
    if (record) this.history.record(changes, this.settings, { merge, seal });
    Object.assign(this.settings, changes);
    for (const k of Object.keys(changes)) this.apply(k);
    this.dispatchEvent(new CustomEvent('settings', { detail: this.settings }));
    this.requestRender();
  }

  /** Ctrl+Z / Ctrl+Y over the look settings; returns the step that was undone/redone (or null). */
  undo() { const e = this.history.undo(); if (e) this.set(e.from, undefined, { record: false }); return e; }
  redo() { const e = this.history.redo(); if (e) this.set(e.to, undefined, { record: false }); return e; }

  applyAll() { for (const k of Object.keys(this.settings)) this.apply(k); }

  apply(key) {
    const s = this.settings;
    switch (key) {
      case 'env': this.loadEnv(s.env); break;
      case 'envStrength': this.scene.environmentIntensity = s.envStrength; if (s.background === 'hdri') this.scene.backgroundIntensity = s.envStrength; break;
      case 'envRotation': case 'envAutoRotate': this.applyEnvRotation(); break;
      case 'background': case 'bgBlur': case 'bgColor': this.applyBackground(); break;
      case 'exposure': this.renderer.toneMappingExposure = s.exposure; break;
      case 'toneMapping': this.renderer.toneMapping = TONE[s.toneMapping] ?? THREE.NeutralToneMapping; break;
      case 'grid': this.grid.visible = s.grid; break;
      case 'shadow': this.shadow.visible = s.shadow; this.shadowDirty = true; break;
      case 'gizmo': this.gizmoEl.hidden = !s.gizmo; break;
      case 'viewMode': case 'sketchVariant': this.applyViewMode(); break;
      case 'wireframe': this.modes?.setWireframe(s.wireframe); this.updateWireColor(); break;
      case 'flat': this.modes?.setFlat(s.flat); break;
      case 'nav': this.setNav(s.nav); break;
      case 'ortho': this.setOrtho(s.ortho); break;
      case 'turntable': this.controls.autoRotate = s.turntable; break;
      case 'importedLights': this.model?.traverse((o) => { if (o.isLight) o.visible = s.importedLights; }); break;
      case 'bloom': case 'bloomStrength': case 'bloomRadius': case 'bloomThreshold':
        if (s.bloom) this.ensureBloom();
        if (this.bloomPass) Object.assign(this.bloomPass, { strength: s.bloomStrength, radius: s.bloomRadius, threshold: s.bloomThreshold });
        break;
      default: break;
    }
    this.dirty = true;
  }

  async loadEnv(id) {
    try {
      const tex = await loadEnvironment(id);
      if (this.settings.env !== id) return;
      this.envTexture = tex;
      this.scene.environment = tex;
      this.scene.environmentIntensity = this.settings.envStrength;
      this.applyBackground();
      this.requestRender();
    } catch (e) { console.error('Environment failed', e); }
  }

  applyEnvRotation() {
    const a = THREE.MathUtils.degToRad(this.settings.envRotation) + (this.envSpin || 0);
    this.scene.environmentRotation.set(0, a, 0);
    this.scene.backgroundRotation.set(0, a, 0);
    this.dirty = true;
  }

  applyBackground() {
    const s = this.settings;
    this.wrap.classList.toggle('bg-dark', s.background === 'dark');
    this.wrap.classList.toggle('bg-hdri', s.background === 'hdri');
    this.wrap.classList.toggle('bg-solid', s.background === 'solid');
    if (s.background === 'hdri' && this.envTexture) {
      this.scene.background = this.envTexture;
      this.scene.backgroundBlurriness = s.bgBlur;
      this.scene.backgroundIntensity = s.envStrength;
    } else if (s.background === 'solid') {
      this.scene.background = new THREE.Color(s.bgColor);
    } else this.scene.background = null;
    this.dirty = true;
  }

  get styleMode() { return this.settings.viewMode === 'anime' || this.settings.viewMode === 'sketch'; }

  applyViewMode() {
    const m = this.settings.viewMode;
    if (this.modes) this.modes.apply(m === 'sketch' ? 'textured' : m);
    this.styleLights.visible = this.styleMode;
    this.wrap.classList.toggle('paper', m === 'sketch');
    this.updateWireColor();
    this.dirty = true;
  }

  updateWireColor() {
    const m = this.settings.viewMode;
    if (m === 'normal') this.modes?.setWireColor(0x1b1d2c, 0.55);
    else if (m === 'unlit' || m === 'textured') this.modes?.setWireColor(0x101114, 0.5);
    else this.modes?.setWireColor(0x15161a, 0.4);
  }

  setNav(mode) {
    const size = this.info?.size || 1;
    if (mode === 'fly') {
      if (!this.fly.enabled) this.flyPivot = this.controls.target.clone();   // the orbit point to come back to
      this.lookTween = null;
      this.controls.enabled = false;
      this.fly.camera = this.camera;
      this.fly.setEnabled(true, size);
      this.wrap.classList.add('fly');
    } else {
      const wasFlying = this.fly.enabled;
      this.fly.setEnabled(false);
      this.controls.enabled = true;
      this.wrap.classList.remove('fly');
      if (!wasFlying) { this.controls.update(); return; }
      // Orbit the same point as before flying (the model's centre unless you double-clicked elsewhere):
      // the camera stays where you flew to and turns smoothly to face it.
      const pivot = this.flyPivot || (this.model ? this.worldBox().getCenter(new THREE.Vector3()) : this.controls.target.clone());
      this.controls.target.copy(pivot);
      const cam = this.camera;
      if (cam.position.distanceTo(pivot) < size * 0.05) {
        cam.position.copy(pivot).addScaledVector(new THREE.Vector3(0, 0, 1).applyQuaternion(cam.quaternion), size * 1.5);
      }
      const look = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(cam.position, pivot, cam.up));
      this.lookTween = { t: 0, dur: 0.35, from: cam.quaternion.clone(), to: look };
    }
  }

  setOrtho(on) {
    const from = this.camera;
    const to = on ? this.ortho : this.persp;
    if (from === to) return;
    const target = this.controls.target;
    const dist = from.position.distanceTo(target);
    to.position.copy(from.position);
    to.quaternion.copy(from.quaternion);
    if (on) {
      const h = 2 * dist * Math.tan(THREE.MathUtils.degToRad(this.persp.fov) / 2);
      this.orthoHeight = h;
      this.ortho.zoom = 1;
    } else if (from.isOrthographicCamera) {
      const h = (this.orthoHeight || 2) / from.zoom;
      const d = h / (2 * Math.tan(THREE.MathUtils.degToRad(this.persp.fov) / 2));
      const dir = from.position.clone().sub(target).normalize();
      to.position.copy(target).addScaledVector(dir, d);
    }
    to.near = from.near; to.far = from.far;
    this.camera = to;
    this.controls.object = to;
    this.fly.camera = to;
    this.resize();
    this.controls.update();
  }

  // ---------------------------------------------------------------- loop
  requestRender() { this.dirty = true; }

  /** The model's own materials (not the view-mode copies), each with the meshes that use it. */
  materials() {
    const out = new Map();
    for (const e of this.modes?.entries || []) {
      for (const m of [].concat(e.original)) {
        if (!m) continue;
        if (!out.has(m)) out.set(m, { material: m, meshes: [] });
        const name = e.mesh.name || '(mesh)';
        if (!out.get(m).meshes.includes(name)) out.get(m).meshes.push(name);
      }
    }
    return [...out.values()];
  }

  /** Changes a loaded material and its copies in every view mode: apply(material, mode) ('original' for the model's own). */
  editMaterial(mat, apply) {
    apply(mat, 'original');
    this.modes?.forCopies(mat, apply);
    this.shadowDirty = true;
    this.requestRender();
  }

  tick() {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    let changed = this.dirty;
    this.dirty = false;
    if (this.tween) { this.stepTween(dt); changed = true; }
    if (this.lookTween) { this.stepLook(dt); changed = true; }
    else if (this.controls.enabled && this.controls.update(dt)) changed = true;
    if (this.fly.enabled && this.fly.update(dt)) changed = true;
    if (this.anim.update(dt)) { changed = true; this.shadowDirty = true; }
    if (this.settings.envAutoRotate) { this.envSpin = (this.envSpin || 0) + dt * 0.25; this.applyEnvRotation(); changed = true; }
    if (changed) this.render();
  }

  render(target = null, opts = {}) {
    const r = this.renderer;
    this.grid.update(this.camera);
    if (!target && !opts.capture) this.grid.visible = this.settings.grid && !!this.model;
    if (this.shadowDirty && this.settings.shadow && this.model) {
      this.shadow.update(this.scene, 1);
      this.shadowDirty = false;
    }
    if (this.styleMode && this.model) {
      // Key light follows the camera (upper left), so the cel/hatching reads well from any angle.
      const off = new THREE.Vector3(-0.6, 0.8, 0.9).applyQuaternion(this.camera.quaternion).multiplyScalar(this.info?.size || 2);
      this.key.position.copy(this.controls.target).add(off);
      this.key.target.position.copy(this.controls.target);
      const style = this.settings.viewMode === 'anime' ? 'anime' : this.settings.sketchVariant === 'ink' ? 'ink' : 'pencil';
      this.post.render(this.scene, this.camera, this.modes, style, target, { scale: opts.scale || r.getPixelRatio(), transparent: opts.transparent });
    } else if (this.settings.bloom && !target && this.ensureBloom()) {
      const size = r.getSize(new THREE.Vector2());
      const pr = r.getPixelRatio();
      if (this.composerSize !== `${size.x}x${size.y}@${pr}`) {
        this.composerSize = `${size.x}x${size.y}@${pr}`;
        this.composer.setPixelRatio(pr);
        this.composer.setSize(size.x, size.y);
      }
      this.renderPass.camera = this.camera;
      this.composer.render();
    } else {
      r.setRenderTarget(target);
      r.render(this.scene, this.camera);
    }
    if (!target && this.settings.gizmo) this.gizmo.update(this.camera);
  }

  /** Bloom pipeline (made the first time bloom is switched on): scene in HDR, glow, then tone mapping. */
  ensureBloom() {
    if (this.composer) return true;
    const s = this.settings;
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, rt);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(256, 256), s.bloomStrength, s.bloomRadius, s.bloomThreshold);
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());
    this.composerSize = null;
    return true;
  }

  resize() {
    const w = Math.max(1, this.wrap.clientWidth), h = Math.max(1, this.wrap.clientHeight);
    this.renderer.setSize(w, h, false);
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    const oh = (this.orthoHeight || 2) / 2;
    Object.assign(this.ortho, { left: -oh * w / h, right: oh * w / h, top: oh, bottom: -oh });
    this.ortho.updateProjectionMatrix();
    this.dirty = true;
  }

  // ---------------------------------------------------------------- model
  /**
   * @param path file to read (for .blend: the preview GLB made by Blender)
   * @param meta {sourcePath, kind, blendInfo, displayName}
   */
  async open(path, meta = {}, { onProgress, signal } = {}) {
    const result = await loadModel(path, {
      renderer: this.renderer, onProgress, signal, displayName: meta.displayName,
      onTexture: () => this.requestRender(),
    });
    if (signal?.aborted) { disposeObject(result.root); throw new DOMException('Cancelled', 'AbortError'); }
    this.clear();
    const root = this.model = result.root;
    this.unit.scale.setScalar(result.unitScale || 1);
    this.unit.add(root);
    root.traverse((o) => {
      if (o.isLight) o.visible = this.settings.importedLights;
      if (o.isMesh || o.isSkinnedMesh) { o.frustumCulled = !o.isSkinnedMesh; }
    });

    this.modes = new MaterialModes(root);
    this.applyViewMode();
    if (this.settings.flat) this.modes.setFlat(true);
    if (this.settings.wireframe) { this.modes.setWireframe(true); this.updateWireColor(); }

    this.anim.attach(root, result.clips);
    const stats = analyze(root, this.anim.clips);
    if (!stats.meshes && stats.boneCount) {
      // Animation-only file (e.g. Model@Run.fbx): show the bones so the motion is visible.
      this.skeletonHelper = new THREE.SkeletonHelper(root);
      this.skeletonHelper.userData.helper = true;
      this.skeletonHelper.material.depthTest = false;
      this.skeletonHelper.material.linewidth = 2;
      this.scene.add(this.skeletonHelper);
    }
    const human = humanoidMap(stats.boneList);
    const facing = detectFacing(this.unit, human);

    // Unity check: root nodes of the file should import with scale 1 and no rotation.
    const rootNodes = root.isGroup && root.children.length ? root.children.filter((c) => !c.isLight && !c.isCamera) : [root];
    const unity = { scaleOk: true, rotationOk: true, worst: null };
    for (const n of [root, ...rootNodes]) {
      const s = n.scale;
      const rot = n.rotation;
      const scaleOff = Math.max(Math.abs(s.x - 1), Math.abs(s.y - 1), Math.abs(s.z - 1));
      const rotOff = Math.max(Math.abs(rot.x), Math.abs(rot.y), Math.abs(rot.z));
      if (scaleOff > 1e-3) { unity.scaleOk = false; unity.worst = unity.worst || { name: n.name || '(root)', scale: s.toArray().map((v) => +v.toFixed(3)) }; }
      if (rotOff > 1e-3) { unity.rotationOk = false; unity.rot = unity.rot || { name: n.name || '(root)', deg: [rot.x, rot.y, rot.z].map((v) => +THREE.MathUtils.radToDeg(v).toFixed(1)) }; }
    }
    if (result.unitScaleFactor != null && Math.abs(result.unitScaleFactor - 100) > 1e-3) unity.fileScale = result.unitScaleFactor / 100;

    this.info = {
      path, sourcePath: meta.sourcePath || path, kind: meta.kind || 'model', displayName: result.displayName,
      format: meta.format || result.format, generator: result.generator, unitScale: result.unitScale, unitScaleFactor: result.unitScaleFactor,
      stats, human, facing, unity, textures: result.textures, blendInfo: meta.blendInfo || null,
    };
    this.fix.quaternion.identity();
    this.fix.scale = 1;
    this.fixGroup.quaternion.identity();
    this.fixGroup.scale.setScalar(1);
    this.layout();
    this.frame(false);
    this.dispatchEvent(new CustomEvent('model', { detail: this.info }));
    this.requestRender();
    return this.info;
  }

  /** Centers the model on the floor, fits grid/shadow and refreshes the measured size. */
  layout() {
    if (!this.model) return;
    this.place.position.set(0, 0, 0);
    this.stage.updateMatrixWorld(true);
    const box = measure(this.fixGroup, this.place);
    if (box.isEmpty()) box.set(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 1, 0.5));
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    this.place.position.set(-center.x, -box.min.y, -center.z);
    this.stage.updateMatrixWorld(true);
    const maxDim = Math.max(size.x, size.y, size.z);
    this.info.dims = size.clone();           // meters, as Unity will see it (after fix)
    this.info.size = maxDim;
    this.info.pivotOffset = new THREE.Vector3(center.x, box.min.y, center.z); // file origin vs bottom-center
    this.grid.fit(maxDim, Math.max(size.x, size.z) / 2);
    this.shadow.fit(size.x, size.z, size.y);
    this.shadow.position.set(0, Math.max(size.y * 0.001, 1e-5), 0);
    this.shadowDirty = true;
    const near = Math.max(maxDim / 2000, 1e-4);
    for (const cam of [this.persp, this.ortho]) { cam.near = near; cam.far = Math.max(maxDim * 200, 10); cam.updateProjectionMatrix(); }
    this.controls.minDistance = maxDim * 0.02;
    this.controls.maxDistance = maxDim * 60;
    this.dirty = true;
  }

  worldBox() {
    const box = measure(this.place);
    return box.isEmpty() ? new THREE.Box3(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 1, 0.5)) : box;
  }

  /** Standardization preview: rotation (Quaternion, in model space) and uniform scale factor. */
  setFix({ quaternion, scale } = {}) {
    if (quaternion) this.fix.quaternion.copy(quaternion);
    if (scale != null) this.fix.scale = scale;
    this.fixGroup.quaternion.copy(this.fix.quaternion);
    this.fixGroup.scale.setScalar(this.fix.scale);
    this.layout();
    this.dispatchEvent(new CustomEvent('fix', { detail: this.fix }));
    this.requestRender();
  }

  clear() {
    this.cancelTween();
    if (this.skeletonHelper) { this.scene.remove(this.skeletonHelper); this.skeletonHelper.dispose(); this.skeletonHelper = null; }
    this.anim.dispose();
    this.modes?.dispose();
    this.modes = null;
    if (this.model) { this.unit.remove(this.model); disposeObject(this.model); }
    this.model = null;
    this.info = null;
    this.requestRender();
  }

  // ---------------------------------------------------------------- camera
  frame(animate = true, dir = null) {
    const box = this.worldBox();
    const center = box.getCenter(new THREE.Vector3());
    const d = dir || directionFromAngles(24, 12);
    const aspect = this.persp.aspect;
    if (this.camera.isOrthographicCamera) {
      const dist = fitDistance(box, d, this.persp.fov, aspect, 1.12);
      this.orthoHeight = 2 * dist * Math.tan(THREE.MathUtils.degToRad(this.persp.fov) / 2);
      this.ortho.zoom = 1;
      this.resize();
      this.moveCamera(center.clone().addScaledVector(d, dist), center, animate);
    } else {
      const dist = fitDistance(box, d, this.persp.fov, aspect, 1.12);
      this.moveCamera(center.clone().addScaledVector(d, dist), center, animate);
    }
  }

  viewFrom(id) {
    const d = viewDirection(id);
    if (!d) return;
    this.frame(true, d);
  }

  moveCamera(pos, target, animate) {
    if (this.settings.nav === 'fly') { this.settings.nav = 'orbit'; this.setNav('orbit'); this.dispatchEvent(new CustomEvent('settings', { detail: this.settings })); }
    this.lookTween = null;   // this move replaces the turn back to the pivot
    if (!animate) {
      this.camera.position.copy(pos);
      this.controls.target.copy(target);
      this.camera.lookAt(target);
      this.controls.update();
      this.dirty = true;
      return;
    }
    this.tween = {
      t: 0, dur: 0.38,
      fromPos: this.camera.position.clone(), toPos: pos.clone(),
      fromTarget: this.controls.target.clone(), toTarget: target.clone(),
    };
  }

  stepTween(dt) {
    const tw = this.tween;
    tw.t = Math.min(1, tw.t + dt / tw.dur);
    const k = 1 - Math.pow(1 - tw.t, 3);
    // Interpolate around the target so the camera arcs instead of cutting through the model.
    const target = tw.fromTarget.clone().lerp(tw.toTarget, k);
    const a = tw.fromPos.clone().sub(tw.fromTarget), b = tw.toPos.clone().sub(tw.toTarget);
    const la = a.length(), lb = b.length();
    const qa = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), a.clone().normalize());
    const qb = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), b.clone().normalize());
    const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(qa.slerp(qb, k));
    this.camera.position.copy(target).addScaledVector(dir, la + (lb - la) * k);
    this.controls.target.copy(target);
    this.camera.lookAt(target);
    if (tw.t >= 1) { this.tween = null; this.controls.update(); }
  }

  cancelTween() { this.tween = null; this.lookTween = null; }

  stepLook(dt) {
    const lt = this.lookTween;
    lt.t = Math.min(1, lt.t + dt / lt.dur);
    this.camera.quaternion.slerpQuaternions(lt.from, lt.to, 1 - Math.pow(1 - lt.t, 3));
    if (lt.t >= 1) { this.lookTween = null; this.controls.update(); }
  }

  focusAt(e) {
    if (!this.model || this.settings.nav !== 'orbit') return;
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    ray.layers.set(0);
    const hit = ray.intersectObject(this.model, true).find((h) => !h.object.userData.helper);
    if (!hit) return;
    const offset = this.camera.position.clone().sub(this.controls.target);
    this.moveCamera(hit.point.clone().add(offset.multiplyScalar(0.7)), hit.point, true);
  }

  // ---------------------------------------------------------------- capture
  /**
   * PNG screenshot at `scale`× the viewport. background: 'transparent' | 'dark' | 'current'.
   * Renders straight into the (temporarily enlarged) canvas so tone mapping, styles and colors match the screen.
   */
  async screenshot({ scale = 2, background = 'transparent', grid = false, maxSize = 8192 } = {}) {
    const r = this.renderer;
    const w = this.wrap.clientWidth, h = this.wrap.clientHeight;
    let W = Math.round(w * scale), H = Math.round(h * scale);
    const limit = Math.min(maxSize, r.capabilities.maxTextureSize || 8192);
    if (Math.max(W, H) > limit) { const k = limit / Math.max(W, H); W = Math.round(W * k); H = Math.round(H * k); }
    const prev = { pr: r.getPixelRatio(), bg: this.scene.background, grid: this.grid.visible, gizmo: this.settings.gizmo };
    const cssBackground = background === 'current' && (this.settings.background === 'gradient' || this.settings.background === 'dark');
    r.setPixelRatio(1);
    r.setSize(W, H, false);
    this.grid.visible = grid && prev.grid;
    if (background === 'transparent' || cssBackground) this.scene.background = null;
    else if (background === 'dark') this.scene.background = new THREE.Color(0x0b0c0e);
    let blob;
    try {
      this.render(null, { scale: W / w, transparent: background === 'transparent' || cssBackground, capture: true });
      blob = await new Promise((res) => this.canvas.toBlob(res, 'image/png'));
    } finally {
      this.scene.background = prev.bg;
      this.grid.visible = prev.grid;
      r.setPixelRatio(prev.pr);
      this.resize();
      this.render();
    }
    if (cssBackground && blob) blob = await compositeOnGradient(blob, W, H, this.settings.background === 'dark');
    return { blob, width: W, height: H };
  }

  /**
   * Puts every skinned mesh's bones in its bind pose: the shape exactly as modeled (T/A-pose), whatever
   * pose the file stores. bone world = meshWorld · bindMatrix⁻¹ · boneInverse⁻¹. Returns a restore function.
   */
  applyBindPose() {
    const meshes = [];
    this.model?.traverse((o) => { if (o.isSkinnedMesh && o.skeleton) meshes.push(o); });
    if (!meshes.length) return null;
    meshes.sort((a, b) => b.skeleton.bones.length - a.skeleton.bones.length);
    const saved = [];
    const done = new Set();
    const depth = (o) => { let d = 0; for (let x = o; x.parent; x = x.parent) d++; return d; };
    this.model.updateMatrixWorld(true);
    for (const mesh of meshes) {
      const C = mesh.matrixWorld.clone().multiply(mesh.bindMatrix.clone().invert());
      const list = mesh.skeleton.bones.map((b, i) => [b, i]).filter(([b]) => b && !done.has(b)).sort((x, y) => depth(x[0]) - depth(y[0]));
      for (const [b, i] of list) {
        saved.push([b, b.position.clone(), b.quaternion.clone(), b.scale.clone()]);
        const W = C.clone().multiply(mesh.skeleton.boneInverses[i].clone().invert());
        b.parent.updateWorldMatrix(true, false);
        b.parent.matrixWorld.clone().invert().multiply(W).decompose(b.position, b.quaternion, b.scale);
        b.updateMatrixWorld(true);
        done.add(b);
      }
    }
    return () => {
      for (const [b, p, q, s] of saved) { b.position.copy(p); b.quaternion.copy(q); b.scale.copy(s); }
      this.model?.updateMatrixWorld(true);
    };
  }

  /**
   * Thumbnails show the file's own pose (a posed character stays posed). Some exports store a broken
   * default pose (Auto-Rig Pro outfit FBX files collapse flat without their pose action): when the stored
   * pose is wildly larger or smaller than the modeled shape, the bind pose is used instead.
   */
  thumbnailPose() {
    if (this.anim.index >= 0) return () => {};
    const stored = this.worldBox().getSize(new THREE.Vector3());
    const restore = this.applyBindPose();
    if (!restore) return () => {};
    const bind = this.worldBox().getSize(new THREE.Vector3());
    const ratio = Math.max(stored.x, stored.y, stored.z) / Math.max(bind.x, bind.y, bind.z, 1e-9);
    const flat = (v) => Math.min(v.x, v.y, v.z) / Math.max(v.x, v.y, v.z, 1e-9);
    const broken = ratio > 1.8 || ratio < 0.55 || flat(stored) < flat(bind) * 0.3;
    this.lastThumbPose = { stored: stored.toArray(), bind: bind.toArray(), ratio, broken };
    if (!broken) { restore(); return () => {}; }
    return () => { restore(); this.layout(); };
  }

  /**
   * Standard library thumbnail: front view (+Z, Unity forward), transparent background, textured,
   * rest pose. Rendered off-screen so the view on screen does not change.
   */
  async thumbnail({ size = 384, angle = this.settings.thumbAngle, useCurrentView = false } = {}) {
    if (!this.model) return null;
    const restorePose = useCurrentView ? () => {} : this.thumbnailPose();
    try { return await this.renderThumbnail(size, angle, useCurrentView); }
    finally { restorePose(); }
  }

  async renderThumbnail(size, angle, useCurrentView) {
    const r = this.renderer;
    const rtHdr = new THREE.WebGLRenderTarget(size, size, { type: THREE.HalfFloatType, samples: 4 });
    const rtOut = new THREE.WebGLRenderTarget(size, size);
    const cam = new THREE.PerspectiveCamera(30, 1, 0.001, 1000);
    const box = this.worldBox();
    const center = box.getCenter(new THREE.Vector3());
    if (useCurrentView) {
      const dir = this.camera.position.clone().sub(this.controls.target).normalize();
      const dist = fitDistance(box, dir, cam.fov, 1, 1.04);
      cam.position.copy(center).addScaledVector(dir, dist);
    } else {
      const dir = angle === 'threeQuarter' ? directionFromAngles(32, 14) : directionFromAngles(0, 6);
      cam.position.copy(center).addScaledVector(dir, fitDistance(box, dir, cam.fov, 1, 1.04));
    }
    cam.near = Math.max(box.getSize(new THREE.Vector3()).length() / 1000, 1e-4);
    cam.far = cam.position.distanceTo(center) * 10;
    cam.lookAt(center);
    cam.updateProjectionMatrix();
    cam.layers.enable(HELPER_LAYER);

    const prev = { bg: this.scene.background, grid: this.grid.visible, mode: this.modes?.mode, wire: this.settings.wireframe, styleLights: this.styleLights.visible };
    this.scene.background = null;
    this.grid.visible = false;
    if (prev.wire) this.modes.setWireframe(false);
    this.modes?.apply('textured');
    this.styleLights.visible = false;
    if (this.settings.shadow) this.shadow.update(this.scene, 1);
    const clear = r.getClearColor(new THREE.Color()), alpha = r.getClearAlpha();
    r.setClearColor(0x000000, 0);
    r.setRenderTarget(rtHdr);
    r.clear();
    r.render(this.scene, cam);
    this.outputPass.render(r, rtOut, rtHdr);
    const px = new Uint8Array(size * size * 4);
    r.readRenderTargetPixels(rtOut, 0, 0, size, size, px);
    r.setRenderTarget(null);
    r.setClearColor(clear, alpha);
    this.scene.background = prev.bg;
    this.grid.visible = prev.grid;
    this.applyViewMode();
    if (prev.wire) { this.modes.setWireframe(true); this.updateWireColor(); }
    rtHdr.dispose(); rtOut.dispose();
    this.requestRender();
    return pixelsToBlob(px, size, size, 'image/webp', 0.9);
  }

  dispose() {
    cancelAnimationFrame(this.frameId);
    this.resizeObserver.disconnect();
    this.clear();
    this.controls.dispose();
    this.post.dispose();
    this.composer?.dispose();
    this.bloomPass?.dispose();
    this.shadow.dispose();
    this.renderer.dispose();
  }
}

export function disposeObject(root) {
  root.traverse((o) => {
    o.geometry?.dispose?.();
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!m) continue;
      for (const v of Object.values(m)) if (v?.isTexture) v.dispose();
      m.dispose?.();
    }
    if (o.isSkinnedMesh) o.skeleton?.dispose?.();
  });
}

/** RGBA pixels from readRenderTargetPixels (bottom-up, premultiplied) → image blob. */
export async function pixelsToBlob(px, w, h, type = 'image/png', quality) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * w * 4, dst = y * w * 4;
    for (let x = 0; x < w * 4; x += 4) {
      const a = px[src + x + 3];
      if (a > 0 && a < 255) {
        const k = 255 / a;
        out[dst + x] = px[src + x] * k; out[dst + x + 1] = px[src + x + 1] * k; out[dst + x + 2] = px[src + x + 2] * k;
      } else { out[dst + x] = px[src + x]; out[dst + x + 1] = px[src + x + 1]; out[dst + x + 2] = px[src + x + 2]; }
      out[dst + x + 3] = a;
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').putImageData(new ImageData(out, w, h), 0, 0);
  return new Promise((res) => canvas.toBlob(res, type, quality));
}

async function compositeOnGradient(blob, W, H, dark) {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  if (dark) { ctx.fillStyle = '#0d0e10'; ctx.fillRect(0, 0, W, H); }
  else {
    ctx.fillStyle = '#2a2c30';
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.translate(W / 2, H * 0.42);
    ctx.scale(W * 0.70, H * 0.62);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    g.addColorStop(0, '#3a3c43');
    g.addColorStop(0.72, '#2a2c30');
    g.addColorStop(1, '#2a2c30');
    ctx.fillStyle = g;
    ctx.fillRect(-2, -2, 4, 4);
    ctx.restore();
  }
  ctx.drawImage(bmp, 0, 0);
  return new Promise((res) => c.toBlob(res, 'image/png'));
}
