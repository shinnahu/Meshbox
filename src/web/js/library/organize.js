// "Organize into library": one standard folder per model.
//   <Library>\<Project>\<Category>\<Asset>\
//       <Asset>.blend      the one working file (textures relinked to .\Textures)
//       <Asset>.fbx        Unity-ready export (scale 1,1,1, +Z forward, Textures folder)
//       Textures\          every texture both files use, standard names: T_<Asset>_<Part>_<Map>.png
//       Versions\          older .blend files, renamed by date, NTFS-compressed, still open in Blender
//       asset.json         where everything came from (+ SHA-256 of each version, old texture names)
// FBX / glTF / OBJ models go through Blender as well, so their textures are collected and renamed too.
// Originals are copied, never moved; recycling them afterwards is a separate, confirmed step.
// openOrganizer() = one model, step by step; openBatchOrganizer() = many models in one go.
import * as THREE from 'three';
import { app, entry, updateEntry, thumbUrl } from '../app.js';
import { h, ic, modal, setChildren, toast, fmtBytes, fmtDate, fmtCm, confirmDialog, promptDialog, seg, debounce } from '../dom.js';
import { call, basename, dirname, stem, joinPath, newJobId, on as onHost, blendThumbUrl } from '../host.js';
import { blenderQuat, textureAssetName } from '../ui/panels.js';
import { hydrateIcons } from '../icons.js';

