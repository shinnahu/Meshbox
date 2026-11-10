import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { app, loadIndex, entry, updateEntry, saveThumbnail, savePrefs, blobToBase64 } from './app.js';
import { call, on as onHost, dropPaths, basename, extname, dirname, stem, joinPath, blendThumbUrl, newJobId, hasHost } from './host.js';
import { hydrateIcons } from './icons.js';
import { $, h, ic, toast, showMenu, menuAt, closePopover, closeMenu, store, debounce, fmtBytes, setChildren, setLengthUnit } from './dom.js';
import { Viewer } from './viewer/Viewer.js';
import { describeChange } from './viewer/history.js';
import { MODEL_EXTS, loadModel } from './viewer/loaders.js';
import { retargetClips } from './viewer/animation.js';
import { initStage, showLoading, setLoading, hideLoading, loadingError, showEmpty, renderOverlays, syncTools, toggleNav } from './ui/stage.js';
import { initPanels, refreshPanel, togglePanel, openPanel } from './ui/panels.js';
import { openSettings } from './ui/settings.js';
import { initLibrary, showLibrary, isLibraryOpen, metaFromInfo, organizeFile, libraryUp } from './library/library.js';

// Keep the last errors around for diagnostics (Settings → About could show them; also handy when debugging).
window.__errors = [];
window.addEventListener('error', (e) => window.__errors.push(String(e.message || e.error)));
window.addEventListener('unhandledrejection', (e) => window.__errors.push('unhandled: ' + String(e.reason?.stack || e.reason)));

const PERSIST = ['env', 'envStrength', 'envRotation', 'envAutoRotate', 'background', 'bgBlur', 'bgColor', 'exposure', 'toneMapping', 'grid', 'gizmo', 'stats', 'dims', 'shadow',
  'viewMode', 'wireframe', 'flat', 'sketchVariant', 'autoplay', 'importedLights', 'thumbAngle', 'turntable'];

let viewer;
let loadCtrl = null;
let blendJob = null;

async function boot() {
  hydrateIcons();
  let init;
  try { init = await call('app.init'); }
  catch { init = { settings: { scanRoots: [], textureFolders: [] }, blender: [], dev: true, version: 'dev', dataDir: '', screenshotDir: '' }; }
  app.host = init;
  if (init.dev) document.title += ' (dev)';

  const saved = store('viewer') || {};
  viewer = app.viewer = new Viewer($('#gl'), $('#canvasWrap'), { ...saved, nav: 'orbit', ortho: false });
  window.__app = app;
  window.__dbg = { loadModel, retargetClips, THREE };
  viewer.addEventListener('settings', debounce(() => store('viewer', Object.fromEntries(PERSIST.map((k) => [k, viewer.settings[k]]))), 300));

  Object.assign(app.actions, { open, openDialog, showLibrary, screenshot, toggleFullscreen, loadAnimations, exportGLB, openSettings, addTextureFolder, thumbFromView, setUnits });
  setLengthUnit(app.prefs.units || 'cm');
  initStage();
  initPanels();
  initLibrary();
  wireTopBar();
  wireKeys();
  wireDrop();
  onHost('open', (d) => d?.path && open(d.path));
  onHost('fullscreen', (d) => { document.body.classList.toggle('fullscreen', !!d?.on); viewer.resize(); syncTools(); });
  const indexReady = loadIndex();
  if (init.file) open(init.file);
  else {
    showEmpty(true);
    indexReady.then(() => { if (!viewer.model && !$('#empty').hidden) showEmpty(true); });
  }
}

