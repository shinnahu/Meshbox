// Left panel pages: Info · Animations · Size & facing · Export (FBX for Unity, Send to Unity, GLB).
import * as THREE from 'three';
import { app, savePrefs, entry, updateEntry } from '../app.js';
import { h, ic, $, $$, setChildren, fmtNum, fmtBytes, fmtCm, fmtDateTime, toast, seg, toggleRow, showMenu, confirmDialog, help, toUnit, fromUnit, lengthUnitLabel } from '../dom.js';
import { call, on as onHost, newJobId, basename, dirname, extname, stem, joinPath } from '../host.js';
import { clipName } from './stage.js';

let viewer;
let panelEl;
const PANELS = {
  info: { title: 'Model info', render: renderInfo },
  anim: { title: 'Animations', render: renderAnim },
  size: { title: 'Size & facing', render: renderSize },
  export: { title: 'Export', render: renderExportPage },
};

export function initPanels() {
  viewer = app.viewer;
  panelEl = $('#panel');
  $$('#rail .rail-btn').forEach((b) => b.addEventListener('click', () => togglePanel(b.dataset.panel)));
  viewer.addEventListener('model', refreshPanel);
  viewer.addEventListener('fix', () => { if (app.prefs.panel === 'size' || app.prefs.panel === 'export') refreshPanel(); });
  viewer.anim.addEventListener('change', () => { if (app.prefs.panel === 'anim') refreshPanel(); });
  if (app.prefs.panel) openPanel(app.prefs.panel, false);
}

export function togglePanel(id) {
  if (app.prefs.panel === id) closePanel(); else openPanel(id);
}
export function openPanel(id) {
  app.prefs.panel = id;
  savePrefs();
  $('#shell').classList.remove('panel-closed');
  $$('#rail .rail-btn').forEach((b) => b.classList.toggle('on', b.dataset.panel === id));
  refreshPanel();
  viewer.resize();
}
export function closePanel() {
  app.prefs.panel = null;
  savePrefs();
  $('#shell').classList.add('panel-closed');
  $$('#rail .rail-btn').forEach((b) => b.classList.remove('on'));
  viewer.resize();
}

export function refreshPanel() {
  const id = app.prefs.panel;
  if (!id || !PANELS[id]) return;
  const scroll = panelEl.querySelector('.panel-body')?.scrollTop || 0;
  const body = h('div.panel-body');
  setChildren(panelEl, h('div.panel-head', h('h2', PANELS[id].title), h('button.icon-btn', { onclick: closePanel, 'aria-label': 'Close panel' }, ic('chevron-left', 18))), body);
  if (!viewer.info) { body.append(h('div.panel-empty', 'Open a model to see this.')); return; }
  PANELS[id].render(body, viewer.info);
  body.scrollTop = scroll;
}

const section = (label, ...children) => h('div.section', h('div.section-label', label), ...children);
const kv = (pairs) => h('dl.kv', ...pairs.filter(Boolean).flatMap(([k, v, cls]) => [h('dt', k), h('dd' + (cls ? '.' + cls : ''), v ?? '-')]));

