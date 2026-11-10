// Everything drawn over the 3D canvas: Tripo-style toolbars and popovers, stats, size, animation bar,
// loading card and the empty state.
import { app, savePrefs, thumbUrl } from '../app.js';
import { h, ic, $, setChildren, popover, closePopover, showMenu, menuAt, toggleRow, seg, sliderRow, fmtNum, fmtCm, fmtTime, fmtBytes, toast } from '../dom.js';
import { hydrateIcons } from '../icons.js';
import { ENVIRONMENTS, environmentPreview } from '../viewer/environment.js';
import { DEFAULT_SETTINGS as D } from '../viewer/Viewer.js';
import { call, basename, extname, blendThumbUrl } from '../host.js';

let viewer;
const els = {};

export function initStage() {
  viewer = app.viewer;
  els.wrap = $('#canvasWrap');
  els.side = $('#sideTools');
  els.viewBar = $('#viewBar');
  els.stats = $('#stats');
  els.dims = $('#dims');
  els.anim = $('#animBar');
  els.loading = $('#loading');
  els.empty = $('#empty');
  buildSideTools();
  buildViewBar();
  buildAnimBar();
  viewer.addEventListener('settings', syncTools);
  viewer.addEventListener('model', () => { renderOverlays(); renderAnimBar(); });
  viewer.addEventListener('fix', renderOverlays);
  viewer.anim.addEventListener('change', renderAnimBar);
  viewer.anim.addEventListener('time', updateAnimTime);
  syncTools();
  showEmpty(true);
}

// ---------------------------------------------------------------- right toolbar
const tools = {};
function tool(id, iconName, tip, onClick) {
  const b = h('button.tool', { type: 'button', 'data-tip': tip, 'data-tip-pos': 'left', 'aria-label': tip, onclick: onClick }, ic(iconName, 19));
  tools[id] = b;
  return b;
}

function buildSideTools() {
  setChildren(els.side,
    tool('env', 'sun', 'Environment (HDRI)', (e) => envPopover(e.currentTarget)),
    tool('shot', 'camera', 'Screenshot (P)', (e) => screenshotPopover(e.currentTarget)),
    h('div.tool-sep'),
    tool('reset', 'focus', 'Reset camera (F)', () => viewer.frame(true)),
    tool('grid', 'grid', 'Grid (G)', () => viewer.set('grid', !viewer.settings.grid)),
    tool('nav', 'orbit', 'Navigation: orbit - click for free fly (N)', () => toggleNav()),
    tool('ortho', 'box', 'Perspective / orthographic (O)', () => viewer.set('ortho', !viewer.settings.ortho)),
    tool('turn', 'rotate-cw', 'Turntable (T)', () => viewer.set('turntable', !viewer.settings.turntable)),
    h('div.tool-sep'),
    tool('full', 'maximize', 'Full screen (F11)', () => app.actions.toggleFullscreen()),
    tool('help', 'help', 'Controls & shortcuts (?)', (e) => helpPopover(e.currentTarget)),
  );
}

export function toggleNav() {
  const next = viewer.settings.nav === 'orbit' ? 'fly' : 'orbit';
  viewer.set('nav', next);
  if (next === 'fly') toast('Free fly: drag to look · W A S D to move · Q / E down / up · Shift faster · wheel = speed', { timeout: 5000 });
}

function syncTools() {
  const s = viewer.settings;
  tools.grid?.classList.toggle('on', s.grid);
  tools.ortho?.classList.toggle('on', s.ortho);
  tools.turn?.classList.toggle('on', s.turntable);
  if (tools.nav) {
    tools.nav.classList.toggle('on', s.nav === 'fly');
    setChildren(tools.nav, ic(s.nav === 'fly' ? 'move' : 'orbit', 19));
    tools.nav.dataset.tip = s.nav === 'fly' ? 'Navigation: free fly - click for orbit (N)' : 'Navigation: orbit - click for free fly (N)';
  }
  tools.full && setChildren(tools.full, ic(document.body.classList.contains('fullscreen') ? 'minimize' : 'maximize', 19));
  for (const [mode, b] of Object.entries(viewButtons)) b.classList.toggle('on', s.viewMode === mode);
  viewButtons.wire?.classList.toggle('on', s.wireframe);
  els.stats.hidden = !(s.stats && viewer.model);
  els.dims.hidden = !(s.dims && viewer.model);
  savePrefs();
}