// ---------------------------------------------------------------- top bar
function wireTopBar() {
  $('#btnOpen').addEventListener('click', openDialog);
  $('#btnLibrary').addEventListener('click', () => showLibrary(!isLibraryOpen()));
  $('#btnSettings').addEventListener('click', () => openSettings());
  $('#btnCloseModel').addEventListener('click', closeModel);
  $('#btnOrganize').addEventListener('click', () => { const p = app.current?.path; if (p) organizeFile(p); });
  $('#btnNewWindow').addEventListener('click', () => call('app.openWindow', {}));
  $('#fileChip').addEventListener('click', async (e) => {
    const anchor = e.currentTarget;
    let recent = [];
    try { recent = await call('recent.list'); } catch { /* none */ }
    const cur = app.current?.path;
    menuAt(anchor, [
      cur ? { label: 'Show in Explorer', icon: 'folder', onClick: () => call('fs.reveal', { path: cur }) } : null,
      cur ? { label: 'Open in new window', icon: 'app-window', onClick: () => call('app.openWindow', { path: cur }) } : null,
      cur && extname(cur) === '.blend' ? { label: 'Open in Blender', icon: 'blender', onClick: () => call('fs.openInBlender', { path: cur }) } : null,
      cur ? { label: 'Reload', icon: 'refresh', hint: 'Ctrl+R', onClick: () => open(cur, { force: extname(cur) === '.blend' }) } : null,
      cur ? { label: 'Close model', icon: 'x', hint: 'Ctrl+W', onClick: closeModel } : null,
      '-',
      { header: 'Recent' },
      ...recent.filter((p) => p !== cur).slice(0, 12).map((p) => ({ label: basename(p), hint: basename(dirname(p)), icon: extname(p) === '.blend' ? 'blender' : 'box', onClick: () => open(p) })),
    ], { minWidth: 300 });
  });
}

/** Lengths in centimeters or inches, everywhere (size overlay, panels, organize). */
function setUnits(u) {
  app.prefs.units = u === 'in' ? 'in' : 'cm';
  savePrefs();
  setLengthUnit(app.prefs.units);
  renderOverlays();
  refreshPanel();
}

/** Back to the start screen: unloads the model (and stops a load in progress). */
function closeModel() {
  loadCtrl?.abort();
  hideLoading();
  if (viewer.model || app.current) {
    viewer.clear();
    app.current = null;
    viewer.dispatchEvent(new CustomEvent('model', { detail: null }));
  }
  setTitle(null);
  showEmpty(true);
}

function setTitle(path) {
  const chip = $('#fileChip');
  $('#btnOrganize').hidden = !path;
  $('#btnCloseModel').hidden = !path;
  if (!path) { chip.hidden = true; call('window.title', { title: 'Meshbox' }).catch(() => {}); return; }
  chip.hidden = false;
  $('#fileName').textContent = basename(path);
  $('#fileFmt').textContent = extname(path).slice(1).toUpperCase();
  chip.dataset.tip = path;
  call('window.title', { title: `${basename(path)} - Meshbox` }).catch(() => {});
}

// ---------------------------------------------------------------- open
async function openDialog() {
  const files = await call('dialog.open', {
    title: 'Open 3D model', multi: true,
    initialDir: app.current ? dirname(app.current.path) : undefined,
    filters: [
      { name: '3D models', exts: MODEL_EXTS.map((e) => e.slice(1)) },
      { name: 'FBX', exts: ['fbx'] }, { name: 'Blender', exts: ['blend'] }, { name: 'glTF / GLB / VRM', exts: ['glb', 'gltf', 'vrm'] },
      { name: 'All files', exts: ['*'] },
    ],
  });
  if (!files?.length) return;
  open(files[0]);
  for (const f of files.slice(1)) call('app.openWindow', { path: f });
}