// ================================================================= INFO
function renderInfo(body, info) {
  const cur = app.current || {};
  const src = info.sourcePath;
  const st = info.stats;
  const bi = info.blendInfo;
  const header = cur.header;

  body.append(section('File',
    h('div.card-box',
      h('div', { style: { color: 'var(--strong)', fontWeight: 600, wordBreak: 'break-all' } }, basename(src)),
      h('div.link.sel', { style: { fontSize: '12px', marginTop: '2px', wordBreak: 'break-all' }, onclick: () => call('fs.reveal', { path: src }) }, dirname(src)),
      h('div', { style: { height: '8px' } }),
      kv([
        ['Format', info.format],
        cur.size != null && ['Size', fmtBytes(cur.size)],
        cur.modified && ['Modified', fmtDateTime(cur.modified)],
        header && ['Saved with', `Blender ${header.version}${header.compression !== 'none' ? ` (${header.compression})` : ''}`],
        bi && ['Preview by', `Blender ${bi.previewBlender || bi.blenderVersion || ''}${bi.seconds ? ` · ${bi.seconds}s` : ''}`],
        info.generator && ['Made by', info.generator],
        info.unitScaleFactor != null && ['FBX units', `${info.unitScaleFactor === 1 ? 'centimeters' : info.unitScaleFactor === 100 ? 'meters' : info.unitScaleFactor + ' cm'} per unit`],
      ])),
    h('div.btn-row', { style: { marginTop: '8px' } },
      h('button.btn.small', { onclick: () => call('fs.reveal', { path: src }) }, ic('folder', 15), 'Show in folder'),
      extname(src) === '.blend' ? h('button.btn.small', { onclick: () => call('fs.openInBlender', { path: src }).catch((e) => toast(e.message, { kind: 'bad' })) }, ic('blender', 15), 'Open in Blender') : null,
      extname(src) === '.blend' ? h('button.btn.small', { 'data-tip': 'Rebuild the preview from the .blend', onclick: () => app.actions.open(src, { force: true }) }, ic('refresh', 15)) : null,
    )));

  // Unity readiness at a glance
  const u = info.unity || {};
  const f = info.facing;
  const pivot = info.pivotOffset;
  const pivotOff = pivot ? Math.hypot(pivot.x, pivot.y, pivot.z) : 0;
  const fixed = viewer.fix.scale !== 1 || viewer.fix.quaternion.w < 0.99999;
  const chips = [];
  chips.push(u.scaleOk ? h('span.chip.ok', ic('check', 13), 'Scale 1, 1, 1') : h('span.chip.warn', { 'data-tip': `${u.worst?.name}: ${u.worst?.scale?.join(', ')}` }, ic('alert', 13), `Scale ${u.worst?.scale?.[0] ?? '?'} on ${u.worst?.name || 'root'}`));
  chips.push(u.rotationOk ? h('span.chip.ok', ic('check', 13), 'No root rotation') : h('span.chip.warn', { 'data-tip': `${u.rot?.name}: ${u.rot?.deg?.join('°, ')}°` }, ic('alert', 13), `Rotated ${u.rot?.deg?.map((d) => Math.round(d)).join('/')}° on ${u.rot?.name}`));
  if (f) chips.push(f.ok ? h('span.chip.ok', ic('check', 13), 'Faces +Z') : h('span.chip.warn', ic('compass', 13), f.label));
  else chips.push(h('span.chip', { 'data-tip': 'Facing can only be detected on humanoid rigs. Check the floor arrow (+Z).' }, ic('compass', 13), 'Facing: check arrow'));
  chips.push(pivotOff < 0.01 ? h('span.chip.ok', ic('check', 13), 'Pivot at bottom center') : h('span.chip', { 'data-tip': `Origin is ${fmtCm(pivotOff)} from the bottom center of the model` }, ic('crosshair', 13), `Pivot offset ${fmtCm(pivotOff)}`));
  const needsFix = !u.scaleOk || !u.rotationOk || (f && !f.ok);
  body.append(section('Unity check',
    h('div.chips', ...chips),
    needsFix || fixed ? h('div.banner.info', { style: { marginTop: '8px' } }, ic('info', 16),
      h('div', fixed ? 'A size/facing fix is previewed. Export for Unity to bake it into a clean FBX.' : 'Export for Unity to get a clean FBX (scale 1, 1, 1, facing +Z, Textures folder).',
        h('div', h('button.btn.small.primary', { style: { marginTop: '8px' }, onclick: () => openPanelSafe(fixed ? 'export' : 'size') }, ic(fixed ? 'download' : 'ruler', 15), fixed ? 'Export' : 'Size & facing')))) : null));

  const bt = bi?.totals;
  body.append(section('Geometry', h('div.card-box', kv([
    ['Topology', bt ? (bt.triangles / Math.max(1, bt.faces) > 1.9 ? 'Quad' : 'Mixed') : st.topology],
    ['Faces', fmtNum(bt?.faces ?? st.polygons)],
    ['Triangles', fmtNum(bt?.triangles ?? st.triangles)],
    ['Vertices', fmtNum(bt?.vertices ?? st.vertices)],
    ['Meshes', fmtNum(st.meshes)],
    ['Materials', fmtNum(st.materialCount)],
    ['Draw calls', fmtNum(st.drawCalls)],
    ['Size (W × H × D)', `${fmtCm(info.dims.x)} × ${fmtCm(info.dims.y)} × ${fmtCm(info.dims.z)}`],
  ]))));

  const hum = info.human;
  body.append(section('Rig & animation', h('div.card-box', kv([
    ['Bones', st.boneCount ? fmtNum(st.boneCount) : 'none'],
    ['Skinned meshes', fmtNum(st.skinnedMeshes)],
    st.boneCount && ['Humanoid', hum?.isHumanoid ? `yes (${hum.mapped} bones mapped)` : 'not detected', hum?.isHumanoid ? 'ok' : ''],
    ['Shape keys', st.morphCount ? fmtNum(st.morphCount) : 'none'],
    ['Animations', st.animations ? fmtNum(st.animations) : 'none'],
  ]))));

  renderTextures(body, info);
  if (bi) renderBlendInfo(body, bi);
  renderOutliner(body);
}

function openPanelSafe(id) { openPanel(id); }

/** For a .blend the truth is Blender's own image list (packed / linked / missing / borrowed from another folder). */
function blendTextures(info) {
  const bi = info.blendInfo;
  const modelRoot = dirname(dirname(info.sourcePath)).toLowerCase();
  return (bi.images || []).filter((i) => i.usedByMaterials !== false && i.source !== 'GENERATED' && i.source !== 'VIEWER').map((i) => {
    const path = i.absPath || i.filepath;
    const outside = !i.packed && i.exists && path && !path.toLowerCase().startsWith(modelRoot);
    const relinked = !i.packed && !i.exists && i.foundAt;
    return {
      name: i.name, path: i.packed ? null : relinked ? i.foundAt : path, requested: path, slots: i.role && i.role !== 'other' ? [i.role] : [],
      width: i.width || null, height: i.height || null,
      status: i.packed ? 'embedded' : i.exists ? (outside ? 'substituted' : 'found') : relinked ? 'substituted' : 'missing',
      how: relinked ? 'relinked' : outside ? 'outside' : null, outsideDir: outside ? dirname(path) : null,
    };
  });
}