// ---------------------------------------------------------------- popovers that follow the settings
/** Opens a popover whose controls stay in sync with the viewer (undo, reset buttons, keyboard toggles). */
function syncedPopover(anchor, content, binds, opts = {}) {
  const sync = () => binds.forEach((f) => f());
  const pop = popover(anchor, content, { container: els.wrap, ...opts, onClose: () => viewer.removeEventListener('settings', sync) });
  if (pop) viewer.addEventListener('settings', sync);
  return pop;
}
/** A control bound to a setting: it is redrawn from viewer.settings[key] whenever settings change. */
function binder(binds) {
  return (el, key) => { binds.push(() => el.setValue?.(viewer.settings[key])); return el; };
}
const num2 = (v) => (+v).toFixed(2);

// ---------------------------------------------------------------- environment popover (Tripo style)
function envPopover(anchor) {
  const s = viewer.settings;
  const binds = [];
  const bind = binder(binds);
  const preview = h('div.hdri-preview');
  const setPreview = (id) => environmentPreview(id).then((url) => { preview.style.backgroundImage = `url(${url})`; }).catch(() => {});
  setPreview(s.env);
  const grid = h('div.env-grid');
  for (const env of ENVIRONMENTS) {
    const pic = h('div.pic');
    environmentPreview(env.id).then((url) => { pic.style.backgroundImage = `url(${url})`; }).catch(() => {});
    const b = h('button.env-opt' + (s.env === env.id ? '.on' : ''), { type: 'button', 'data-tip': env.credit + ' · Poly Haven (CC0)', 'data-env': env.id, onclick: () => viewer.set('env', env.id) }, pic, h('span', env.name));
    grid.append(b);
  }
  let shownEnv = s.env;
  binds.push(() => {
    grid.querySelectorAll('.env-opt').forEach((x) => x.classList.toggle('on', x.dataset.env === viewer.settings.env));
    if (shownEnv !== viewer.settings.env) { shownEnv = viewer.settings.env; setPreview(shownEnv); }
  });
  const bgBox = h('div');
  let shownBg = null;
  const bgExtra = () => {
    if (shownBg === viewer.settings.background) return;
    shownBg = viewer.settings.background;
    setChildren(bgBox,
      shownBg === 'hdri' ? h('div.field', h('label', 'Background blur'), bind(sliderRow(0, 1, 0.01, viewer.settings.bgBlur, (v, o) => viewer.set('bgBlur', v, o), { fmt: num2, def: D.bgBlur }), 'bgBlur')) : null,
      shownBg === 'solid' ? h('div.field', h('label', 'Color'), bind(Object.assign(h('input.input', { type: 'color', value: viewer.settings.bgColor, oninput: (e) => viewer.set('bgColor', e.target.value, { merge: true }), onchange: (e) => viewer.set('bgColor', e.target.value, { merge: true, seal: true }), style: { height: '32px', padding: '2px' } }), { setValue(v) { this.value = v; } }), 'bgColor')) : null,
    );
  };
  binds.push(bgExtra);
  const content = h('div',
    h('div.pop-head', h('h4', 'Environment'), h('button.icon-btn', { onclick: closePopover, 'aria-label': 'Close' }, ic('x', 16))),
    preview, grid,
    h('div.field', h('label', 'Strength'), bind(sliderRow(0, 3, 0.05, s.envStrength, (v, o) => viewer.set('envStrength', v, o), { fmt: num2, def: D.envStrength }), 'envStrength')),
    h('div.field', h('label', 'Rotation'), bind(sliderRow(0, 360, 1, s.envRotation, (v, o) => viewer.set('envRotation', v, o), { fmt: (v) => Math.round(v), def: D.envRotation }), 'envRotation')),
    bind(toggleRow('Auto rotate', 'Slowly spins the lighting', s.envAutoRotate, (v) => viewer.set('envAutoRotate', v)), 'envAutoRotate'),
    h('div.field', { style: { marginTop: '8px' } }, h('label', 'Background'),
      bind(seg([{ value: 'gradient', label: 'Studio' }, { value: 'dark', label: 'Dark' }, { value: 'hdri', label: 'HDRI' }, { value: 'solid', label: 'Color' }], s.background, (v) => viewer.set('background', v)), 'background')),
    bgBox,
    bind(toggleRow('Ground shadow', null, s.shadow, (v) => viewer.set('shadow', v)), 'shadow'),
    h('div.pop-hint', 'Double-click a slider to reset it · Ctrl+Z undo · Ctrl+Y redo'),
  );
  bgExtra();
  syncedPopover(anchor, content, binds);
}