const GENERIC = /^(3d ?models?|models?|assets?|art|3d|blender|fbx|meshes|characters?)$/i;
const IMPORTABLE = new Set(['.fbx', '.glb', '.gltf', '.obj', '.stl', '.ply', '.dae', '.abc', '.usd', '.usda', '.usdc', '.usdz']);
const STEPS = 5;
const slug = (s) => s.replace(/\(.*?\)/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const safeName = (s) => s.replace(/[<>:"/\\|?*]+/g, '').trim();
const ymd = (t) => new Date(t).toISOString().slice(0, 10);
const words = (s) => (s || '').replace(/([a-z])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean);
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

function guess(fam, siblings = 1) {
  const r = fam.asset?.root;
  let project = 'Projects', category = 'Models';
  if (r) {
    const rootName = basename(r.path);
    project = GENERIC.test(rootName) ? basename(dirname(r.path)) || rootName : rootName;
    if (r.kind === 'library') {
      const rel = fam.asset.dir.slice(r.path.length + 1).split('\\');
      project = rel[0] || project; category = rel[1] || category;
    } else {
      const rel = fam.asset.dir.slice(r.path.replace(/\\$/, '').length + 1).split('\\').filter(Boolean);
      if (rel.length >= 2) category = rel[0];
      else if (rel.length === 1 && !GENERIC.test(rel[0])) category = rel[0];
    }
  }
  // "mini-hero" -> "Mini Hero", "Hero_renders" -> "Hero Renders" (CamelCase names stay as they are)
  let name = (fam.display.replace(/[\s_\-.]+$/, '') || stem(fam.main.name)).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
    .split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  // One model alone in its folder, and the folder name says more ("Mini Hero\Hero.fbx"): use the folder.
  const folder = basename(fam.asset?.dir || '');
  if (siblings <= 1 && r && folder && !GENERIC.test(folder) && folder.toLowerCase() !== category.toLowerCase()
    && folder.toLowerCase().includes(name.toLowerCase()) && words(folder).length > words(name).length) name = folder;
  return { project: safeName(project), category: safeName(category), asset: safeName(name.charAt(0).toUpperCase() + name.slice(1)) };
}

/** What organizing a family would do by default: the working file, the files kept in Versions, and where it goes. */
export function planFamily(fam, { siblings = 1 } = {}) {
  const files = [...fam.files].sort((a, b) => b.mtime - a.mtime);
  const hasBlend = files.some((f) => f.ext === '.blend');
  const main = fam.main?.ext === '.blend' ? fam.main : files.find((f) => f.ext === '.blend') || fam.main || files[0];
  const archive = new Set(files.filter((f) => f.ext === '.blend').map((f) => f.path));
  if (!hasBlend && main) archive.add(main.path);          // no .blend: keep the untouched original as v001
  return { fam, files, hasBlend, main, archive, ...guess(fam, siblings) };
}

export const canUseBlender = (main) => !!main && (main.ext === '.blend' || IMPORTABLE.has(main.ext));
const assetDirOf = (job) => joinPath(app.host.settings.libraryRoot, job.project, job.category, job.asset);

/**
 * Copies one model into the library.
 *   job  = planFamily() result with { project, category, asset, main, archive } and
 *          opts { exportFbx, compress, applyFix, standardNames, saveBlend, existing: 'ask' | 'update' | 'skip' }
 *   ui   = { step(label) -> { set(text), done(ok, note) }, progress(0..1) }
 * Returns a report ({ status: 'done' | 'skipped', ... }); throws on failure ('Cancelled' if the user said no).
 */
export async function organizeAsset(job, ui) {
  const { files, main, archive, opts } = job;
  const dir = assetDirOf(job);
  const versionsDir = joinPath(dir, 'Versions');
  const report = { assetDir: dir, status: 'done', versions: [], copied: 0, savedBytes: 0, originals: [], missing: [], textures: [] };

  // existing asset?
  let asset = null;
  const existing = await call('fs.readText', { path: joinPath(dir, 'asset.json') }).catch(() => null);
  if (existing) {
    try { asset = JSON.parse(existing); } catch { asset = null; }
    if (asset && opts.existing === 'skip') { report.status = 'skipped'; return report; }
    if (asset && opts.existing !== 'update' && !(await confirmDialog({ title: `${job.asset} is already in the library`, message: 'Add these files as new versions and replace the main .blend and FBX with the ones made from your main file?', confirmLabel: 'Update asset' }))) throw new Error('Cancelled');
  }
  asset = asset || { schema: 1, name: job.asset, project: job.project, category: job.category, created: new Date().toISOString(), versions: [], organizedFrom: [] };
  await call('fs.mkdir', { path: versionsDir });

  // 1) versions: oldest first, numbered after what is already there
  const toArchive = files.filter((f) => archive.has(f.path)).sort((a, b) => a.mtime - b.mtime);
  const known = new Set(asset.versions.map((v) => v.sha256));
  let n = asset.versions.reduce((mx, v) => Math.max(mx, +(/_v(\d+)_/.exec(v.file)?.[1] || 0)), 0);
  const vItem = ui.step(`Archiving ${plural(toArchive.length, 'version')}`);
  let i = 0;
  for (const f of toArchive) {
    i++;
    ui.progress((i / Math.max(1, toArchive.length)) * 0.4);
    vItem.set(`Archiving versions ${i} / ${toArchive.length}: ${f.name}`);
    const sha = await call('fs.hash', { path: f.path });
    report.originals.push(f);
    if (known.has(sha)) continue;
    known.add(sha);
    n++;
    const name = `${job.asset}_v${String(n).padStart(3, '0')}_${ymd(f.mtime)}_${slug(stem(f.name)) || 'v'}${f.ext}`;
    const dest = joinPath(versionsDir, name);
    await call('fs.copy', { from: f.path, to: dest, overwrite: false });
    asset.versions.push({ file: `Versions/${name}`, date: new Date(f.mtime).toISOString(), source: f.path, sha256: sha, size: f.size, note: stem(f.name) });
    report.versions.push(dest);
    report.copied += f.size;
  }
  vItem.done(true, `${report.versions.length} copied${toArchive.length - report.versions.length ? `, ${toArchive.length - report.versions.length} identical skipped` : ''}`);

  // 2) main file + textures + Unity FBX through Blender
  const isBlend = main.ext === '.blend';
  if (canUseBlender(main) && (isBlend || opts.saveBlend || opts.exportFbx)) {
    const what = [isBlend || opts.saveBlend ? `${job.asset}.blend` : null, opts.exportFbx ? `${job.asset}.fbx` : null].filter(Boolean).join(' and ');
    const bItem = ui.step(isBlend ? `Saving ${what} with its textures` : `Importing ${main.name} and saving ${what}`);
    const jobId = newJobId();
    const off = onHost('job.progress', (d) => { if (d.jobId === jobId) { ui.progress(0.4 + d.progress * 0.5); if (d.message) bItem.set(d.message); } });
    const fix = opts.applyFix ? entry(main.path)?.fix : null;
    const p = app.prefs.export;
    try {
      const res = await call('blender.run', { jobId, script: 'organize.py', blend: isBlend ? main.path : null, args: {
        source: main.path, assetDir: dir, assetName: job.asset, texturesDir: 'Textures', exportFbx: opts.exportFbx,
        textureNames: opts.standardNames ? 'standard' : 'original', saveBlend: isBlend || opts.saveBlend,
        fbx: { textures: 'folder', texturesDir: 'Textures', animations: p.animations, applyModifiers: true, onlyVisible: true,
          pbrManifest: !!p.pbrManifest, packUnityMaskMaps: !!p.packUnityMaskMaps,
          targetSizeCm: fix?.target?.cm && fix.scale !== 1 ? fix.target.cm : null, targetAxis: fix?.target?.axis || 'height',
          rotationQuat: fix?.q ? blenderQuat(new THREE.Quaternion().fromArray(fix.q)) : null },
      } });
      report.blend = res.blend; report.fbx = res.fbx; report.missing = res.missing || []; report.textures = res.textures || [];
      bItem.set(`Saved ${[res.blend ? basename(res.blend) : null, res.fbx ? basename(res.fbx) : null].filter(Boolean).join(' and ')}`);
      bItem.done(true, `${report.textures.length} textures in Textures\\${opts.standardNames ? ' with standard names' : ''}${report.missing.length ? `, ${report.missing.length} missing` : ''}`);
      asset.main = basename(res.blend || res.fbx || `${job.asset}.blend`);
      if (res.fbx) asset.unityFbx = basename(res.fbx);
      asset.textures = 'Textures';
      asset.textureNames = opts.standardNames ? 'standard' : 'original';
      const seenTex = new Set();
      asset.textureSources = (res.textureReport || []).filter((t) => t.to && !seenTex.has(t.to.toLowerCase()) && seenTex.add(t.to.toLowerCase()))
        .map((t) => ({ file: t.to, from: t.from || `packed in ${main.name} (${t.image})`, map: t.map || null }));
      if (fix) asset.fix = fix;
    } finally { off(); }
  } else {
    const cItem = ui.step(`Copying ${main.name}`);
    const dest = joinPath(dir, `${job.asset}${main.ext}`);
    await call('fs.copy', { from: main.path, to: dest, overwrite: true });
    asset.main = basename(dest);
    cItem.done(true);
  }

  // 3) compress the archive
  if (opts.compress && report.versions.length) {
    const cItem = ui.step('Compressing Versions');
    const saved = await call('fs.compress', { paths: report.versions });
    report.savedBytes = saved;
    cItem.done(true, saved > 0 ? `${fmtBytes(saved)} saved` : 'not compressible (already compressed .blend files)');
  }

  // 4) asset.json
  asset.updated = new Date().toISOString();
  asset.organizedFrom = [...new Set([...(asset.organizedFrom || []), ...files.filter((f) => archive.has(f.path) || f === main).map((f) => f.path)])];
  await call('fs.writeText', { path: joinPath(dir, 'asset.json'), text: JSON.stringify(asset, null, 2) });
  ui.step('Wrote asset.json').done(true);

  // 5) thumbnail (the FBX is quick to load; the .blend gets the same picture)
  if (report.fbx) {
    const tItem = ui.step('Thumbnail');
    try {
      const { makeThumb } = await import('./library.js');
      const st = await call('fs.stat', { path: report.fbx });
      await makeThumb({ path: report.fbx, name: basename(report.fbx), ext: '.fbx', modified: st.modified, size: st.size });
      const e = entry(report.fbx);
      if (report.blend && e?.thumb) updateEntry(report.blend, { thumb: e.thumb, thumbAt: e.thumbAt, meta: e.meta });
      tItem.done(true);
    } catch (err) { tItem.done(false, err.message); }
  }
  ui.progress(1);
  return report;
}

/** The originals a finished report may offer to recycle (never the files it just made). */
function originalsOf(report) {
  const made = new Set([report.blend, report.fbx].filter(Boolean).map((p) => p.toLowerCase()));
  return report.originals.filter((f) => !made.has(f.path.toLowerCase()));
}

async function chooseLibraryRoot() {
  const dir = await call('dialog.folder', { title: 'Library folder (one place for all projects)' });
  if (dir) app.host.settings = await call('settings.set', { patch: { libraryRoot: dir } });
  return dir;
}

// ================================================================= one model, step by step
export async function openOrganizer(fam, { siblings = 1 } = {}) {
  const plan = planFamily(fam, { siblings });
  const { files, hasBlend, archive } = plan;
  let main = plan.main;
  const opts = { project: plan.project, category: plan.category, asset: plan.asset, exportFbx: true, compress: true, applyFix: true, standardNames: true, saveBlend: true };
  const viaBlender = () => canUseBlender(main);
  const assetDir = () => assetDirOf(opts);
  const tex = { key: null, jobId: null, running: false, plan: null, error: null };
  let step = 0;
  const body = h('div');
  const m = modal({ title: `Organize “${fam.display}”`, subtitle: 'Copies the files into one tidy folder. Your originals stay where they are.', wide: true, body, onClose: cancelPlan });
  render();

  function steps() { return h('div.steps', ...Array.from({ length: STEPS }, (_, i) => h('span' + (i <= step ? '.on' : '')))); }

  function render() {
    if (step === 0) renderFiles();
    else if (step === 1) renderDest();
    else if (step === 2) renderTextures();
    else if (step === 3) renderOptions();
    hydrateIcons(body);
  }

  function renderFiles() {
    const rows = files.map((f) => {
      const t = f.ext === '.blend' ? blendThumbUrl(f.path, f.modified) : null;
      const radio = h('input', { type: 'radio', name: 'main', checked: f === main, disabled: f.ext !== '.blend' && hasBlend, onchange: () => { main = f; archive.add(f.path); render(); } });
      const cb = h('input', { type: 'checkbox', checked: archive.has(f.path), onchange: () => { cb.checked ? archive.add(f.path) : archive.delete(f.path); updateFoot(); } });
      return h('div.file-row',
        cb,
        t ? h('img', { src: t, loading: 'lazy', onerror: (e) => e.target.replaceWith(h('div.noimg')) }) : h('div.noimg'),
        h('div', { style: { minWidth: 0 } }, h('div.ellipsis', { 'data-tip': f.path }, f.name), h('div.sub', `${fmtDate(f.mtime)} · ${dirname(f.path).slice(fam.asset.dir.length) || '.'}`)),
        h('span.muted', fmtBytes(f.size)),
        h('label.row', { style: { gap: '4px', fontSize: '12px' } }, radio, f === main ? h('span.tag', 'main') : h('span.muted', 'main')));
    });
    setChildren(body, steps(),
      hasBlend
        ? h('p.note', 'Pick the ', h('b', 'main file'), ' (your latest working .blend). Ticked files are archived as versions in the Versions folder, oldest = v001. Old FBX/GLB exports are not needed: a fresh Unity FBX is made from the main file.')
        : h('p.note', 'This model has no .blend. Blender imports the ', h('b', 'main file'), ', collects its textures, saves a .blend and a fresh Unity FBX. Ticked files are kept untouched in the Versions folder.'),
      h('div.file-list', ...rows));
    updateFoot();
  }

  function updateFoot() {
    const n = archive.size;
    const size = files.filter((f) => archive.has(f.path)).reduce((s, f) => s + f.size, 0);
    m.setButtons([{ label: 'Cancel', kind: 'ghost' }, { label: 'Next', kind: 'primary', disabled: !main, onClick: () => { step = 1; render(); return false; } }],
      `${plural(n, 'file')} to archive · ${fmtBytes(size)}`);
  }

  function renderDest() {
    const root = app.host.settings.libraryRoot;
    const field = (key, label) => h('div.field', h('label', label), h('input.input', { value: opts[key], oninput: (e) => { opts[key] = safeName(e.target.value); preview(); } }));
    const pathEl = h('div.path-preview');
    const free = h('div.note');
    const preview = () => {
      const dir = root ? assetDir() : '(choose a library folder first)';
      const a = textureAssetName(opts.asset);
      setChildren(pathEl, `${dir}\\\n   ${opts.asset}.blend\n   ${opts.asset}.fbx\n   Textures\\T_${a}_Body_BaseColor.png …\n   Versions\\${opts.asset}_v001_${ymd(Date.now())}_….blend\n   asset.json`);
    };
    preview();
    if (root) call('fs.free', { path: root }).then((b) => {
      const need = files.filter((f) => archive.has(f.path)).reduce((s, f) => s + f.size, 0) * 1.3 + main.size * 2;
      setChildren(free, b >= 0 ? `${fmtBytes(b)} free on ${root.slice(0, 2)} · about ${fmtBytes(need)} needed` : '');
      if (b >= 0 && b < need) free.className = 'note bad';
    });
    setChildren(body, steps(),
      h('div.field', h('label', 'Library folder'),
        h('div.input-group', h('input.input.sel', { readOnly: true, value: root || '', placeholder: 'Choose where your library lives, e.g. E:\\3D Library' }),
          h('button.btn', { onclick: async () => { if (await chooseLibraryRoot()) render(); } }, root ? 'Change…' : 'Choose…'))),
      h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' } }, field('project', 'Project'), field('category', 'Category'), field('asset', 'Asset name')),
      h('div.field', h('label', 'Will create'), pathEl, free));
    m.setButtons([{ label: 'Back', kind: 'ghost', onClick: () => { step = 0; render(); return false; } },
      { label: 'Next', kind: 'primary', disabled: !root, onClick: () => {
        if (!opts.asset || !opts.project || !opts.category) { toast('Fill in project, category and asset name.'); return false; }
        step = viaBlender() ? 2 : 3; render(); return false;
      } }]);
  }

  // ---- step 2: what happens to each texture (a read-only Blender pass over the main file)
  function cancelPlan() { if (tex.running && tex.jobId) call('job.cancel', { jobId: tex.jobId }).catch(() => {}); }
  function loadPlan() {
    const key = `${main.path}|${opts.asset}|${assetDir()}`;
    if (tex.key === key) return;
    cancelPlan();
    Object.assign(tex, { key, jobId: newJobId(), running: true, plan: null, error: null });
    call('blender.run', { jobId: tex.jobId, script: 'organize.py', blend: main.ext === '.blend' ? main.path : null,
      args: { source: main.path, assetDir: assetDir(), assetName: opts.asset, texturesDir: 'Textures', textureNames: 'standard', dryRun: true } })
      .then((r) => { if (tex.key === key) tex.plan = r; })
      .catch((e) => { if (tex.key === key && !e.cancelled) tex.error = e; })
      .finally(() => { if (tex.key === key) { tex.running = false; if (step === 2) render(); } });
  }

  function renderTextures() {
    loadPlan();
    const a = tex.plan?.textureAsset || textureAssetName(opts.asset);
    const check = h('label.check', h('input', { type: 'checkbox', checked: opts.standardNames, onchange: (e) => { opts.standardNames = e.target.checked; render(); } }),
      h('span', 'Standard texture names for Unity', h('small', `T_${a}_<Part>_<Map>, e.g. T_${a}_Body_BaseColor.png, T_${a}_Body_Normal.png. The .blend and the FBX point at the new names.`)));
    let content;
    if (tex.running) content = h('div.note', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '14px 2px' } }, ic('loader', 16, 'spin'), `Reading the textures of ${main.name} with Blender…`);
    else if (tex.error) content = h('div.banner.warn', ic('alert', 16), h('div', 'Could not read the textures: ', tex.error.message, h('div.note', 'You can still organize: the textures are collected while saving.')));
    else if (tex.plan) content = planTable(tex.plan);
    setChildren(body, steps(),
      h('p.note', 'Every texture the model uses is copied into ', h('b', 'Textures'), ' (packed ones are unpacked). The map name comes from how the texture is wired in the material: ',
        h('b', 'BaseColor'), ' (diffuse/albedo), ', h('b', 'Normal'), ', ', h('b', 'Roughness'), ', ', h('b', 'Metallic'), ', ', h('b', 'AO'), ', ', h('b', 'Emission'), ', ', h('b', 'Opacity'), '; toon shade maps become ', h('b', 'Shadow'), '.'),
      check, content);
    m.setButtons([{ label: 'Back', kind: 'ghost', onClick: () => { step = 1; render(); return false; } },
      { label: 'Next', kind: 'primary', onClick: () => { step = 3; render(); return false; } }],
      tex.plan ? `${(tex.plan.textures || []).filter((t) => t.to).length} textures to copy` : '');
  }

  function planTable(texPlan) {
    const rows = texPlan.textures || [];
    if (!rows.length) return h('div.banner.info', ic('info', 16), h('div', 'This model uses no image textures.'));
    const n = (how) => rows.filter((r) => r.how === how).length;
    const chips = h('div.chips', { style: { margin: '8px 0 6px' } },
      h('span.chip', plural(rows.length, 'texture')),
      n('packed') ? h('span.chip.accent', ic('package', 13), `${n('packed')} packed in the file`) : null,
      n('relinked') ? h('span.chip.warn', { 'data-tip': 'The link was broken; found by name in a nearby folder' }, ic('link', 13), `${n('relinked')} found elsewhere`) : null,
      n('missing') ? h('span.chip.bad', ic('unlink', 13), `${n('missing')} missing`) : null);
    const seen = new Set();
    const short = (dir) => { const parts = (dir || '').split('\\').filter(Boolean); return parts.length > 3 ? '…\\' + parts.slice(-3).join('\\') : dir; };
    const body = rows.filter((r) => { const k = (r.to || r.image).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).map((r) => {
      const oldName = r.from ? basename(r.from) : r.image;
      const sub = r.how === 'packed' ? 'packed in the file' : r.how === 'relinked' ? `link was broken, found in ${short(dirname(r.from))}` : r.how === 'missing' ? `missing (was in ${short(dirname(r.from || ''))})` : r.how === 'kept' ? 'already in Textures' : '';
      const target = !r.to ? h('span.bad', 'not copied')
        : opts.standardNames ? h('span.new', basename(r.to)) : h('span.muted', 'keeps its name');
      return h('tr',
        h('td', h('div.old', { 'data-tip': r.from || r.image }, oldName), sub ? h('div.sub', sub) : null),
        h('td.arrow', ic('chevron-right', 14)),
        h('td', target),
        h('td', r.map && opts.standardNames ? h('span.chip', { style: { height: '20px', fontSize: '11px' } }, r.map) : h('span.muted', '-')));
    });
    return h('div', chips, h('div.tex-plan-wrap', h('table.tex-plan',
      h('thead', h('tr', h('th', 'Now'), h('th', ''), h('th', 'In Textures\\'), h('th', 'Map'))), h('tbody', ...body))));
  }

  function renderOptions() {
    const fix = entry(main.path)?.fix;
    const hasFix = fix && ((fix.q && Math.abs(fix.q[3]) < 0.99999) || (fix.scale && fix.scale !== 1));
    const check = (key, label, sub) => h('label.check', h('input', { type: 'checkbox', checked: opts[key], onchange: (e) => { opts[key] = e.target.checked; } }), h('span', label, sub ? h('small', sub) : null));
    const isBlend = main.ext === '.blend';
    setChildren(body, steps(),
      !isBlend && viaBlender() ? check('saveBlend', `Save ${opts.asset}.blend`, `A Blender working file made from ${main.name}, so the asset has the usual .blend + FBX pair`) : null,
      viaBlender() ? check('exportFbx', `Export ${opts.asset}.fbx for Unity`, 'Scale 1,1,1, +Z forward, textures in the Textures folder (needs Blender)') : null,
      hasFix && viaBlender() ? check('applyFix', 'Apply the size/facing fix you previewed', `${fix.target?.cm ? `${fix.target.axis} ${fmtCm(fix.target.cm / 100)}` : ''}${fix.q && Math.abs(fix.q[3]) < 0.99999 ? ' · rotated' : ''}`) : null,
      check('compress', 'Compress the Versions folder (NTFS)', 'Old .blend files stay normal files Blender opens directly, they just take less disk space'),
      viaBlender() ? h('div.note', { style: { margin: '4px 0 0 25px' } }, opts.standardNames ? `Texture names: T_${textureAssetName(opts.asset)}_<Part>_<Map>` : 'Texture names: kept as they are') : null,
      h('div.banner.info', { style: { marginTop: '10px' } }, ic('info', 16), h('div',
        h('b', 'From now on: '), 'work on ', h('b', `${opts.asset}.blend`), ' only. When you reach a milestone (rigged, weights fixed, baked…) use File → Save Milestone in Blender (Settings → Install add-on): it drops a dated copy in Versions with a note, instead of saving Hero55, Hero56…')));
    m.setButtons([{ label: 'Back', kind: 'ghost', onClick: () => { step = viaBlender() ? 2 : 1; render(); return false; } },
      { label: 'Organize', kind: 'primary', icon: 'archive', onClick: () => { cancelPlan(); step = 4; run(); return false; } }]);
  }

  async function run() {
    const job = { ...plan, main, archive, project: opts.project, category: opts.category, asset: opts.asset, opts: { ...opts, existing: 'ask' } };
    const list = h('div.progress-list');
    const bar = h('div.bar', h('i'));
    const ui = {
      step: (label) => {
        const state = h('span.state', ic('loader', 15, 'spin'));
        const text = h('span.grow', label);
        const row = h('div.p-item', state, text);
        list.append(row);
        hydrateIcons(row);
        return {
          set: (t) => { text.firstChild.textContent = t; },
          done: (ok = true, note) => { setChildren(state, ic(ok ? 'check' : 'alert', 15)); state.className = 'state ' + (ok ? 'ok' : 'bad'); if (note) text.append(h('span.muted', ' - ' + note)); hydrateIcons(state); },
        };
      },
      progress: (f) => { bar.firstChild.style.width = `${Math.round(f * 100)}%`; },
    };
    setChildren(body, steps(), h('div.path-preview', assetDir()), h('div', { style: { height: '10px' } }), bar, h('div', { style: { height: '10px' } }), list);
    m.setButtons([{ label: 'Working…', kind: 'ghost', disabled: true }]);
    call('window.busy', { busy: true });
    try {
      finish(await organizeAsset(job, ui));
    } catch (e) {
      if (e.message !== 'Cancelled') { ui.step(e.message).done(false); toast('Organize failed: ' + e.message, { kind: 'bad' }); }
      m.setButtons([{ label: 'Close', kind: 'primary' }]);
    } finally {
      call('window.busy', { busy: false });
    }
  }

  function finish(report) {
    const originals = originalsOf(report);
    const size = originals.reduce((s, f) => s + f.size, 0);
    body.append(h('div.banner.ok', { style: { marginTop: '12px' } }, ic('check-circle', 16), h('div',
      h('b', `${opts.asset} is organized.`), h('div.note', `${plural(report.versions.length, 'version')} archived${report.savedBytes > 0 ? `, ${fmtBytes(report.savedBytes)} saved by compression` : ''}.`),
      report.missing?.length ? h('div.note.warn', `${report.missing.length} textures were missing and could not be copied: ${report.missing.slice(0, 4).map((x) => x.image || x).join(', ')}…`) : null,
      h('div.btn-row', { style: { marginTop: '8px' } },
        h('button.btn.small', { onclick: () => call('fs.reveal', { path: report.assetDir }) }, ic('folder', 14), 'Open folder'),
        report.fbx ? h('button.btn.small', { onclick: () => { m.close(); app.actions.open(report.fbx); } }, ic('box', 14), 'View FBX') : null,
        report.blend ? h('button.btn.small', { onclick: () => call('fs.openInBlender', { path: report.blend }) }, ic('blender', 14), 'Open .blend') : null))));
    if (originals.length) {
      body.append(h('div.banner.warn', { style: { marginTop: '8px' } }, ic('trash', 16), h('div',
        originals.length > 1 ? `The ${originals.length} original files (${fmtBytes(size)}) are still in their old folders. Once you have checked the new folder, you can move them to the Recycle Bin.`
          : `The original file (${fmtBytes(size)}) is still in its old folder. Once you have checked the new folder, you can move it to the Recycle Bin.`,
        h('div', h('button.btn.small.danger', { style: { marginTop: '8px' }, onclick: async () => {
          const { recycle } = await import('./library.js');
          await recycle(originals, { title: `Recycle the ${plural(originals.length, 'original')} of ${opts.asset}?` });
        } }, ic('trash', 14), 'Recycle originals…')))));
    }
    hydrateIcons(body);
    m.setButtons([{ label: 'Done', kind: 'primary', onClick: async () => { const lib = await import('./library.js'); lib.scan(); } }]);
  }
}

// ================================================================= many models in one go
/**
 * Review the destination of every model (editable), then organize them one after another.
 * siblings(fam): how many models share fam's folder (a model alone in its folder is named after it).
 * onRun(running): called when the run starts/ends (the library pauses its thumbnail queue).
 */
export function openBatchOrganizer(families, { title, siblings = () => 1, onRun, onDone } = {}) {
  const fams = families.filter((f) => !f.isAnim && f.files?.length);
  const rows = fams.map((fam) => {
    const plan = planFamily(fam, { siblings: siblings(fam) });
    const inLibrary = fam.asset?.root?.kind === 'library';
    return { ...plan, on: !inLibrary, inLibrary, exists: false, dup: false, hint: null, state: 'queued', report: null, el: null };
  });
  // A folder with a .blend model: the FBX/VRM/GLB-only "models" next to it are most likely its exports.
  const blendDirs = new Set(rows.filter((r) => r.hasBlend).map((r) => r.fam.asset.dir.toLowerCase()));
  for (const r of rows) if (!r.hasBlend && blendDirs.has(r.fam.asset.dir.toLowerCase())) { r.on = false; r.hint = 'export'; }
  // Two models that would land in the same folder: the one whose folder has that name keeps it,
  // the other is named after its own folder ("Mini Hero"), or left unticked for you to rename.
  const keyOf = (r) => `${r.project}|${r.category}|${r.asset}`.toLowerCase();
  const groups = new Map();
  for (const r of rows.filter((x) => x.on)) { const k = keyOf(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  const taken = new Set(groups.keys());
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const keeper = list.find((r) => basename(r.fam.asset.dir).toLowerCase() === r.asset.toLowerCase()) || list[0];
    for (const r of list) {
      if (r === keeper) continue;
      const folder = basename(r.fam.asset.dir);
      if (folder && !GENERIC.test(folder) && folder.toLowerCase() !== r.category.toLowerCase() && folder.toLowerCase() !== r.asset.toLowerCase()) {
        const cand = safeName(folder.toLowerCase().includes(r.asset.toLowerCase()) ? folder : `${folder} ${r.asset}`);
        const k = `${r.project}|${r.category}|${cand}`.toLowerCase();
        if (!taken.has(k)) { r.asset = cand; taken.add(k); continue; }
      }
      r.on = false; r.hint = 'clash'; r.clashWith = keeper.fam.asset.dir;
    }
  }
  const opts = { exportFbx: true, compress: true, applyFix: true, standardNames: true, saveBlend: true, existing: 'skip' };
  let filter = '';
  let stop = false;
  let freeBytes = null;
  const body = h('div');
  const m = modal({ title: title || `Organize ${plural(rows.length, 'model')}`, subtitle: 'Each model gets its own folder in your library, one after another. Originals are only copied: nothing is moved or deleted.', wide: true, body, dismissable: false });
  m.el.classList.add('xwide');
  const tbody = h('tbody');
  const footNote = () => {
    const on = rows.filter((r) => r.on);
    const versions = on.reduce((s, r) => s + r.files.filter((f) => r.archive.has(f.path)).length, 0);
    const need = on.reduce((s, r) => s + r.files.filter((f) => r.archive.has(f.path)).reduce((t, f) => t + f.size, 0) + (r.main?.size || 0) * 2, 0);
    const root = app.host.settings.libraryRoot;
    return `${plural(on.length, 'model')} · ${plural(versions, 'version')} to archive · about ${fmtBytes(need)} plus textures${root && freeBytes != null && freeBytes >= 0 ? ` · ${fmtBytes(freeBytes)} free on ${root.slice(0, 2)}` : ''}`;
  };
  const validate = debounce(() => { markDuplicates(); checkExisting(); }, 350);
  renderReview();
  checkExisting();

  // ---- review
  function renderReview() {
    const root = app.host.settings.libraryRoot;
    m.setTitle(title || `Organize ${plural(rows.length, 'model')}`);
    const check = (key, label, sub) => h('label.check', h('input', { type: 'checkbox', checked: opts[key], onchange: (e) => { opts[key] = e.target.checked; } }), h('span', label, sub ? h('small', sub) : null));
    const noBlender = !app.host?.blender?.length && rows.some((r) => canUseBlender(r.main));
    const search = h('input.input', { placeholder: 'Filter by name or folder…', value: filter, style: { maxWidth: '320px' }, oninput: (e) => { filter = e.target.value.toLowerCase(); applyFilter(); } });
    const allBox = h('input', { type: 'checkbox', 'data-tip': 'All shown', checked: rows.length > 0 && rows.every((r) => r.on), onchange: (e) => { for (const r of rows) if (shown(r)) r.on = e.target.checked; renderRows(); } });
    setChildren(body,
      noBlender ? h('div.banner.warn', { style: { marginBottom: '10px' } }, ic('alert', 16), h('div', 'No Blender install was found (Settings > Blender). Without it models are only copied: no .blend from FBX, no Unity FBX, no texture renaming.')) : null,
      h('div.field', h('label', 'Library folder'),
        h('div.input-group', h('input.input.sel', { readOnly: true, value: root || '', placeholder: 'Choose where your library lives, e.g. E:\\3D Library' }),
          h('button.btn', { onclick: async () => { if (await chooseLibraryRoot()) { freeBytes = null; renderReview(); checkExisting(); } } }, root ? 'Change…' : 'Choose…'))),
      h('div.batch-opts',
        check('standardNames', 'Standard texture names', 'T_Asset_Part_Map'),
        check('exportFbx', 'Export a Unity FBX', 'scale 1,1,1, +Z forward'),
        check('saveBlend', 'Make a .blend for FBX-only models', 'imported in Blender'),
        check('compress', 'Compress the Versions folders', 'NTFS, files still open normally'),
        check('applyFix', 'Apply previewed size/facing fixes', 'the ones you set in the viewer'),
        h('div', h('div.field-label', { style: { margin: '6px 0 5px' } }, 'Already in the library'),
          seg([{ value: 'skip', label: 'Skip' }, { value: 'update', label: 'Add versions' }], opts.existing, (v) => { opts.existing = v; renderRows(); }))),
      h('div.batch-tools', search,
        h('button.btn.small', { onclick: () => setForTicked('project', 'Project') }, 'Set project…'),
        h('button.btn.small', { onclick: () => setForTicked('category', 'Category') }, 'Set category…'),
        h('span.grow'),
        h('span.note', 'Edit any name below. Main file: newest .blend.')),
      h('div.batch-wrap', h('table.batch-table',
        h('thead', h('tr', h('th', allBox), h('th', 'Model'), h('th', 'Files'), h('th', 'Project'), h('th', 'Category'), h('th', 'Asset'), h('th', ''))),
        tbody)));
    renderRows();
    if (root && freeBytes == null) call('fs.free', { path: root }).then((b) => { freeBytes = b; updateFoot(); }).catch(() => {});
  }

  function shown(r) {
    if (!filter) return true;
    return r.fam.display.toLowerCase().includes(filter) || r.fam.asset.dir.toLowerCase().includes(filter) || r.asset.toLowerCase().includes(filter);
  }

  function renderRows() {
    markDuplicates();
    setChildren(tbody, ...rows.map(rowEl));
    applyFilter();
    updateFoot();
  }

  function applyFilter() { for (const r of rows) if (r.tr) r.tr.hidden = !shown(r); }

  function rowEl(r) {
    const t = thumbUrl(r.main.path) || (r.main.ext === '.blend' ? blendThumbUrl(r.main.path, r.main.modified) : null);
    const blends = r.files.filter((f) => f.ext === '.blend').length;
    const others = r.files.length - blends;
    const size = r.files.reduce((s, f) => s + f.size, 0);
    const input = (key) => h('input.input', { value: r[key], 'data-key': key, oninput: (e) => { r[key] = safeName(e.target.value); validate(); } });
    const cb = h('input', { type: 'checkbox', checked: r.on, onchange: (e) => { r.on = e.target.checked; r.tr.classList.toggle('off', !r.on); markDuplicates(); updateFoot(); } });
    r.chip = h('td');
    r.tr = h('tr' + (r.on ? '' : '.off'),
      h('td', cb),
      h('td', h('div.model', t ? h('img', { src: t, loading: 'lazy', onerror: (e) => e.target.replaceWith(h('div.noimg')) }) : h('div.noimg'),
        h('div', { style: { minWidth: 0 } }, h('div.t.ellipsis', { 'data-tip': r.fam.asset.dir }, r.fam.display), h('div.sub.ellipsis', { 'data-tip': r.main.path }, `${r.main.name} · ${r.fam.asset.label}`)))),
      h('td', h('div', [blends ? `${blends} .blend` : null, others ? `${others} other` : null].filter(Boolean).join(' · ')), h('div.sub', fmtBytes(size))),
      h('td', input('project')), h('td', input('category')), h('td', input('asset')),
      r.chip);
    updateChip(r);
    return r.tr;
  }

  function updateChip(r) {
    if (!r.chip) return;
    let chip;
    if (r.dup) chip = h('span.chip.bad', { 'data-tip': 'Another ticked model goes to the same folder: rename one' }, 'Same folder');
    else if (!r.asset || !r.project || !r.category) chip = h('span.chip.bad', 'Needs a name');
    else if (r.exists) chip = h('span.chip.warn', { 'data-tip': opts.existing === 'skip' ? 'This folder already has an organized asset: it is left as it is' : 'New versions are added and the .blend/FBX are made again' }, opts.existing === 'skip' ? 'In library: skip' : 'In library: update');
    else if (!r.on && r.hint === 'export') chip = h('span.chip', { 'data-tip': 'This folder also has a .blend model, and organizing it makes a fresh FBX. Tick this if it is a different model.' }, 'Likely an export');
    else if (!r.on && r.hint === 'clash') chip = h('span.chip.warn', { 'data-tip': `A model in ${r.clashWith} already uses this name. Rename it here, then tick it.` }, 'Same name');
    else if (r.inLibrary) chip = h('span.chip.accent', 'In library');
    else if (!canUseBlender(r.main)) chip = h('span.chip', { 'data-tip': 'Blender cannot import this format: the file is copied as is' }, 'Copy only');
    else chip = h('span.chip.ok', 'New');
    setChildren(r.chip, chip);
  }

  function markDuplicates() {
    const seen = new Map();
    for (const r of rows) { r.dup = false; }
    for (const r of rows.filter((x) => x.on)) {
      const k = `${r.project}|${r.category}|${r.asset}`.toLowerCase();
      if (seen.has(k)) { r.dup = true; seen.get(k).dup = true; } else seen.set(k, r);
    }
    for (const r of rows) {
      updateChip(r);
      r.tr?.querySelectorAll('input.input').forEach((el) => el.classList.toggle('bad', r.on && (r.dup || !r[el.dataset.key])));
    }
    updateFoot();
  }

  async function checkExisting() {
    const root = app.host.settings.libraryRoot;
    if (!root || !rows.length) return;
    try {
      const res = await call('fs.exists', { paths: rows.map((r) => joinPath(assetDirOf(r), 'asset.json')) });
      rows.forEach((r, i) => { r.exists = !!res[i]; updateChip(r); });
    } catch { /* keep the old marks */ }
  }

  async function setForTicked(key, label) {
    const first = rows.find((r) => r.on);
    const v = await promptDialog({ title: `${label} for all ticked models`, label, value: first ? first[key] : '', confirmLabel: 'Set' });
    if (v == null) return;
    const val = safeName(v);
    if (!val) return;
    for (const r of rows) if (r.on) r[key] = val;
    renderRows();
    checkExisting();
  }

  function updateFoot() {
    if (stop === 'running') return;
    const on = rows.filter((r) => r.on);
    const bad = on.some((r) => r.dup || !r.asset || !r.project || !r.category);
    const root = app.host.settings.libraryRoot;
    m.setButtons([{ label: 'Cancel', kind: 'ghost' },
      { label: on.length ? `Organize ${plural(on.length, 'model')}` : 'Organize', kind: 'primary', icon: 'archive', disabled: !on.length || bad || !root, onClick: () => { start(); return false; } }],
      !root ? 'Choose a library folder first' : bad ? 'Fix the highlighted names first' : footNote());
  }

  // ---- run
  async function start() {
    await checkExisting();
    const todo = rows.filter((r) => r.on);
    if (!todo.length) return;
    stop = 'running';
    onRun?.(true);
    const headline = h('div.batch-head');
    const bar = h('div.bar', h('i'));
    const list = h('div.batch-progress');
    for (const r of todo) {
      r.state = 'queued'; r.report = null; r.error = null;
      const state = h('span.state', ic('clock', 15));
      const sub = h('div.sub.ellipsis', 'Waiting');
      const t = thumbUrl(r.main.path) || (r.main.ext === '.blend' ? blendThumbUrl(r.main.path, r.main.modified) : null);
      const row = h('div.batch-item', state, t ? h('img', { src: t, loading: 'lazy', onerror: (e) => e.target.replaceWith(h('div.noimg')) }) : h('div.noimg'),
        h('div', { style: { minWidth: 0 } }, h('div.t.ellipsis', `${r.project} \\ ${r.category} \\ ${r.asset}`), sub), h('span.muted.small', plural(r.files.filter((f) => r.archive.has(f.path)).length, 'version')));
      r.el = { row, state, sub };
      list.append(row);
    }
    setChildren(body, headline, bar, list);
    hydrateIcons(body);
    m.setTitle(`Organizing ${plural(todo.length, 'model')}`);
    let stopAfter = false;
    m.setButtons([{ label: 'Stop after this model', kind: 'ghost', onClick: () => { stopAfter = true; m.setButtons([{ label: 'Stopping…', kind: 'ghost', disabled: true }]); return false; } }]);
    call('window.busy', { busy: true });
    const setState = (r, s, text) => {
      r.state = s;
      const iconName = { running: 'loader', done: 'check', failed: 'alert', skipped: 'skip-back', stopped: 'x' }[s] || 'clock';
      setChildren(r.el.state, ic(iconName, 15, s === 'running' ? 'spin' : ''));
      r.el.state.className = 'state ' + ({ done: 'ok', failed: 'bad', skipped: 'skip', stopped: 'skip' }[s] || '');
      r.el.row.classList.toggle('running', s === 'running');
      if (text != null) r.el.sub.textContent = text;
      hydrateIcons(r.el.state);
    };
    try {
      for (let i = 0; i < todo.length; i++) {
        const r = todo[i];
        if (stopAfter) { for (const x of todo.slice(i)) setState(x, 'stopped', 'Not started'); break; }
        headline.textContent = `Organizing ${i + 1} of ${todo.length}: ${r.asset}`;
        setState(r, 'running', 'Starting…');
        r.el.row.scrollIntoView({ block: 'nearest' });
        const ui = {
          step: (label) => { r.el.sub.textContent = label; return { set: (t) => { r.el.sub.textContent = t; }, done: () => {} }; },
          progress: (f) => { bar.firstChild.style.width = `${Math.round(((i + Math.min(1, Math.max(0, f))) / todo.length) * 100)}%`; },
        };
        try {
          const rep = await organizeAsset({ ...r, opts: { ...opts } }, ui);
          r.report = rep;
          if (rep.status === 'skipped') setState(r, 'skipped', 'Already in the library: skipped');
          else setState(r, 'done', [plural(rep.versions.length, 'version'), plural(rep.textures.length, 'texture'),
            rep.missing.length ? `${rep.missing.length} missing` : null, rep.savedBytes > 0 ? `${fmtBytes(rep.savedBytes)} saved` : null].filter(Boolean).join(' · '));
        } catch (e) {
          r.error = e.message;
          setState(r, 'failed', e.message);
        }
        ui.progress(1);
      }
    } finally {
      call('window.busy', { busy: false });
      onRun?.(false);
      stop = false;
    }
    finishBatch(todo, headline);
  }

  function finishBatch(todo, headline) {
    const done = todo.filter((r) => r.state === 'done');
    const skipped = todo.filter((r) => r.state === 'skipped');
    const failed = todo.filter((r) => r.state === 'failed');
    const notRun = todo.filter((r) => r.state === 'stopped');
    const summary = [`${plural(done.length, 'model')} organized`, skipped.length ? `${skipped.length} skipped` : null,
      failed.length ? `${failed.length} failed` : null, notRun.length ? `${notRun.length} not started` : null].filter(Boolean).join(' · ');
    m.setTitle(failed.length ? 'Organize finished with problems' : 'Organize finished');
    headline.hidden = true;
    const seen = new Set();
    const originals = done.flatMap((r) => originalsOf(r.report)).filter((f) => { const k = f.path.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
    const size = originals.reduce((s, f) => s + f.size, 0);
    const saved = done.reduce((s, r) => s + (r.report.savedBytes || 0), 0);
    const missing = done.reduce((s, r) => s + (r.report.missing?.length || 0), 0);
    body.prepend(h('div.banner.' + (failed.length ? 'warn' : 'ok'), { style: { marginBottom: '10px' } }, ic(failed.length ? 'alert' : 'check-circle', 16), h('div',
      h('b', summary + '.'),
      h('div.note', [saved > 0 ? `${fmtBytes(saved)} saved by compression` : null, missing ? `${missing} textures were missing in the source files (listed in each asset's result)` : null,
        failed.length ? 'Failed models were not changed in the library; you can retry them.' : null].filter(Boolean).join('. ')),
      h('div.btn-row', { style: { marginTop: '8px' } },
        h('button.btn.small', { onclick: () => call('fs.reveal', { path: app.host.settings.libraryRoot }) }, ic('folder', 14), 'Open library folder'),
        originals.length ? h('button.btn.small.danger', { onclick: async () => {
          const { recycle } = await import('./library.js');
          await recycle(originals, { title: `Recycle the ${plural(originals.length, 'original file')} of the ${plural(done.length, 'organized model')} (${fmtBytes(size)})?` });
        } }, ic('trash', 14), `Recycle originals (${fmtBytes(size)})…`) : null))));
    hydrateIcons(body);
    const buttons = [];
    if (failed.length || notRun.length) buttons.push({ label: `Retry ${plural(failed.length + notRun.length, 'model')}`, kind: 'ghost', onClick: () => {
      for (const r of rows) r.on = failed.includes(r) || notRun.includes(r);
      renderReview();
      return false;
    } });
    buttons.push({ label: 'Done', kind: 'primary', onClick: () => { onDone?.(); } });
    m.setButtons(buttons);
  }
}