function renderTextures(body, info) {
  const isBlend = !!info.blendInfo?.images;
  const tex = isBlend ? blendTextures(info) : info.textures || [];
  const count = (s) => tex.filter((t) => t.status === s).length;
  const bi = info.blendInfo;
  const summary = h('div.chips', { style: { marginBottom: '8px' } },
    count('embedded') ? h('span.chip.accent', ic('package', 13), `${count('embedded')} ${isBlend ? 'packed' : 'embedded'}`) : null,
    count('found') ? h('span.chip.ok', ic('link', 13), `${count('found')} linked`) : null,
    count('substituted') ? h('span.chip.warn', { 'data-tip': isBlend ? 'Linked from another model’s folder: moving that folder breaks this model' : 'Not at the path the file asks for: found by name elsewhere (or a .png next to a .psd)' }, ic('link', 13), `${count('substituted')} ${isBlend ? 'from other folders' : 'found elsewhere'}`) : null,
    count('missing') ? h('span.chip.bad', ic('unlink', 13), `${count('missing')} missing`) : null,
    !tex.length ? h('span.chip', 'No textures') : null);
  const list = h('div.list');
  for (const t of tex) {
    const iconName = t.status === 'embedded' ? 'package' : t.status === 'missing' ? 'unlink' : 'image';
    const cls = t.status === 'missing' ? 'bad' : t.status === 'substituted' ? 'warn' : t.status === 'embedded' ? '' : 'ok';
    const where = t.how === 'relinked' ? `link broken (${t.requested}) · found at ${t.path}` : t.how === 'outside' ? `from ${t.outsideDir}` : t.status === 'substituted' ? `→ ${basename(t.path)} (${t.how})` : t.status === 'missing' && t.requested ? `expected at ${t.requested}` : t.how === 'nearby' && t.path ? `in ${basename(dirname(t.path))}\\` : null;
    const sub = [t.slots?.join(', '), t.width ? `${t.width}×${t.height}` : null, where].filter(Boolean).join(' · ');
    list.append(h('div.list-item', { 'data-tip': t.path || t.requested || t.name, onclick: () => t.path && call('fs.reveal', { path: t.path }) },
      h('span.' + (cls || 'muted'), ic(iconName, 15)),
      h('div.grow', h('div.name', t.name), sub ? h('div.meta', { style: { whiteSpace: 'normal' } }, sub) : null)));
  }
  const relinked = tex.filter((t) => t.how === 'relinked').length;
  const missing = count('missing') + relinked;
  const borrowed = tex.filter((t) => t.how === 'outside').length;
  body.append(section(`Textures`, summary, list,
    missing && !isBlend ? h('div.banner.bad', { style: { marginTop: '8px' } }, ic('unlink', 16), h('div', `${missing} texture${missing > 1 ? 's are' : ' is'} missing. If they live in another folder, add it and reload.`,
      h('div', h('button.btn.small', { style: { marginTop: '8px' }, onclick: () => app.actions.addTextureFolder() }, ic('folder-open', 15), 'Add texture folder…')))) : null,
    isBlend && (missing || borrowed) ? h('div.banner.warn', { style: { marginTop: '8px' } }, ic('alert', 16), h('div',
      missing ? `${missing} image link${missing > 1 ? 's are' : ' is'} broken (moved or renamed folder)${relinked ? `; ${relinked} found by name and shown anyway` : ''}. ` : '',
      borrowed ? `${borrowed} come${borrowed > 1 ? '' : 's'} from another model’s folder, so moving that folder breaks this one. ` : '',
      h('b', 'Organize'), ' (top bar) copies every texture it can find into the model’s own Textures folder with standard names and relinks it, so this can’t happen again.')) : null,
    isBlend && bi.images.some((i) => i.usedByMaterials === false) ? h('div.note', { style: { marginTop: '8px' } }, `${bi.images.filter((i) => i.usedByMaterials === false).length} unused image(s) in the file are not listed.`) : null));
}

function renderBlendInfo(body, bi) {
  const rows = [];
  if (bi.fileVersion) rows.push(['File version', bi.fileVersion]);
  if (bi.objects) rows.push(['Objects', Object.entries(bi.objects).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(', ')]);
  if (bi.actions?.length) rows.push(['Actions', bi.actions.map((a) => a.name).join(', ')]);
  const mods = [...new Set((bi.meshes || []).flatMap((m) => m.modifiers || []))];
  if (mods.length) rows.push(['Modifiers', mods.join(', ')]);
  if (bi.libraries?.length) rows.push(['Linked .blends', bi.libraries.map((l) => `${basename(l.path || l.filepath || '')}${l.exists === false ? ' (missing)' : ''}`).join(', ')]);
  body.append(section('Blender file', h('div.card-box', kv(rows)),
    bi.warnings?.length ? h('div.banner.warn', { style: { marginTop: '8px' } }, ic('alert', 16), h('div', ...bi.warnings.slice(0, 6).map((w) => h('div', w)))) : null));
}

function renderOutliner(body) {
  const root = viewer.model;
  const tree = h('div.list.tree');
  let count = 0;
  const add = (o, depth) => {
    if (o.userData.helper || count > 400) return;
    count++;
    const kids = o.children.filter((c) => !c.userData.helper && !c.isBone);
    const icon = o.isSkinnedMesh ? 'person' : o.isMesh ? 'box' : o.isBone ? 'bone' : o.isLight ? 'sun' : o.isCamera ? 'camera' : 'layers';
    const eye = h('button.eye' + (o.visible ? '' : '.off'), { 'aria-label': 'Toggle visibility', onclick: (e) => {
      e.stopPropagation(); o.visible = !o.visible; eye.classList.toggle('off', !o.visible); setChildren(eye, ic(o.visible ? 'eye' : 'eye-off', 14)); viewer.shadowDirty = true; viewer.requestRender();
    } }, ic(o.visible ? 'eye' : 'eye-off', 14));
    tree.append(h('div.list-item', { style: { paddingLeft: `${8 + depth * 14}px` } }, ic(icon, 14), h('span.name', o.name || o.type), eye));
    for (const c of kids) add(c, depth + 1);
  };
  add(root, 0);
  body.append(section('Scene', tree, count > 400 ? h('div.note', 'Showing the first 400 objects.') : null));
}