// ---------------------------------------------------------------- screenshot popover
function screenshotPopover(anchor) {
  const p = app.prefs.screenshot;
  const content = h('div',
    h('div.pop-head', h('h4', 'Screenshot'), h('button.icon-btn', { onclick: closePopover, 'aria-label': 'Close' }, ic('x', 16))),
    h('div.field', h('label', 'Resolution'),
      seg([{ value: 1, label: '1×' }, { value: 2, label: '2×' }, { value: 4, label: '4×' }], p.scale, (v) => { p.scale = v; savePrefs(); })),
    h('div.field', h('label', 'Background'),
      seg([{ value: 'transparent', label: 'Transparent' }, { value: 'dark', label: 'Almost black' }, { value: 'current', label: 'As shown' }], p.background, (v) => { p.background = v; savePrefs(); })),
    toggleRow('Include grid', null, p.grid, (v) => { p.grid = v; savePrefs(); }),
    toggleRow('Ask where to save', 'Otherwise saved to Pictures\\Meshbox', p.ask, (v) => { p.ask = v; savePrefs(); }),
    h('div.btn-row', { style: { marginTop: '10px' } },
      h('button.btn.primary.grow', { onclick: () => { closePopover(); app.actions.screenshot(); } }, ic('camera', 16), 'Save PNG'),
      h('button.btn', { 'data-tip': 'Copy to clipboard', onclick: () => { closePopover(); app.actions.screenshot({ clipboard: true }); } }, ic('copy', 16))),
  );
  popover(anchor, content, { container: els.wrap });
}

function helpPopover(anchor) {
  const row = (k, d) => h('div.row', { style: { justifyContent: 'space-between', padding: '3px 0', fontSize: '13px' } }, h('span.muted', d), h('span', ...k.split(' ').map((x) => h('kbd', x))));
  const content = h('div',
    h('div.pop-head', h('h4', 'Controls'), h('button.icon-btn', { onclick: closePopover }, ic('x', 16))),
    h('div.section-label', 'Mouse'),
    row('Left-drag', 'Rotate'), row('Right-drag', 'Pan (also Shift + left)'), row('Wheel', 'Zoom to cursor'), row('Double-click', 'Focus on point'),
    h('div.section-label', { style: { marginTop: '10px' } }, 'Keys'),
    row('F', 'Reset camera'), row('1 3 7', 'Front / right / top (Ctrl = opposite)'), row('5', 'Perspective / ortho'),
    row('G', 'Grid'), row('W', 'Wireframe'), row('N', 'Orbit / free fly'), row('T', 'Turntable'),
    row('Space', 'Play / pause animation'), row('P', 'Screenshot'), row('L', 'Library'), row('Ctrl O', 'Open'), row('F11', 'Full screen'),
  );
  popover(anchor, content, { container: els.wrap });
}

// ---------------------------------------------------------------- bottom view bar
const viewButtons = {};
function vb(id, inner, tip, onClick) {
  const b = h('button.vb', { type: 'button', 'data-tip': tip, 'aria-label': tip, onclick: onClick }, inner);
  viewButtons[id] = b;
  return b;
}
function buildViewBar() {
  const mode = (m) => () => viewer.set('viewMode', m);
  setChildren(els.viewBar,
    vb('wire', ic('globe', 18), 'Wireframe (W)', () => viewer.set('wireframe', !viewer.settings.wireframe)),
    h('span.vb-sep'),
    vb('solid', h('span.ball.solid'), 'Solid view (1)', mode('solid')),
    vb('textured', h('span.ball.textured'), 'Textured view (2)', mode('textured')),
    vb('normal', h('span.ball.normal'), 'Normals (3)', mode('normal')),
    h('span.vb-sep'),
    vb('settings', ic('sliders', 18), 'View settings', (e) => viewSettingsPopover(e.currentTarget)),
    h('span.vb-sep'),
    vb('unlit', h('span.ball.unlit'), 'Unlit (4)', mode('unlit')),
    vb('anime', h('span.ball.anime'), 'Anime style (5)', mode('anime')),
    vb('sketch', h('span.ball.sketch'), 'Sketch style (6)', mode('sketch')),
  );
}