export async function open(path, { force = false } = {}) {
  const ext = extname(path);
  if (!MODEL_EXTS.includes(ext)) { toast(`${ext ? ext.toUpperCase().slice(1) + ' files' : 'This file'} can't be opened as a 3D model.`, { kind: 'bad' }); return; }
  if (isLibraryOpen()) showLibrary(false);
  closePopover();
  loadCtrl?.abort();
  if (blendJob) { call('job.cancel', { jobId: blendJob }).catch(() => {}); blendJob = null; }
  const ctrl = loadCtrl = new AbortController();
  const stat = await call('fs.stat', { path }).catch(() => null);
  if (stat && !stat.exists) {
    loadingError('File not found', path, [{ label: 'Remove from recent', onClick: async () => { await call('recent.remove', { path }); hideLoading(); showEmpty(!viewer.model); } }]);
    return;
  }
  const existing = entry(path);
  showLoading({
    title: basename(path),
    thumb: existing?.thumb ? null : ext === '.blend' ? blendThumbUrl(path, stat?.modified) : null,
    onCancel: () => { ctrl.abort(); if (blendJob) call('job.cancel', { jobId: blendJob }).catch(() => {}); hideLoading(); if (!viewer.model) showEmpty(true); },
  });
  try {
    let info;
    let header = null;
    if (ext === '.blend') {
      header = await call('blend.header', { path }).catch(() => null);
      const blender = app.host.blender?.[0];
      setLoading({ text: blender ? `Converting with Blender ${blender.version}…` : 'Blender is needed to preview .blend files', indeterminate: true });
      const jobId = blendJob = newJobId();
      const off = onHost('job.progress', (d) => { if (d.jobId === jobId) setLoading({ progress: d.progress * 0.85, text: d.message }); });
      let res;
      try { res = await call('blender.preview', { path, jobId, force }); }
      finally { off(); if (blendJob === jobId) blendJob = null; }
      if (ctrl.signal.aborted) return;
      setLoading({ progress: 0.88, text: res.cached ? 'Opening cached preview…' : 'Loading preview…' });
      info = await viewer.open(res.glb, { sourcePath: path, kind: 'blend', blendInfo: res.info, displayName: basename(path), format: `Blender ${header?.version || res.info?.fileVersion || ''} (.blend)` },
        { signal: ctrl.signal, onProgress: (p) => progress(p, 0.88, 0.12) });
    } else {
      info = await viewer.open(path, { sourcePath: path, kind: 'model' }, { signal: ctrl.signal, onProgress: (p) => progress(p, 0, 1) });
    }
    if (ctrl.signal.aborted) return;
    app.current = { path, ext, info, header, size: stat?.size, modified: stat?.modified };
    hideLoading();
    showEmpty(false);
    setTitle(path);
    call('recent.add', { path }).catch(() => {});

    // Saved standardization (facing / size) for this model.
    const e = entry(path);
    if (e?.fix && ((e.fix.q && Math.abs(e.fix.q[3]) < 0.99999) || (e.fix.scale && e.fix.scale !== 1))) {
      viewer.setFix({ quaternion: new THREE.Quaternion().fromArray(e.fix.q || [0, 0, 0, 1]), scale: e.fix.scale || 1 });
      viewer.frame(false);
    }
    renderOverlays();
    refreshPanel();

    // Library thumbnail + facts, taken in the rest pose before any clip plays.
    const stale = !e?.thumb || (!e.thumbManual && e.thumbFor && stat?.modified && new Date(e.thumbFor).getTime() !== new Date(stat.modified).getTime());
    if (stale || !e?.meta) {
      try {
        if (stale) await saveThumbnail(path, await viewer.thumbnail({ size: 384 }), { modelStamp: stat?.modified });
        updateEntry(path, { meta: metaFromInfo(info) });
      } catch (err) { console.warn('thumbnail', err); }
    }

    if (viewer.anim.clips.length && viewer.settings.autoplay) viewer.anim.select(0, true);
    if (!info.stats.meshes) {
      toast(info.stats.boneCount ? 'Animation-only file: showing its skeleton. Open the model and use Load animations to see it on the character.' : 'This file contains no geometry.', { timeout: 7000 });
    }
    const missing = info.blendInfo?.images
      ? info.blendInfo.images.filter((i) => i.usedByMaterials !== false && !i.packed && i.source === 'FILE' && !i.exists && !i.foundAt).length
      : info.textures?.filter((t) => t.status === 'missing').length;
    if (missing) toast(`${missing} texture${missing > 1 ? 's' : ''} not found. See Model info.`, { kind: 'bad', action: { label: 'Show', fn: () => openPanel('info') } });
    else if (info.facing && !info.facing.ok && !(e?.fix?.q)) toast(`This character ${info.facing.label.toLowerCase()}. Unity expects +Z.`, { action: { label: 'Fix', fn: () => openPanel('export') } });
  } catch (err) {
    if (ctrl.signal.aborted || err?.name === 'AbortError' || err?.cancelled) return;
    console.error(err);
    const actions = [];
    if (ext === '.blend' && /Blender was not found|needs Blender/i.test(err.message)) actions.push({ label: 'Settings', primary: true, onClick: () => { hideLoading(); openSettings(); } });
    actions.push({ label: 'Show in Explorer', onClick: () => call('fs.reveal', { path }) });
    loadingError(`Could not open ${basename(path)}`, err.message || String(err), actions);
  } finally {
    if (loadCtrl === ctrl) loadCtrl = null;
  }
}

function progress(p, base, span) {
  if (p.stage === 'download') {
    const frac = p.total ? p.loaded / p.total : null;
    setLoading({ progress: frac == null ? null : base + frac * span * 0.6, text: `Reading file… ${fmtBytes(p.loaded)}${p.total ? ' / ' + fmtBytes(p.total) : ''}`, indeterminate: frac == null });
  } else if (p.stage === 'parse') setLoading({ text: 'Building the model…', indeterminate: true });
  else if (p.stage === 'textures') {
    if (p.total) setLoading({ progress: base + span * (0.6 + 0.4 * (p.loaded / p.total)), text: `Loading textures ${p.loaded} / ${p.total}` });
  }
}