// ================================================================= ANIMATIONS
function renderAnim(body) {
  const a = viewer.anim;
  const list = h('div.list');
  list.append(h('div.list-item' + (a.index < 0 ? '.on' : ''), { onclick: () => a.stop() }, ic('person', 15), h('span.name', 'Rest pose')));
  a.clips.forEach((c, i) => {
    list.append(h('div.list-item' + (a.index === i ? '.on' : ''), { onclick: () => a.select(i, true), 'data-tip': c.userData?.source ? `from ${c.userData.source}` : null },
      ic(a.index === i && a.playing ? 'pause' : 'play', 14), h('span.name', clipName(c, i)), h('span.meta', `${c.duration.toFixed(1)}s`)));
  });
  body.append(section(`Clips`, a.clips.length ? list : h('div.note', 'This model has no animation clips.')));

  if (a.clips.length) {
    body.append(section('Playback',
      h('div.field', h('label', 'Speed'), seg([0.25, 0.5, 1, 1.5, 2].map((v) => ({ value: v, label: `×${v}` })), a.speed, (v) => a.setSpeed(v))),
      h('div.field', h('label', 'Loop'), seg([{ value: 'repeat', label: 'Repeat' }, { value: 'once', label: 'Once' }, { value: 'pingpong', label: 'Ping-pong' }], a.loop, (v) => a.setLoop(v))),
      toggleRow('Play the first clip on open', null, viewer.settings.autoplay, (v) => viewer.set('autoplay', v))));
  }

  const near = h('div');
  body.append(section('Add animations',
    h('div.note', { style: { marginBottom: '8px' } }, viewer.info?.human?.isHumanoid
      ? 'Humanoid rig: clips from other humanoid rigs (Mixamo, Rigify, VRoid…) are retargeted by bone names.'
      : 'Clips from files with the same bone names play directly (e.g. Model@Run.fbx next to Model.fbx).'),
    h('button.btn.wide', { onclick: () => app.actions.loadAnimations() }, ic('upload', 16), 'Load animations or poses…'),
    near));
  findNearbyAnimations().then((files) => {
    if (!files.length) return;
    setChildren(near, h('div.banner.info', { style: { marginTop: '10px' } }, ic('film', 16),
      h('div', h('b', `${files.length} animation file${files.length > 1 ? 's' : ''} found nearby`), h('div.note', files.slice(0, 5).map((f) => basename(f)).join(', ') + (files.length > 5 ? '…' : '')),
        h('button.btn.small.primary', { style: { marginTop: '8px' }, onclick: () => app.actions.loadAnimations(files) }, 'Load all'))));
  });
}

/** Unity-style animation files: Name@Clip.fbx beside the model or in an Animations folder. */
export async function findNearbyAnimations() {
  const src = viewer.info?.sourcePath;
  if (!src || !viewer.info?.stats.boneCount) return [];
  const dir = dirname(src);
  const base = stem(src).replace(/@.*$/, '').toLowerCase();
  const out = [];
  for (const d of [dir, joinPath(dir, 'Animations'), joinPath(dir, 'Anims'), joinPath(dirname(dir), 'Animations')]) {
    try {
      const files = await call('fs.list', { dir: d, exts: ['.fbx', '.glb'] });
      for (const f of files) {
        const n = f.name.toLowerCase();
        if (f.path.toLowerCase() === src.toLowerCase()) continue;
        if (n.includes('@') && (n.startsWith(base + '@') || d !== dir)) out.push(f.path);
      }
    } catch { /* folder missing */ }
  }
  const loaded = new Set(viewer.anim.clips.map((c) => c.userData?.sourcePath?.toLowerCase()).filter(Boolean));
  return [...new Set(out)].filter((p) => !loaded.has(p.toLowerCase()));
}

// ================================================================= SIZE & FACING / EXPORT
// Pages built like Blender's Properties editor: collapsible groups with a clear header, room between
// them, and the explanations behind a "?" instead of on the page. Open/closed state is remembered.
function group(id, title, iconName, opts = {}, ...children) {
  const opened = app.prefs.groups?.[id] ?? (opts.open !== false);
  const el = h('section.grp' + (opened ? '.open' : '') + (opts.sub ? '.sub' : ''));
  const head = h('div.grp-head', { role: 'button', tabindex: 0, 'aria-expanded': String(opened) },
    ic('chevron-right', 14, 'grp-chev'), iconName ? ic(iconName, 16) : null, h('span.grp-title', title),
    opts.badge || null, opts.help ? help(opts.help) : null);
  const toggle = (e) => {
    if (e.target.closest('.help-dot, .seg, button, input, select')) return;
    const on = !el.classList.contains('open');
    el.classList.toggle('open', on);
    head.setAttribute('aria-expanded', String(on));
    app.prefs.groups = { ...(app.prefs.groups || {}), [id]: on };
    savePrefs();
  };
  head.addEventListener('click', toggle);
  head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(e); } });
  el.append(head, h('div.grp-body', ...children.flat().filter(Boolean)));
  return el;
}

/** A form row: label (with an optional "?") above the control. */
const fieldRow = (label, helpText, ...control) => h('div.field', h('label.with-help', h('span', label), helpText ? help(helpText) : null), ...control);