function viewSettingsPopover(anchor) {
  const s = viewer.settings;
  const binds = [];
  const bind = binder(binds);
  const bloomBox = h('div.sub-box');
  let shownBloom = null;
  const bloomExtra = () => {
    if (shownBloom === viewer.settings.bloom) return;
    shownBloom = viewer.settings.bloom;
    const st = viewer.settings;
    setChildren(bloomBox, !shownBloom ? null : [
      h('div.field', h('label', 'Strength'), bind(sliderRow(0, 3, 0.05, st.bloomStrength, (v, o) => viewer.set('bloomStrength', v, o), { fmt: num2, def: D.bloomStrength }), 'bloomStrength')),
      h('div.field', h('label', 'Radius'), bind(sliderRow(0, 1, 0.01, st.bloomRadius, (v, o) => viewer.set('bloomRadius', v, o), { fmt: num2, def: D.bloomRadius }), 'bloomRadius')),
      h('div.field', h('label', 'Threshold', h('small', ' brightness that starts to glow')), bind(sliderRow(0, 2, 0.05, st.bloomThreshold, (v, o) => viewer.set('bloomThreshold', v, o), { fmt: num2, def: D.bloomThreshold }), 'bloomThreshold')),
      viewer.styleMode ? h('div.note', 'Bloom shows in the Solid, Textured, Normals and Unlit views.') : null,
    ]);
    bloomBox.hidden = !shownBloom;
  };
  binds.push(bloomExtra);
  const content = h('div',
    h('div.pop-head', h('h4', 'View settings'), h('button.icon-btn', { onclick: closePopover }, ic('x', 16))),
    h('div.field', h('label', 'Shading'), bind(seg([{ value: false, label: 'Smooth' }, { value: true, label: 'Flat' }], s.flat, (v) => viewer.set('flat', v)), 'flat')),
    h('div.field', h('label', 'Sketch style'), bind(seg([{ value: 'pencil', label: 'Pencil' }, { value: 'ink', label: 'Manga ink' }], s.sketchVariant, (v) => viewer.set({ sketchVariant: v, viewMode: 'sketch' })), 'sketchVariant')),
    bind(toggleRow('Topology', 'Faces and vertices, top left', s.stats, (v) => { viewer.set('stats', v); syncTools(); }), 'stats'),
    bind(toggleRow('Size & facing', 'Dimensions in cm, bottom left', s.dims, (v) => { viewer.set('dims', v); syncTools(); }), 'dims'),
    bind(toggleRow('3D gizmo', null, s.gizmo, (v) => viewer.set('gizmo', v)), 'gizmo'),
    bind(toggleRow('Grid', null, s.grid, (v) => viewer.set('grid', v)), 'grid'),
    bind(toggleRow('Lights from the file', 'FBX/glTF lights are off by default', s.importedLights, (v) => viewer.set('importedLights', v)), 'importedLights'),
    h('div.field', { style: { marginTop: '6px' } }, h('label', 'Tone mapping'),
      bind(seg([{ value: 'neutral', label: 'Neutral' }, { value: 'aces', label: 'ACES' }, { value: 'agx', label: 'AgX' }, { value: 'none', label: 'None' }], s.toneMapping, (v) => viewer.set('toneMapping', v)), 'toneMapping')),
    h('div.field', h('label', 'Exposure'), bind(sliderRow(0.2, 2.5, 0.05, s.exposure, (v, o) => viewer.set('exposure', v, o), { fmt: num2, def: D.exposure }), 'exposure')),
    bind(toggleRow('Bloom', 'Glow around bright and emissive parts', s.bloom, (v) => viewer.set('bloom', v)), 'bloom'),
    bloomBox,
    h('div.pop-hint', 'Double-click a slider to reset it · Ctrl+Z undo · Ctrl+Y redo'),
  );
  bloomExtra();
  syncedPopover(anchor, content, binds, { placement: 'top' });
}