// ---------------------------------------------------------------- actions
async function screenshot({ clipboard = false } = {}) {
  if (!viewer.model) { toast('Open a model first.'); return; }
  const p = app.prefs.screenshot;
  const close = toast('Rendering screenshot…', { timeout: 60000 });
  try {
    const { blob, width, height } = await viewer.screenshot({ scale: p.scale, background: p.background, grid: p.grid });
    const data = await blobToBase64(blob);
    close();
    if (clipboard) { await call('clipboard.png', { data }); toast(`Copied ${width} × ${height} PNG to the clipboard`, { kind: 'ok' }); return; }
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const name = `${stem(app.current?.path || 'model')}_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.png`;
    const dir = app.host.settings?.screenshotDir || app.host.screenshotDir;
    let path = joinPath(dir, name);
    if (p.ask) {
      path = await call('dialog.save', { title: 'Save screenshot', defaultName: name, initialDir: dir, filters: [{ name: 'PNG image', exts: ['png'] }] });
      if (!path) return;
    }
    await call('fs.writeBase64', { path, data });
    toast(`Saved ${basename(path)} (${width} × ${height})`, { kind: 'ok', action: { label: 'Show', fn: () => call('fs.reveal', { path }) } });
  } catch (e) { close(); toast('Screenshot failed: ' + e.message, { kind: 'bad' }); }
}

async function thumbFromView() {
  if (!viewer.model) return;
  const blob = await viewer.thumbnail({ size: 384, useCurrentView: true });
  await saveThumbnail(app.current.path, blob, { manual: true, modelStamp: app.current.modified });
  toast('Thumbnail set from the current view', { kind: 'ok' });
}

async function toggleFullscreen(force) {
  try {
    const on = await call('window.fullscreen', force == null ? {} : { on: force });
    document.body.classList.toggle('fullscreen', !!on);
  } catch {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.(); else document.exitFullscreen?.();
  }
  setTimeout(() => { viewer.resize(); syncTools(); }, 60);
}

async function addTextureFolder() {
  const dir = await call('dialog.folder', { title: 'Folder with the missing textures' });
  if (!dir) return;
  const list = [...(app.host.settings.textureFolders || []), dir];
  app.host.settings = await call('settings.set', { patch: { textureFolders: list } });
  if (app.current) open(app.current.path);
}

async function loadAnimations(paths) {
  if (!viewer.model) { toast('Open a rigged model first.'); return; }
  if (!paths) {
    paths = await call('dialog.open', { title: 'Load animations or poses', multi: true, initialDir: dirname(app.current.path), filters: [{ name: 'Animations', exts: ['fbx', 'glb', 'gltf'] }] });
    if (!paths?.length) return;
  }
  const close = toast(`Loading ${paths.length} animation file${paths.length > 1 ? 's' : ''}…`, { timeout: 120000 });
  let added = 0, firstNew = -1;
  const errors = [];
  for (const p of paths) {
    try {
      const res = await loadModel(p, { renderer: viewer.renderer });
      if (!res.clips.length) { errors.push(`${basename(p)}: no animation`); continue; }
      const r = retargetClips(viewer.model, res.root, res.clips, {
        targetSpace: viewer.fixGroup, sourceUnitScale: res.unitScale || 1,
        targetRest: (o) => viewer.anim.restPose.get(o) || null,
        // Humanoid retargeting samples in world space: drop the viewer's centering/fix so the target is in metres at the origin.
        neutralize: () => {
          const p = viewer.place.position.clone(), q = viewer.fixGroup.quaternion.clone(), s = viewer.fixGroup.scale.clone();
          viewer.place.position.set(0, 0, 0); viewer.fixGroup.quaternion.identity(); viewer.fixGroup.scale.setScalar(1);
          viewer.stage.updateMatrixWorld(true);
          return () => { viewer.place.position.copy(p); viewer.fixGroup.quaternion.copy(q); viewer.fixGroup.scale.copy(s); viewer.stage.updateMatrixWorld(true); };
        },
      });
      for (const c of r.clips) {
        const clipLabel = c.name && !/^(Take 001|mixamo\.com|Armature\|mixamo\.com|Scene)$/i.test(c.name) ? c.name : stem(p).split('@').pop();
        c.name = res.clips.length === 1 ? stem(p).split('@').pop() : clipLabel;
        c.userData = { ...(c.userData || {}), source: basename(p), sourcePath: p, retarget: r.method };
      }
      const start = viewer.anim.addClips(r.clips);
      if (firstNew < 0) firstNew = start;
      added += r.clips.length;
    } catch (e) { errors.push(`${basename(p)}: ${e.message}`); }
  }
  close();
  if (added) {
    toast(`Added ${added} animation${added > 1 ? 's' : ''}`, { kind: 'ok' });
    viewer.anim.select(firstNew, true);
    if (app.prefs.panel === 'anim') refreshPanel();
  }
  if (errors.length) toast(errors.slice(0, 3).join('\n'), { kind: 'bad' });
}