function renderSize(body, info) {
  const fix = viewer.fix;
  const saved = entry(info.sourcePath)?.fix || {};
  const target = saved.target || { axis: 'height', cm: null };
  // Size before our preview scale (as the file comes in, after any rotation preview).
  const base = info.dims.clone().divideScalar(fix.scale || 1);
  const axisVal = (v, axis) => axis === 'width' ? v.x : axis === 'depth' ? v.z : axis === 'max' ? Math.max(v.x, v.y, v.z) : v.y;
  const scaled = Math.abs((fix.scale || 1) - 1) > 1e-6;
  const rotated = fix.quaternion.w < 0.99999;

  // ---- size
  const readout = h('div.dims-readout',
    ...[['Width', info.dims.x], ['Height', info.dims.y], ['Depth', info.dims.z]].map(([k, v]) => h('div', h('span.k', k), h('span.v', fmtCm(v)))));
  const hgt = info.dims.y;
  let warn = null;
  if (hgt > 50) warn = [`${fmtCm(hgt)} tall`, 'Probably exported in centimeters without unit conversion. Set the real height below.'];
  else if (hgt < 0.02 && hgt > 0) warn = [`${fmtCm(hgt)} tall`, 'Probably 100× too small. Set the real height below.'];
  else if (info.human?.isHumanoid && (hgt > 2.6 || hgt < 0.2)) warn = ['Unusual height for a character', 'Set the real height below to standardize it.'];
  const axisSel = h('select.input', { style: { flex: '1 1 0', minWidth: '0' } },
    ...[['height', 'Height'], ['width', 'Width'], ['depth', 'Depth'], ['max', 'Longest side']].map(([v, l]) => h('option', { value: v, selected: v === target.axis }, l)));
  const unit = lengthUnitLabel();
  const round1 = (v) => Math.round(v * 10) / 10;
  const cmInput = h('input.input.num', { type: 'number', min: 0.01, step: 0.1, placeholder: round1(toUnit(axisVal(base, target.axis))), value: target.cm ? round1(toUnit(target.cm / 100)) : '', style: { flex: '0 0 84px' } });
  const factor = h('div.note');
  const updateFactor = () => {
    const want = fromUnit(+cmInput.value);           // meters
    const cur = axisVal(base, axisSel.value);         // meters
    const along = axisSel.selectedOptions[0].text.toLowerCase();
    factor.textContent = want > 0 && cur > 0 ? `Scale ×${(want / cur).toPrecision(4)} (now ${fmtCm(cur)} ${along})` : `Now ${fmtCm(cur)} ${along}`;
  };
  cmInput.addEventListener('input', updateFactor);
  axisSel.addEventListener('change', updateFactor);
  updateFactor();
  const applySize = () => {
    const want = fromUnit(+cmInput.value);
    if (!(want > 0)) { toast(`Type the size you want in ${unit === 'in' ? 'inches' : 'centimeters'}.`); cmInput.focus(); return; }
    viewer.setFix({ scale: want / axisVal(base, axisSel.value) });
    saveFix({ target: { axis: axisSel.value, cm: +(want * 100).toFixed(3) } });
  };
  cmInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') applySize(); });
  const presets = h('button.btn.small.ghost', { onclick: (e) => showMenu(e.clientX, e.clientY, [
    { header: 'Typical heights' },
    ...[['Chibi / smol character', 90], ['Kid', 130], ['Short adult', 155], ['Average adult', 170], ['Tall adult', 185], ['Door', 210], ['1 m', 100]]
      .map(([l, v]) => ({ label: l, hint: fmtCm(v / 100), onClick: () => { axisSel.value = 'height'; cmInput.value = round1(toUnit(v / 100)); updateFactor(); applySize(); } })),
  ]) }, ic('list', 15), 'Presets');

  const unitSwitch = seg([{ value: 'cm', label: 'cm' }, { value: 'in', label: 'in' }], unit, (v) => app.actions.setUnits(v));
  unitSwitch.classList.add('mini');
  body.append(group('size', 'Size in Unity', 'ruler', { badge: unitSwitch, help: 'Measured the way Unity imports the model (scale 1, 1, 1). Width is X, height is Y, depth is Z. Switch between centimeters and inches here or in Settings.' },
    readout,
    warn ? h('div.banner.warn.compact', ic('alert', 15), h('div.grow', warn[0]), help(warn[1])) : null,
    fieldRow('Set the real size', 'Type how big the model should be in Unity along one axis. You see it here right away, and it is baked into the FBX when you export.',
      h('div.input-group', axisSel, cmInput, h('span.unit', unit), h('button.btn.small.primary', { onclick: applySize }, 'Apply')), factor),
    h('div.btn-row', presets, scaled ? h('button.btn.small.ghost', { onclick: () => { viewer.setFix({ scale: 1 }); saveFix({ target: null }); } }, ic('rotate-ccw', 15), 'Original size') : null)));

  // ---- facing
  const f = info.facing;
  const status = f
    ? (f.ok || rotated
      ? h('div.status-line.ok', ic('check-circle', 16), h('span.grow', rotated ? 'Rotation previewed' : 'Faces +Z (Unity forward)'))
      : h('div.status-line.warn', ic('compass', 16), h('span.grow', f.label),
        h('button.btn.small.primary', { onclick: () => { viewer.setFix({ quaternion: f.fix }); saveFix({}); toast('Facing fixed in the preview. Export to bake it in.', { kind: 'ok' }); } }, ic('wand', 15), 'Fix')))
    : h('div.status-line', ic('info', 16), h('span.grow', 'Check the blue floor arrow'), help('This is not a humanoid rig, so the facing can’t be detected. The blue arrow on the floor points to +Z (Unity forward): turn the model until its front faces the arrow.'));
  const rot = (axis, deg) => () => {
    const q = new THREE.Quaternion().setFromAxisAngle(axis, THREE.MathUtils.degToRad(deg));
    viewer.setFix({ quaternion: q.multiply(viewer.fix.quaternion) });
    saveFix({});
  };
  const Y = new THREE.Vector3(0, 1, 0), X = new THREE.Vector3(1, 0, 0), Z = new THREE.Vector3(0, 0, 1);
  const curRot = new THREE.Euler().setFromQuaternion(viewer.fix.quaternion);
  const rotText = [curRot.x, curRot.y, curRot.z].map((r) => Math.round(THREE.MathUtils.radToDeg(r)));
  body.append(group('facing', 'Facing', 'compass', { help: 'Unity expects characters to face +Z, the blue arrow on the floor. Humanoid rigs are checked automatically.' },
    status,
    h('div.ctl-grid',
      h('span.ctl-label', 'Turn'),
      h('div.btn-row', h('button.btn.small', { 'data-tip': 'Turn left 90°', onclick: rot(Y, 90) }, ic('rotate-ccw', 15), '90°'), h('button.btn.small', { 'data-tip': 'Turn right 90°', onclick: rot(Y, -90) }, ic('rotate-cw', 15), '90°'), h('button.btn.small', { onclick: rot(Y, 180) }, ic('flip', 15), '180°')),
      h('span.ctl-label', 'Lying down', help('For models saved with Z up instead of Y up (a common Blender/3ds Max mix-up): stand them up or tip them over.')),
      h('div.btn-row', h('button.btn.small', { onclick: rot(X, -90) }, 'Stand up'), h('button.btn.small', { onclick: rot(X, 90) }, 'Tip over'), h('button.btn.small', { onclick: rot(Z, 90) }, 'Roll 90°'))),
    rotated ? h('div.row', h('span.note.grow', `Preview: X ${rotText[0]}°, Y ${rotText[1]}°, Z ${rotText[2]}°`),
      h('button.btn.small.ghost', { onclick: () => { viewer.setFix({ quaternion: new THREE.Quaternion() }); saveFix({}); } }, ic('rotate-ccw', 15), 'Reset')) : null));

  if (scaled || rotated) {
    body.append(h('div.next-step', ic('info', 16), h('span.grow', 'Preview only. Export to bake it into the FBX.'),
      h('button.btn.small', { onclick: () => openPanel('export') }, 'Export', ic('chevron-right', 14))));
  }
}