// ---------------------------------------------------------------- overlays
export function renderOverlays() {
  const info = viewer.info;
  if (!info) { els.stats.hidden = true; els.dims.hidden = true; return; }
  const st = info.stats;
  const bi = info.blendInfo?.totals;
  const faces = bi?.faces ?? st.polygons;
  const verts = bi?.vertices ?? st.vertices;
  const topo = bi && bi.faces ? (bi.triangles / bi.faces > 1.9 ? 'Quad' : bi.triangles / bi.faces > 1.15 ? 'Mixed' : 'Triangles') : st.topology;
  setChildren(els.stats,
    h('dt', 'Topology'), h('dd', topo),
    h('dt', 'Faces'), h('dd', fmtNum(faces)),
    h('dt', 'Vertices'), h('dd', fmtNum(verts)),
    st.triangles !== faces ? [h('dt', 'Triangles'), h('dd', fmtNum(st.triangles))] : null,
    st.boneCount ? [h('dt', 'Bones'), h('dd', fmtNum(st.boneCount))] : null,
  );
  const d = info.dims;
  const f = info.facing;
  const fixed = viewer.fix.scale !== 1 || viewer.fix.quaternion.w < 0.99999;
  setChildren(els.dims,
    ic('ruler', 14),
    h('span', h('b', fmtCm(d.x)), ' × ', h('b', fmtCm(d.y)), ' × ', h('b', fmtCm(d.z))),
    h('span.muted', 'W × H × D'),
    f ? h('span.facing' + (f.ok || fixed ? '.ok' : '.warn'), ic(f.ok || fixed ? 'check' : 'alert', 13), fixed ? 'Fix previewed' : f.label) : null,
  );
  els.stats.hidden = !viewer.settings.stats;
  els.dims.hidden = !viewer.settings.dims;
}

// ---------------------------------------------------------------- animation bar
let animEls;
function buildAnimBar() {
  const play = h('button.icon-btn', { 'data-tip': 'Play / pause (Space)', onclick: () => viewer.anim.toggle() });
  const rest = h('button.icon-btn', { 'data-tip': 'Rest pose', onclick: () => viewer.anim.stop() }, ic('skip-back', 18));
  const timeline = h('input.range.timeline', { type: 'range', min: 0, max: 1, step: 0.001, value: 0 });
  timeline.addEventListener('input', () => viewer.anim.seek(+timeline.value * viewer.anim.duration));
  const time = h('span.time', '00:00.0');
  const clip = h('button.btn.ghost.clip-btn', { onclick: (e) => clipMenu(e.currentTarget) });
  const speed = h('button.btn.ghost', { 'data-tip': 'Speed', onclick: (e) => menuAt(e.currentTarget, [0.1, 0.25, 0.5, 1, 1.5, 2].map((v) => ({ label: `×${v}`, checked: viewer.anim.speed === v, onClick: () => viewer.anim.setSpeed(v) }))) });
  const loop = h('button.icon-btn', { 'data-tip': 'Loop mode', onclick: (e) => menuAt(e.currentTarget, [
    { label: 'Repeat', icon: 'repeat', checked: viewer.anim.loop === 'repeat', onClick: () => viewer.anim.setLoop('repeat') },
    { label: 'Play once', icon: 'arrow-right-to-line', checked: viewer.anim.loop === 'once', onClick: () => viewer.anim.setLoop('once') },
    { label: 'Ping-pong', icon: 'repeat-1', checked: viewer.anim.loop === 'pingpong', onClick: () => viewer.anim.setLoop('pingpong') },
  ]) });
  animEls = { play, rest, timeline, time, clip, speed, loop };
  setChildren(els.anim, play, rest, timeline, time, clip, speed, loop);
}

export function clipName(c, i) { return c?.userData?.shownName || c?.name || `Animation ${i + 1}`; }

function clipMenu(anchor) {
  const a = viewer.anim;
  menuAt(anchor, [
    { label: 'Rest pose', icon: 'person', checked: a.index < 0, onClick: () => a.stop() },
    '-',
    ...a.clips.map((c, i) => ({ label: clipName(c, i), hint: c.duration.toFixed(1) + 's', checked: a.index === i, onClick: () => a.select(i, true) })),
    '-',
    { label: 'Load animations from file…', icon: 'upload', onClick: () => app.actions.loadAnimations() },
  ], { minWidth: 240 });
}