async function exportGLB() {
  if (!viewer.model) return;
  const src = viewer.info.sourcePath;
  const path = await call('dialog.save', { title: 'Export GLB', defaultName: stem(src) + '.glb', initialDir: dirname(src), filters: [{ name: 'glTF binary', exts: ['glb'] }] });
  if (!path) return;
  const close = toast('Exporting GLB…', { timeout: 120000 });
  const prevMode = viewer.modes.mode;
  const wire = viewer.settings.wireframe;
  try {
    if (wire) viewer.modes.setWireframe(false);
    viewer.modes.apply('textured');
    const buf = await new GLTFExporter().parseAsync(viewer.fixGroup, { binary: true, onlyVisible: true, animations: viewer.anim.clips, maxTextureSize: 4096 });
    const data = await blobToBase64(new Blob([buf], { type: 'model/gltf-binary' }));
    await call('fs.writeBase64', { path, data });
    close();
    toast(`Exported ${basename(path)}`, { kind: 'ok', action: { label: 'Show', fn: () => call('fs.reveal', { path }) } });
  } catch (e) { close(); toast('GLB export failed: ' + e.message, { kind: 'bad' }); }
  finally {
    viewer.modes.apply(prevMode);
    if (wire) viewer.modes.setWireframe(true);
    viewer.applyViewMode();
  }
}