function renderExportPage(body, info) {
  const p = app.prefs.export;
  const isBlend = extname(info.sourcePath) === '.blend';
  const blender = app.host?.blender?.[0];
  const fix = viewer.fix;
  const scaled = Math.abs((fix.scale || 1) - 1) > 1e-6;
  const rotated = fix.quaternion.w < 0.99999;
  const outPath = () => p.dest === 'beside' ? joinPath(dirname(info.sourcePath), stem(info.sourcePath).replace(/@.*/, '') + (extname(info.sourcePath) === '.fbx' ? '_Unity' : '') + '.fbx') : (p.customDir ? joinPath(p.customDir, stem(info.sourcePath) + '.fbx') : null);
  const pathLine = h('div.path-line');
  const refreshDest = () => {
    const o = outPath();
    pathLine.textContent = o || 'Choose a folder…';
    pathLine.title = o ? `${o}${p.textures === 'folder' ? '\n' + joinPath(dirname(o), 'Textures') + '\\' : ''}` : '';
  };
  refreshDest();
  const a = textureAssetName(assetFromFile(outPath() || info.sourcePath));
  const result = h('div');
  const exportBtn = h('button.btn.primary.wide', { disabled: !blender, onclick: async () => {
    const out = outPath();
    if (!out) { toast('Choose a destination folder first.'); return; }
    await runExport(out, result, exportBtn);
  } }, ic('download', 16), 'Export FBX');

  const bake = h('div.chips',
    h('span.chip' + (scaled ? '.accent' : ''), ic('ruler', 13), scaled ? `Size ×${(+fix.scale).toPrecision(3)}` : 'Original size'),
    h('span.chip' + (rotated ? '.accent' : ''), ic('compass', 13), rotated ? 'Rotated' : 'Original facing'),
    h('button.chip', { 'data-tip': 'Change size or facing', onclick: () => openPanel('size') }, ic('pencil', 13), 'Edit'));

  body.append(group('fbx', 'Unity FBX', 'download', { help: `Blender ${blender?.version || ''} writes a Unity-ready FBX: scale 1, 1, 1, Y up, +Z forward, no leaf bones, with your size and facing preview baked in.${isBlend ? '' : ' This file is imported into Blender first.'}` },
    !blender ? h('div.banner.warn.compact', ic('alert', 15), h('div.grow', 'Blender not found'), help('Exporting FBX uses Blender in the background. Set its path in Settings.')) : null,
    bake,
    fieldRow('Save to', null,
      seg([{ value: 'beside', label: 'Next to the source' }, { value: 'custom', label: 'Other folder…' }], p.dest, async (v) => {
        p.dest = v;
        if (v === 'custom') { const dir = await call('dialog.folder', { title: 'Export FBX to…', initialDir: p.customDir || dirname(info.sourcePath) }); if (dir) p.customDir = dir; }
        savePrefs(); refreshDest();
      }), pathLine),
    fieldRow('Textures', 'Textures folder: the images are copied next to the FBX in a Textures folder (best for Unity). Embedded: everything inside the one FBX file.',
      seg([{ value: 'folder', label: 'Textures folder' }, { value: 'embed', label: 'Embedded' }], p.textures, (v) => { p.textures = v; savePrefs(); refreshDest(); })),
    fieldRow('Texture names', `Standard: T_${a}_<Part>_<Map>, e.g. T_${a}_Body_BaseColor.png and T_${a}_Body_Normal.png. The map comes from how each texture is wired (BaseColor, Normal, Roughness, Metallic, AO, Emission...). Files already in that Textures folder keep their names.`,
      seg([{ value: 'standard', label: 'Standard for Unity' }, { value: 'original', label: 'Keep original' }], p.textureNames || 'standard', (v) => { p.textureNames = v; savePrefs(); })),
    fieldRow('Animations', 'All actions: every animation in the file. Active only: the one playing. None: just the model.',
      seg([{ value: 'all', label: 'All' }, { value: 'active', label: 'Active only' }, { value: 'none', label: 'None' }], p.animations, (v) => { p.animations = v; savePrefs(); })),
    group('fbx-more', 'More options', null, { open: false, sub: true },
      toggleRow(h('span.with-help', 'PBR materials for Unity', help('Writes a .materials.json next to the FBX so the Unity import helper builds URP or Standard materials with the right textures.')), null, p.pbrManifest, (v) => { p.pbrManifest = v; savePrefs(); }),
      toggleRow(h('span.with-help', 'Pack metallic + smoothness', help('Makes one texture in Unity’s layout: metallic in red, smoothness in alpha.')), null, p.packUnityMaskMaps, (v) => { p.packUnityMaskMaps = v; savePrefs(); })),
    exportBtn, result));

  const unityBox = h('div');
  body.append(group('unity', 'Send to Unity', 'send', { help: 'Exports (if needed) and copies the FBX, its textures and material file into a Unity project from Unity Hub. Unity imports it when you switch to it.' }, unityBox));
  renderUnity(unityBox, info);

  body.append(group('glb', 'Quick GLB', 'box', { open: false, help: 'A GLB of exactly what you see, with the size and facing preview applied, made without Blender. Good for the web, Godot or sharing.' },
    h('button.btn.wide', { onclick: () => app.actions.exportGLB() }, ic('download', 16), 'Export GLB…')));
}