function renderAnimBar() {
  const a = viewer.anim;
  const has = !!viewer.model && a.clips.length > 0;
  els.anim.hidden = !has;
  els.viewBar.classList.toggle('lifted', has);
  els.dims.classList.toggle('lifted', has);   // above the timeline
  if (!has) return;
  setChildren(animEls.play, ic(a.playing ? 'pause' : 'play', 18));
  setChildren(animEls.clip, h('span.name', a.index >= 0 ? clipName(a.current, a.index) : 'Rest pose'), ic('chevron-down', 14));
  animEls.speed.textContent = `×${a.speed}`;
  setChildren(animEls.loop, ic(a.loop === 'once' ? 'arrow-right-to-line' : a.loop === 'pingpong' ? 'repeat-1' : 'repeat', 17));
  updateAnimTime();
}

function updateAnimTime() {
  const a = viewer.anim;
  if (!animEls || els.anim.hidden) return;
  const d = a.duration;
  animEls.timeline.value = d ? String(a.time / d) : '0';
  animEls.time.textContent = `${fmtTime(a.time)} / ${fmtTime(d)}`;
}

// ---------------------------------------------------------------- loading card
let loadingState = null;
export function showLoading({ title, thumb, onCancel }) {
  const bar = h('div.bar.indeterminate', h('i'));
  const text = h('div.stage-text', 'Opening…');
  const pct = h('span.pct');
  const cancel = onCancel ? h('button.btn.small.ghost', { onclick: onCancel }, 'Cancel') : null;
  const thumbEl = thumb ? h('div.thumb', { style: { backgroundImage: `url("${thumb}")` } }) : null;
  setChildren(els.loading, h('div.loading-card', thumbEl, h('div.title', title), bar, h('div.foot', text, h('span.grow'), pct, cancel)));
  els.loading.hidden = false;
  els.empty.hidden = true;
  loadingState = { bar, text, pct, thumbEl };
}
export function setLoading({ progress, text, indeterminate }) {
  if (!loadingState) return;
  if (text != null) loadingState.text.textContent = text;
  if (indeterminate || progress == null) { loadingState.bar.classList.add('indeterminate'); loadingState.pct.textContent = ''; }
  else {
    loadingState.bar.classList.remove('indeterminate');
    loadingState.bar.firstChild.style.width = `${Math.round(Math.min(1, progress) * 100)}%`;
    loadingState.pct.textContent = `${Math.round(Math.min(1, progress) * 100)}%`;
  }
}
export function hideLoading() { els.loading.hidden = true; loadingState = null; }
export function loadingError(title, message, actions = []) {
  setChildren(els.loading, h('div.loading-card',
    h('div.row', ic('alert', 18), h('div.title', title)),
    h('div.note.sel', { style: { whiteSpace: 'pre-wrap', maxHeight: '220px', overflow: 'auto' } }, message),
    h('div.btn-row.end', ...actions.map((a) => h('button.btn' + (a.primary ? '.primary' : ''), { onclick: a.onClick }, a.label)),
      h('button.btn.ghost', { onclick: () => { hideLoading(); if (!viewer.model) showEmpty(true); } }, 'Close'))));
  els.loading.hidden = false;
  els.empty.hidden = true;
}

// ---------------------------------------------------------------- empty state
// Start screen: just the ways in, no recent files (they stay one click away in the file menu).
export function showEmpty(on) {
  els.empty.hidden = !on;
  if (!on) return;
  setChildren(els.empty,
    h('div.big', ic('box', 34)),
    h('h3', 'Open a 3D model'),
    h('p', 'FBX, Blender (.blend), GLB / glTF, VRM, OBJ, STL, PLY, DAE, 3DS, 3MF, USDZ - drop a file here, press ', h('kbd', 'Ctrl'), ' ', h('kbd', 'O'), ' or browse your library.'),
    h('div.btn-row', h('button.btn.primary', { onclick: () => app.actions.openDialog() }, ic('folder-open', 16), 'Open file…'),
      h('button.btn', { onclick: () => app.actions.showLibrary(true) }, ic('library', 16), 'Library')),
  );
  hydrateIcons(els.empty);
}

export function fmtClass(ext) {
  const e = ext.replace('.', '');
  return ['fbx', 'blend', 'glb', 'gltf', 'vrm', 'obj'].includes(e) ? e : 'other';
}

export { syncTools, fmtBytes };