// ---------------------------------------------------------------- keyboard
function wireKeys() {
  window.addEventListener('keydown', (e) => {
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    if (document.querySelector('.modal-backdrop')) return;
    const ctrl = e.ctrlKey || e.metaKey;
    // Ctrl+Z / Ctrl+Y (Ctrl+Shift+Z): undo the look settings. Text fields keep their own undo,
    // but a focused slider (or its number box) is not "typing".
    const textField = typing && !(t.tagName === 'INPUT' && (t.type === 'range' || t.type === 'checkbox' || t.type === 'radio' || t.closest('.slider-row')));
    if (ctrl && !textField && (e.code === 'KeyZ' || e.code === 'KeyY')) {
      e.preventDefault();
      if (t?.closest?.('.slider-row')) t.blur();
      const redo = e.code === 'KeyY' || e.shiftKey;
      const step = redo ? viewer.redo() : viewer.undo();
      toast(step ? `${redo ? 'Redo' : 'Undo'}: ${describeChange(step, redo ? 'to' : 'from')}` : `Nothing to ${redo ? 'redo' : 'undo'}`, { timeout: 2200 });
      syncTools();
      return;
    }
    if (ctrl && e.code === 'KeyO') { e.preventDefault(); openDialog(); return; }
    if (ctrl && e.code === 'KeyN') { e.preventDefault(); call('app.openWindow', {}); return; }
    if (ctrl && e.code === 'KeyR') { e.preventDefault(); if (app.current) open(app.current.path); return; }
    if (ctrl && e.code === 'KeyW') { e.preventDefault(); closeModel(); return; }
    if (ctrl && e.shiftKey && e.code === 'KeyS') { e.preventDefault(); screenshot(); return; }
    if (ctrl && e.code === 'KeyC' && !typing && viewer.model && !window.getSelection()?.toString()) { e.preventDefault(); screenshot({ clipboard: true }); return; }
    if (e.code === 'F11') { e.preventDefault(); toggleFullscreen(); return; }
    if (e.code === 'Escape') {
      closeMenu();
      if (document.querySelector('.pop')) { closePopover(); return; }
      if (document.body.classList.contains('fullscreen')) { toggleFullscreen(false); return; }
      if (isLibraryOpen()) { const d = document.querySelector('.versions-drawer'); if (d) d.remove(); else showLibrary(false); return; }
      return;
    }
    if (typing || ctrl || e.altKey) return;
    const fly = viewer.settings.nav === 'fly';
    if (isLibraryOpen()) { if (e.code === 'KeyL') showLibrary(false); else if (e.code === 'Backspace') { e.preventDefault(); libraryUp(); } return; }
    const k = e.code;
    const viewKeys = { Digit1: 'solid', Digit2: 'textured', Digit3: 'normal', Digit4: 'unlit', Digit5: 'anime', Digit6: 'sketch' };
    if (viewKeys[k]) { viewer.set('viewMode', viewKeys[k]); return; }
    switch (k) {
      case 'Numpad1': viewer.viewFrom(e.ctrlKey ? '-z' : '+z'); break;
      case 'Numpad3': viewer.viewFrom(e.ctrlKey ? '-x' : '+x'); break;
      case 'Numpad7': viewer.viewFrom(e.ctrlKey ? '-y' : '+y'); break;
      case 'Numpad5': viewer.set('ortho', !viewer.settings.ortho); break;
      case 'NumpadDecimal': case 'KeyF': if (!fly || k === 'KeyF') viewer.frame(true); break;
      case 'KeyG': viewer.set('grid', !viewer.settings.grid); break;
      case 'KeyW': if (!fly) viewer.set('wireframe', !viewer.settings.wireframe); break;
      case 'KeyN': toggleNav(); break;
      case 'KeyO': viewer.set('ortho', !viewer.settings.ortho); break;
      case 'KeyT': viewer.set('turntable', !viewer.settings.turntable); break;
      case 'KeyP': screenshot(); break;
      case 'KeyL': showLibrary(true); break;
      case 'KeyI': togglePanel('info'); break;
      case 'KeyA': if (!fly) togglePanel('anim'); break;
      case 'KeyE': if (!fly) togglePanel('export'); break;
      case 'KeyS': if (!fly) togglePanel('size'); break;
      case 'KeyM': togglePanel('materials'); break;
      case 'Space': if (!fly && viewer.anim.clips.length) { e.preventDefault(); viewer.anim.toggle(); } break;
      case 'Slash': case 'F1': $('#sideTools [data-tip^="Controls"]')?.click(); break;
      default: return;
    }
    syncTools();
  });
}

// ---------------------------------------------------------------- drag & drop
function wireDrop() {
  let overlay = null, depth = 0;
  const show = () => {
    if (overlay) return;
    overlay = h('div.drop-overlay', h('div', ic('upload', 34), 'Drop to open',
      viewer.model && viewer.info?.stats.boneCount ? h('span.note', 'Hold Shift to add the file’s animations to this model') : null));
    document.body.append(overlay);
    hydrateIcons(overlay);
  };
  const hide = () => { overlay?.remove(); overlay = null; depth = 0; };
  window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { depth++; show(); } });
  window.addEventListener('dragleave', () => { depth--; if (depth <= 0) hide(); });
  window.addEventListener('dragover', (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    hide();
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    let paths = [];
    try { paths = await dropPaths(files); } catch { /* ignore */ }
    if (!paths.length) { toast('Could not read the dropped files.', { kind: 'bad' }); return; }
    const models = paths.filter((p) => MODEL_EXTS.includes(extname(p)));
    if (!models.length) {
      const st = await call('fs.stat', { path: paths[0] }).catch(() => null);
      if (st?.isDir) {
        const list = [...(app.host.settings.scanRoots || [])];
        if (!list.some((d) => d.toLowerCase() === paths[0].toLowerCase())) list.push(paths[0]);
        app.host.settings = await call('settings.set', { patch: { scanRoots: list } });
        toast(`Added ${basename(paths[0])} to the library folders`, { kind: 'ok' });
        const lib = await import('./library/library.js');
        await showLibrary(true);
        lib.scan();
        return;
      }
      toast('That is not a 3D model file.', { kind: 'bad' });
      return;
    }
    const animOnly = models.every((p) => basename(p).includes('@'));
    if (viewer.model && viewer.info?.stats.boneCount && (e.shiftKey || animOnly)) { loadAnimations(models); return; }
    open(models[0]);
    for (const p of models.slice(1)) call('app.openWindow', { path: p });
  });
}

boot();