function saveFix(patch) {
  const path = viewer.info?.sourcePath;
  if (!path) return;
  const q = viewer.fix.quaternion;
  const cur = entry(path)?.fix || {};
  const next = { ...cur, ...patch, q: [q.x, q.y, q.z, q.w], scale: viewer.fix.scale };
  if ('target' in patch && !patch.target) delete next.target;
  updateEntry(path, { fix: next });
}

/** Rotation for the Blender scripts: viewer space (Y up, +Z forward) → Blender (Z up, -Y forward). */
export function blenderQuat(q) {
  if (!q || Math.abs(q.w) > 0.999999) return null;
  return [q.w, q.x, -q.z, q.y];
}

/** "Mini Hero" -> "MiniHero": the <Asset> part of T_<Asset>_<Part>_<Map> (same rule as the Blender side). */
export function textureAssetName(name) {
  const words = (name || '').normalize('NFKD').replace(/[^\x00-\x7f]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter((w) => w && !/^(t|tex|texture)$/i.test(w));
  return words.map((w) => w[0].toUpperCase() + (w === w.toUpperCase() || w === w.toLowerCase() ? w.slice(1).toLowerCase() : w.slice(1))).join('') || 'Asset';
}

/** "D:\x\Hero54Applied.fbx" -> "Hero" (same rule as the Blender scripts' asset_from_filename). */
export function assetFromFile(path) {
  const st = stem(path || '').split('@')[0];
  let s = st.replace(/[\d_\-\s.]+(applied|final|rigged|baked|export|unity|fixed|new|v\d+)?[\d_\-\s.]*$/i, '');
  if (s === st) s = st.replace(/(?<=[a-z])(Applied|Final|Rigged|Baked|Export|Unity|Fixed|New|V\d+)[\d_\-\s.]*$/, '');
  return s || st || 'Asset';
}

export function exportArgs(info, out, assetName) {
  const p = app.prefs.export;
  const target = entry(info.sourcePath)?.fix?.target;
  return {
    source: info.sourcePath, out,
    targetSizeCm: viewer.fix.scale !== 1 && target?.cm ? target.cm : null,
    targetAxis: target?.axis || 'height',
    textures: p.textures, texturesDir: 'Textures', animations: p.animations,
    textureNames: p.textureNames || 'standard', assetName: assetName || assetFromFile(out),
    applyModifiers: p.applyModifiers !== false, onlyVisible: true,
    pbrManifest: !!p.pbrManifest, packUnityMaskMaps: !!p.packUnityMaskMaps,
    rotationQuat: blenderQuat(viewer.fix.quaternion),
  };
}

async function runExport(out, resultEl, btn, assetName) {
  const info = viewer.info;
  const exists = await call('fs.stat', { path: out }).catch(() => null);
  if (exists?.exists && !(await confirmDialog({ title: 'Replace the FBX?', message: `${out} already exists. Replace it with the new export?`, confirmLabel: 'Replace' }))) return;
  const jobId = newJobId();
  const bar = h('div.bar', h('i'));
  const text = h('div.note', 'Starting Blender…');
  setChildren(resultEl, h('div.card-box', { style: { marginTop: '10px' } }, text, bar,
    h('button.btn.small.ghost', { style: { marginTop: '6px' }, onclick: () => call('job.cancel', { jobId }) }, 'Cancel')));
  btn.disabled = true;
  const off = onHost('job.progress', (d) => { if (d.jobId === jobId) { text.textContent = d.message || 'Working…'; bar.firstChild.style.width = `${Math.round(d.progress * 100)}%`; } });
  try {
    const args = exportArgs(info, out, assetName);
    const res = await call('blender.run', { jobId, script: 'export_fbx.py', blend: extname(info.sourcePath) === '.blend' ? info.sourcePath : null, args });
    app.lastExport = { source: info.sourcePath, fbx: res.fbx || out, result: res };
    const stat = await call('fs.stat', { path: res.fbx || out }).catch(() => null);
    setChildren(resultEl, h('div.banner.ok', { style: { marginTop: '10px' } }, ic('check-circle', 16), h('div',
      h('b', 'Exported '), basename(res.fbx || out), stat?.size ? ` (${fmtBytes(stat.size)})` : '',
      h('div.note', [
        res.textures?.length ? `${res.textures.length} textures` : null,
        res.missing?.length ? `${res.missing.length} missing textures` : null,
        res.scaleFactor && Math.abs(res.scaleFactor - 1) > 1e-4 ? `scaled ×${(+res.scaleFactor).toPrecision(4)}` : null,
        res.sizeCmAfter ? `${res.sizeCmAfter.x?.toFixed?.(1)} × ${res.sizeCmAfter.y?.toFixed?.(1)} × ${res.sizeCmAfter.z?.toFixed?.(1)} cm` : null,
        res.seconds ? `${res.seconds}s` : null].filter(Boolean).join(' · ')),
      res.warnings?.length ? h('div.note', res.warnings.slice(0, 3).join(' · ')) : null,
      h('div.btn-row', { style: { marginTop: '8px' } },
        h('button.btn.small', { onclick: () => call('fs.reveal', { path: res.fbx || out }) }, ic('folder', 15), 'Show'),
        h('button.btn.small', { onclick: () => app.actions.open(res.fbx || out) }, ic('box', 15), 'Open FBX'),
        h('button.btn.small', { onclick: () => call('app.openWindow', { path: res.fbx || out }) }, ic('app-window', 15), 'Compare')))));
    toast(`Exported ${basename(res.fbx || out)}`, { kind: 'ok' });
    return res;
  } catch (e) {
    if (!e.cancelled) setChildren(resultEl, h('div.banner.bad', { style: { marginTop: '10px' } }, ic('alert', 16), h('div.sel', { style: { whiteSpace: 'pre-wrap' } }, e.message)));
    else setChildren(resultEl);
    return null;
  } finally {
    off();
    btn.disabled = false;
  }
}

async function renderUnity(box, info, outPath) {
  let projects = [];
  try { projects = await call('unity.projects'); } catch { /* no hub */ }
  const settings = app.host?.settings || {};
  if (!projects.length) {
    setChildren(box, h('div.note', 'No Unity projects found in Unity Hub.'),
      h('button.btn.small', { style: { marginTop: '8px' }, onclick: async () => {
        const dir = await call('dialog.folder', { title: 'Unity project folder (the one with Assets)' });
        if (dir) { await call('settings.set', { patch: { unityProject: dir } }); app.host.settings.unityProject = dir; renderUnity(box, info, outPath); }
      } }, ic('folder-open', 15), 'Choose project…'));
    return;
  }
  const sel = h('select.input', ...projects.map((p) => h('option', { value: p.path, selected: p.path === settings.unityProject }, `${p.title}${p.version ? ' - ' + p.version : ''}`)));
  const sub = h('input.input', { value: settings.unitySubfolder || 'Assets/Models' });
  const name = h('input.input', { value: stem(info.sourcePath).replace(/[\d_\-\s]+(applied|final|rigged|baked|export|v\d+)?$/i, '') || stem(info.sourcePath) });
  const importer = h('input', { type: 'checkbox', checked: true });
  const out = h('div');
  const btn = h('button.btn.primary.wide', { onclick: async () => {
    btn.disabled = true;
    try {
      let fbx = app.lastExport?.source === info.sourcePath ? app.lastExport.fbx : null;
      if (!fbx) {
        const tmp = joinPath(app.host.dataDir, 'exports', name.value || stem(info.sourcePath), (name.value || stem(info.sourcePath)) + '.fbx');
        const resultEl = h('div');
        setChildren(out, resultEl);
        const res = await runExport(tmp, resultEl, btn, name.value);
        if (!res) return;
        fbx = res.fbx || tmp;
      }
      const exported = app.lastExport?.fbx === fbx ? app.lastExport.result?.textures : undefined;
      const r = await call('unity.send', { fbx, project: sel.value, subfolder: sub.value, assetName: name.value, installImporter: importer.checked, textures: exported });
      app.host.settings.unityProject = sel.value;
      app.host.settings.unitySubfolder = sub.value;
      setChildren(out, h('div.banner.ok', { style: { marginTop: '10px' } }, ic('check-circle', 16), h('div', h('b', 'Sent to Unity'), h('div.note.sel', r.dest),
        h('div.note', 'Switch to Unity: it imports the model when the window gets focus.'),
        h('button.btn.small', { style: { marginTop: '8px' }, onclick: () => call('fs.reveal', { path: r.dest }) }, ic('folder', 15), 'Show'))));
    } catch (e) {
      setChildren(out, h('div.banner.bad', { style: { marginTop: '10px' } }, ic('alert', 16), h('div', e.message)));
    } finally { btn.disabled = false; }
  } }, ic('send', 16), 'Send to Unity');
  setChildren(box,
    h('div.field', h('label', 'Project'), sel),
    h('div.field', h('label', 'Folder in the project'), sub),
    h('div.field', h('label.with-help', h('span', 'Asset name'), help('The folder and file name in Unity, e.g. Assets/Models/Hero/Hero.fbx. Also used for the texture names.')), name),
    h('label.check', importer, h('span.with-help', 'Add the import helper script', help('Copies Assets/Editor/MeshboxModelImporter.cs into the project: scale 1, axis conversion, humanoid avatars and URP/Standard materials from the material file.'))),
    btn, out);
}
