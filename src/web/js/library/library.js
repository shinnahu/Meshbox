// Library: every model in your library folder + scanned project folders, grouped into version families,
// with consistent thumbnails (front view, +Z), filters, a versions drawer and a cleanup page.
import { app, entry, updateEntry, thumbUrl, saveThumbnail, savePrefs, saveIndex, thumbOutdated, on as onApp } from '../app.js';
import { h, ic, $, setChildren, showMenu, toast, confirmDialog, promptDialog, fmtBytes, fmtDate, fmtNum, fmtCm, timeAgo, debounce, modal } from '../dom.js';
import { call, basename, dirname, extname, stem, blendThumbUrl, fileUrl, newJobId, on as onHost } from '../host.js';
import { hydrateIcons } from '../icons.js';
import { fmtClass } from '../ui/stage.js';
import { Viewer } from '../viewer/Viewer.js';
import * as THREE from 'three';
import { openOrganizer, openBatchOrganizer } from './organize.js';

const AUTO_THUMB = new Set(['.fbx', '.glb', '.gltf', '.vrm', '.obj', '.stl', '.ply', '.dae', '.3ds', '.3mf', '.usdz']);
let root, state = { scanned: null, families: [], files: [], scanning: false, view: 'assets', source: 'folders', folder: null, q: '', drawer: null };
const prefs = () => app.prefs.library;

export function initLibrary() {
  root = $('#library');
  state.folder = prefs().folder || null;   // reopen in the folder you were in
  onApp('index', debounce(() => { if (!root.hidden) refreshCards(); }, 300));
}

export async function showLibrary(on = true) {
  root.hidden = !on;
  $('#btnLibrary').classList.toggle('on', on);
  if (!on) { stopQueue(); return; }
  if (!state.scanned) await scan();
  else render();
}
export const isLibraryOpen = () => root && !root.hidden;

function roots() {
  const s = app.host.settings;
  const list = [];
  if (s.libraryRoot) list.push({ path: s.libraryRoot, kind: 'library', depth: 3 });
  for (const r of s.scanRoots || []) if (!list.some((x) => x.path.toLowerCase() === r.toLowerCase())) list.push({ path: r, kind: 'scan', depth: 2 });
  return list;
}

export async function scan() {
  const rs = roots();
  state.scanning = true;
  render();
  if (!rs.length) { state.scanning = false; state.scanned = { models: [], backups: [] }; render(); return; }
  try {
    const res = await call('library.scan', { roots: rs.map((r) => r.path) });
    state.scanned = res;
    build();
  } catch (e) {
    toast('Scan failed: ' + e.message, { kind: 'bad' });
    state.scanned = { models: [], backups: [] };
  }
  state.scanning = false;
  render();
}

// ---------------------------------------------------------------- families
/** "Hero54Applied" → "Hero", "dog3final" → "dog", "smol-hero4" → "smolhero", "Hero@Run" → "hero". */
export function familyKey(name) {
  let s = stem(name).toLowerCase();
  const at = s.indexOf('@');
  if (at > 0) s = s.slice(0, at);
  s = s.replace(/\(.*?\)/g, ' ').trim();
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s.replace(/[\s_\-.]*(v|ver|version)?\d+(\.\d+)*[a-z\s_\-]*$/i, '');
    s = s.replace(/[\s_\-.]+(final|finished|wip|test|old|new|backup|copy|baked|rigged|rig|applied|export|exported|source|src|edit|fix|fixed|latest)$/i, '');
    if (s === before) break;
  }
  s = s.replace(/[^a-z0-9]+/g, '');
  return s || stem(name).toLowerCase();
}

function rootOf(path) {
  const p = path.toLowerCase();
  let best = null;
  for (const r of roots()) if (p.startsWith(r.path.toLowerCase().replace(/\\?$/, '\\')) && (!best || r.path.length > best.path.length)) best = r;
  return best;
}

function assetRootOf(path) {
  const r = rootOf(path);
  if (!r) return { root: null, dir: dirname(path), label: dirname(path) };
  const rel = path.slice(r.path.replace(/\\$/, '').length + 1).split('\\');
  const dirs = rel.slice(0, -1).filter((d) => !/^versions$/i.test(d));
  const take = dirs.slice(0, r.depth);
  const dir = [r.path.replace(/\\$/, ''), ...take].join('\\');
  return { root: r, dir, label: take.length ? take.join(' / ') : basename(r.path) };
}

function build() {
  const files = (state.scanned?.models || []).map((f) => ({ ...f, ext: f.ext.toLowerCase(), mtime: new Date(f.modified).getTime() }));
  state.files = files;
  const fams = new Map();
  for (const f of files) {
    const a = assetRootOf(f.path);
    f.asset = a;
    f.family = familyKey(f.name);
    f.isAnim = f.name.includes('@');
    const k = a.dir.toLowerCase() + '|' + f.family + (f.isAnim ? '|anim' : '');
    if (!fams.has(k)) fams.set(k, { key: k, name: f.family, asset: a, files: [], isAnim: f.isAnim });
    fams.get(k).files.push(f);
  }
  for (const fam of fams.values()) {
    fam.files.sort((x, y) => y.mtime - x.mtime);
    const blends = fam.files.filter((f) => f.ext === '.blend');
    fam.main = blends[0] || fam.files.find((f) => f.ext === '.fbx') || fam.files[0];
    fam.display = fam.isAnim ? `${stem(fam.main.name).split('@')[0]} animations` : prettyName(fam);
    fam.exts = [...new Set(fam.files.map((f) => f.ext))];
    fam.size = fam.files.reduce((s, f) => s + f.size, 0);
    fam.mtime = fam.files[0].mtime;
  }
  state.families = [...fams.values()];
}

function prettyName(fam) {
  // Use the main file's name without trailing version noise, keeping the original casing.
  const s = stem(fam.main.name).replace(/\(.*?\)/g, '').trim();
  const m = s.match(/^(.*?)[\s_\-.]*(v|ver)?\d/i);
  const n = (m && m[1].length >= 2 ? m[1] : s).replace(/[\s_\-.]+$/, '');
  return n || s;
}

// ---------------------------------------------------------------- render
function render() {
  if (!root || root.hidden) return;
  const side = h('aside.lib-side');
  const main = h('section.lib-main');
  setChildren(root, side, main);
  renderSide(side);
  if (state.view === 'cleanup') renderCleanup(main);
  else renderAssets(main);
  hydrateIcons(root);
}

function navBtn(label, iconName, on, onClick, n, extra) {
  return h('button.lib-nav' + (on ? '.on' : ''), { onclick: onClick }, ic(iconName, 16), h('span.name', label), n != null ? h('span.n', fmtNum(n)) : null, extra || null);
}

function renderSide(side) {
  const rs = roots();
  const count = (r) => state.files.filter((f) => f.asset.root?.path === r.path).length;
  const add = (...nodes) => side.append(...nodes.flat().filter(Boolean));
  const go = (source, folder) => () => { state.view = 'assets'; state.source = source; if (folder !== undefined) openFolder(folder, false); render(); };
  const cols = collections();
  add(
    h('h5', 'Browse'),
    navBtn('Folders', 'folder', state.view === 'assets' && state.source === 'folders', go('folders', null), state.files.length),
    navBtn('Recent', 'clock', state.view === 'assets' && state.source === 'recent', go('recent')),
    navBtn('Starred', 'star', state.view === 'assets' && state.source === 'starred', go('starred')),
    h('h5', 'Collections', h('button', { 'data-tip': 'New collection', 'data-tip-pos': 'left', onclick: () => newCollection() }, ic('plus', 15))),
    ...cols.map((c) => {
      const b = navBtn(c.name, 'layers', state.view === 'assets' && state.source === 'col:' + c.id, go('col:' + c.id), collectionItems(c).length);
      b.addEventListener('contextmenu', (e) => { e.preventDefault(); showMenu(e.clientX, e.clientY, [
        { label: 'Rename…', icon: 'pencil', onClick: () => renameCollection(c) },
        { label: 'Delete collection…', icon: 'trash', danger: true, onClick: () => deleteCollection(c) },
      ]); });
      return b;
    }),
    !cols.length ? h('div.note', { style: { padding: '2px 9px 4px' } }, 'Group models your way: right-click a model > Add to collection.') : null,
    h('h5', 'Folders', h('button', { 'data-tip': 'Add a folder to scan', 'data-tip-pos': 'left', onclick: addFolder }, ic('plus', 15))),
    ...rs.map((r) => navBtn(basename(r.path) || r.path, r.kind === 'library' ? 'library' : 'folder',
      state.view === 'assets' && state.source === 'folders' && !!state.folder && under(state.folder, r.path), go('folders', r.path), count(r),
      r.kind === 'scan' ? h('span.x', { 'data-tip': 'Stop scanning this folder', 'data-tip-pos': 'left', onclick: (e) => { e.stopPropagation(); removeFolder(r.path); } }, ic('x', 14)) : null)),
    !rs.length ? h('div.note', { style: { padding: '4px 9px' } }, 'Add the folders where your models live.') : null,
    h('h5', 'Tidy up'),
    navBtn('Cleanup', 'eraser', state.view === 'cleanup', () => { state.view = 'cleanup'; render(); }, state.scanned?.backups?.length || null),
    h('div', { style: { flex: 1 } }),
    h('button.lib-nav', { onclick: () => app.actions.openSettings() }, ic('settings', 16), h('span.name', 'Library settings')),
  );
}

async function addFolder() {
  const dir = await call('dialog.folder', { title: 'Add a folder with 3D models' });
  if (!dir) return;
  const list = [...(app.host.settings.scanRoots || [])];
  if (!list.some((d) => d.toLowerCase() === dir.toLowerCase())) list.push(dir);
  app.host.settings = await call('settings.set', { patch: { scanRoots: list } });
  await scan();
}
async function removeFolder(dir) {
  const list = (app.host.settings.scanRoots || []).filter((d) => d.toLowerCase() !== dir.toLowerCase());
  app.host.settings = await call('settings.set', { patch: { scanRoots: list } });
  if (state.folder && under(state.folder, dir)) openFolder(null, false);
  await scan();
}

/** Items after the type and flag filters: model families, or single files when versions are not grouped. */
function filteredItems() {
  const p = prefs();
  const typeOk = (ext) => p.type === 'all' || (p.type === 'fbx' && ext === '.fbx') || (p.type === 'blend' && ext === '.blend') || (p.type === 'gltf' && ['.glb', '.gltf', '.vrm'].includes(ext)) || (p.type === 'other' && !['.fbx', '.blend', '.glb', '.gltf', '.vrm'].includes(ext));
  const flagOk = (path) => {
    const m = entry(path)?.meta;
    if (p.rigged && !(m?.bones > 0)) return false;
    if (p.animated && !(m?.clips > 0)) return false;
    if (p.issues && !(m && (m.texMissing > 0 || m.unityOk === false || (m.facing && m.facing !== '+Z')))) return false;
    return true;
  };
  if (p.type === 'all' && p.group) return state.families.filter((fam) => flagOk(fam.main.path)).map((fam) => ({ kind: 'family', fam, file: fam.main, mtime: fam.mtime }));
  return state.files.filter((f) => typeOk(f.ext) && flagOk(f.path)).map((f) => ({ kind: 'file', file: f, mtime: f.mtime }));
}
const itemDir = (it) => it.fam ? it.fam.asset.dir : it.file.asset.dir;
const itemPaths = (it) => it.fam ? it.fam.files.map((f) => f.path) : [it.file.path];
/** Is `dir` the folder `parent` or inside it? */
function under(dir, parent) {
  const d = (dir || '').toLowerCase().replace(/\\$/, ''), q = (parent || '').toLowerCase().replace(/\\$/, '');
  return !!q && (d === q || d.startsWith(q + '\\'));
}
function sortItems(items) {
  if (prefs().sort === 'name') return items.sort((a, b) => (a.fam?.display || a.file.name).localeCompare(b.fam?.display || b.file.name));
  return items.sort((a, b) => b.mtime - a.mtime);
}
function matches(it, q) {
  const f = it.file;
  return f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q) || (it.fam && (it.fam.display.toLowerCase().includes(q) || it.fam.files.some((x) => x.name.toLowerCase().includes(q))));
}

/** What the flat views show: search results (inside the open folder), Recent, Starred or a collection. */
function visibleItems() {
  const q = state.q.trim().toLowerCase();
  let items = filteredItems();
  if (state.source === 'starred') items = items.filter((it) => itemPaths(it).some((x) => entry(x)?.starred));
  else if (state.source.startsWith('col:')) items = collectionItems(collection(state.source.slice(4)), items);
  else if (state.source === 'folders' && state.folder) items = items.filter((it) => under(itemDir(it), state.folder));
  if (q) items = items.filter((it) => matches(it, q));
  if (state.source === 'recent') return items.sort((a, b) => b.mtime - a.mtime).slice(0, 60);
  return sortItems(items);
}

// ---------------------------------------------------------------- folders
/** Folder tree of the scanned roots down to each model's asset folder; every node knows how many models it holds. */
function buildTree(items) {
  const nodes = new Map();
  const home = { path: null, name: 'Folders', parent: null, children: [], items: [], total: 0 };
  const node = (path, name, parent) => {
    const k = path.toLowerCase();
    let n = nodes.get(k);
    if (!n) { n = { path, name, parent, children: [], items: [], total: 0 }; nodes.set(k, n); parent.children.push(n); }
    return n;
  };
  for (const r of roots()) node(r.path.replace(/\\$/, ''), basename(r.path) || r.path, home);
  for (const it of items) {
    const r = it.file.asset?.root;
    if (!r) continue;
    const rootPath = r.path.replace(/\\$/, '');
    let cur = nodes.get(rootPath.toLowerCase());
    if (!cur) continue;
    let path = rootPath;
    for (const seg of itemDir(it).slice(rootPath.length).split('\\').filter(Boolean)) { path += '\\' + seg; cur = node(path, seg, cur); }
    cur.items.push(it);
  }
  const total = (n) => (n.total = n.items.length + n.children.reduce((sum, c) => sum + total(c), 0));
  total(home);
  return { home, nodes };
}

function openFolder(path, draw = true) {
  state.folder = path || null;
  prefs().folder = state.folder;
  savePrefs();
  if (!draw) return;
  state.q = '';
  render();
}

/** Backspace in the library: one folder up. */
export function libraryUp() {
  if (!isLibraryOpen() || state.view !== 'assets' || state.source !== 'folders' || !state.folder) return;
  const isRoot = roots().some((r) => r.path.replace(/\\$/, '').toLowerCase() === state.folder.toLowerCase());
  if (isRoot) { if (roots().length > 1) openFolder(null); return; }
  openFolder(dirname(state.folder));
}

const plural = (n, one, many = one + 's') => `${fmtNum(n)} ${n === 1 ? one : many}`;
const thumbOf = (it) => thumbUrl(it.file.path) || (it.file.ext === '.blend' ? blendThumbUrl(it.file.path, it.file.modified) : null);

function folderCard(n) {
  const pics = [];
  const walk = (x) => {
    for (const it of x.items) { if (pics.length >= 4) return; if (thumbUrl(it.file.path)) pics.push(thumbUrl(it.file.path)); }
    for (const c of x.children) { if (pics.length >= 4) return; walk(c); }
  };
  walk(n);
  if (pics.length < 4) {   // .blend previews when there are not enough rendered thumbnails
    const more = (x) => { for (const it of x.items) { if (pics.length >= 4) return; const t = thumbOf(it); if (t && !pics.includes(t)) pics.push(t); } for (const c of x.children) { if (pics.length >= 4) return; more(c); } };
    more(n);
  }
  const subs = n.children.filter((c) => c.total > 0).length;
  return h('button.card.folder', {
    'data-tip': n.path, onclick: () => openFolder(n.path),
    oncontextmenu: (ev) => { ev.preventDefault(); showMenu(ev.clientX, ev.clientY, [
      { label: 'Open', icon: 'folder-open', onClick: () => openFolder(n.path) },
      { label: 'Show in Explorer', icon: 'external', onClick: () => call('fs.reveal', { path: n.path }) },
      '-',
      { label: `Organize the ${plural(n.total, 'model')} in it…`, icon: 'archive', onClick: () => organizeMany(familiesUnder(n), `Organize ${n.name}`) },
    ]); },
  },
  h('div.pic.mosaic' + (pics.length ? '.n' + Math.min(pics.length, 4) : '.empty'),
    ...(pics.length ? pics.slice(0, 4).map((src) => h('img', { src, alt: '', loading: 'lazy', draggable: false, onerror: (e) => e.target.remove() })) : [h('div.ph', ic('folder', 34))]),
    h('div.tl', h('span.fmt-badge.folder', ic('folder', 11), 'Folder'))),
  h('div.meta', h('div.title', n.name), h('div.sub', [subs ? plural(subs, 'folder') : null, plural(n.total, 'model')].filter(Boolean).join(' · '))));
}

function familiesUnder(n) {
  const out = [];
  const walk = (x) => { for (const it of x.items) out.push(it.fam || familyOf(it.file)); x.children.forEach(walk); };
  walk(n);
  return [...new Set(out)];
}

function renderFolderView(scroll) {
  const { home, nodes } = buildTree(filteredItems());
  let cur = state.folder ? nodes.get(state.folder.toLowerCase().replace(/\\$/, '')) : null;
  if (!cur) cur = home.children.length === 1 ? home.children[0] : home;   // one scanned folder: start inside it
  state.folder = cur === home ? null : cur.path;
  const chain = [];
  for (let n = cur; n; n = n.parent) chain.unshift(n);
  if (home.children.length === 1) chain.shift();
  const parent = cur.parent && (cur.parent !== home || home.children.length > 1) ? cur.parent : null;
  const crumbs = h('div.crumbs',
    h('button.icon-btn', { disabled: !parent, 'data-tip': 'Up (Backspace)', 'data-tip-pos': 'bottom', onclick: () => parent && openFolder(parent.path) }, ic('arrow-left', 17)),
    ...chain.flatMap((n, i) => [i ? h('span.sep', ic('chevron-right', 14)) : null, h('button.crumb' + (n === cur ? '.on' : ''), { onclick: () => openFolder(n.path) }, n === home ? 'Folders' : n.name)]),
    h('span.grow'),
    h('span.count', plural(cur.total, 'model')));
  const folders = cur.children.filter((c) => c.total > 0).sort((a, b) => a.name.localeCompare(b.name));
  const items = sortItems([...cur.items]);
  const filtered = prefs().type !== 'all' || prefs().rigged || prefs().animated || prefs().issues;
  setChildren(scroll, crumbs,
    folders.length ? h('div.lib-group', h('div.lib-group-head', h('h4', 'Folders'), h('span.path', `· ${folders.length}`)), h('div.lib-grid', ...folders.map(folderCard))) : null,
    items.length ? h('div.lib-group', h('div.lib-group-head', h('h4', folders.length ? 'Models here' : 'Models'), h('span.path', `· ${items.length}`)), h('div.lib-grid', ...items.map(card))) : null,
    !folders.length && !items.length ? h('div.lib-empty', h('h3', 'Nothing here'), h('p', filtered ? 'No model in this folder matches the filters.' : 'This folder has no models.')) : null);
  hydrateIcons(scroll);
  observeCards(scroll);
}

// ---------------------------------------------------------------- collections (kept in the library index)
function collections() { return (app.index.collections ||= []); }
function collection(id) { return collections().find((c) => c.id === id) || null; }
/** The items of a collection: every model (or file) one of whose files was added to it. */
function collectionItems(c, items = filteredItems()) {
  if (!c) return [];
  const set = new Set(c.paths.map((x) => x.toLowerCase()));
  return items.filter((it) => itemPaths(it).some((x) => set.has(x.toLowerCase())));
}
const inCollection = (c, it) => { const set = new Set(c.paths.map((x) => x.toLowerCase())); return itemPaths(it).some((x) => set.has(x.toLowerCase())); };
function toggleInCollection(c, it) {
  if (inCollection(c, it)) {
    const drop = new Set(itemPaths(it).map((x) => x.toLowerCase()));
    c.paths = c.paths.filter((x) => !drop.has(x.toLowerCase()));
    toast(`Removed from ${c.name}`);
  } else {
    c.paths.push(it.file.path);
    toast(`Added to ${c.name}`, { kind: 'ok' });
  }
  saveIndex();
  render();
}
async function newCollection(firstItem) {
  const name = (await promptDialog({ title: 'New collection', label: 'Name', placeholder: 'e.g. Characters for the demo', confirmLabel: 'Create' }))?.trim();
  if (!name) return null;
  const c = { id: Date.now().toString(36), name, paths: firstItem ? [firstItem.file.path] : [] };
  collections().push(c);
  saveIndex();
  if (firstItem) toast(`Added to ${c.name}`, { kind: 'ok' });
  render();
  return c;
}
async function renameCollection(c) {
  const name = (await promptDialog({ title: 'Rename collection', label: 'Name', value: c.name, confirmLabel: 'Rename' }))?.trim();
  if (!name) return;
  c.name = name;
  saveIndex();
  render();
}
async function deleteCollection(c) {
  if (!(await confirmDialog({ title: `Delete the collection “${c.name}”?`, message: 'Only the collection goes away: the models stay where they are.', confirmLabel: 'Delete collection', danger: true }))) return;
  app.index.collections = collections().filter((x) => x !== c);
  if (state.source === 'col:' + c.id) state.source = 'folders';
  saveIndex();
  render();
}
function collectionMenu(ev, it) {
  showMenu(ev.clientX, ev.clientY, [
    { header: 'Add to collection' },
    ...collections().map((c) => ({ label: c.name, icon: 'layers', checked: inCollection(c, it), onClick: () => toggleInCollection(c, it) })),
    collections().length ? '-' : null,
    { label: 'New collection…', icon: 'plus', onClick: () => newCollection(it) },
  ].filter(Boolean));
}

function renderAssets(main) {
  const p = prefs();
  const where = state.source === 'folders' && state.folder ? ` in ${basename(state.folder)}` : '';
  const search = h('input.input', { placeholder: `Search models${where}…`, value: state.q, oninput: debounce((e) => { state.q = e.target.value; renderGridOnly(); }, 150) });
  const typeSeg = h('div.seg', ...[['all', 'All'], ['fbx', 'FBX'], ['blend', 'Blender'], ['gltf', 'glTF'], ['other', 'Other']].map(([v, l]) =>
    h('button' + (p.type === v ? '.on' : ''), { onclick: () => { p.type = v; savePrefs(); render(); } }, l)));
  const flag = (key, label, iconName, tip) => h('button.chip' + (p[key] ? '.accent' : ''), { 'data-tip': tip, 'data-tip-pos': 'bottom', onclick: () => { p[key] = !p[key]; savePrefs(); render(); } }, ic(iconName, 13), label);
  const toolbar = h('div.lib-toolbar',
    h('div.search', ic('search', 16), search), typeSeg,
    flag('rigged', 'Rigged', 'bone', 'Has a skeleton (known after a thumbnail is made)'),
    flag('animated', 'Animated', 'film', 'Has animation clips'),
    flag('issues', 'Needs work', 'alert', 'Missing textures, not facing +Z, or wrong Unity scale'),
    h('span.grow'),
    h('button.btn.small', { 'data-tip': 'Organize several models at once: the ones in this view (filters and search apply). You review every destination first.', 'data-tip-pos': 'bottom', onclick: () => organizeMany(familiesInView()) }, ic('archive', 15), 'Organize…'),
    p.type === 'all' ? h('button.chip' + (p.group ? '.accent' : ''), { 'data-tip': 'One card per model, with its versions inside', 'data-tip-pos': 'bottom', onclick: () => { p.group = !p.group; savePrefs(); render(); } }, ic('git-branch', 13), 'Group versions') : null,
    h('button.icon-btn', { 'data-tip': p.sort === 'name' ? 'Sorted by name' : 'Sorted by date', 'data-tip-pos': 'bottom', onclick: () => { p.sort = p.sort === 'name' ? 'date' : 'name'; savePrefs(); render(); } }, ic(p.sort === 'name' ? 'list' : 'clock', 18)),
    h('input.range', { type: 'range', min: 120, max: 300, step: 4, value: p.cardSize, style: { width: '90px' }, 'data-tip': 'Card size', oninput: (e) => { p.cardSize = +e.target.value; root.querySelector('.lib-scroll')?.style.setProperty('--card-w', p.cardSize + 'px'); savePrefs(); } }),
    h('button.icon-btn', { 'data-tip': 'Rescan folders', 'data-tip-pos': 'bottom-end', onclick: () => scan() }, ic('refresh', 18)),
    h('button.icon-btn', { 'data-tip': 'Back to the viewer (Esc)', 'data-tip-pos': 'bottom-end', onclick: () => app.actions.showLibrary(false) }, ic('x', 18)),
  );
  main.append(toolbar, h('div.lib-status#libStatus'), h('div.lib-scroll', { style: { '--card-w': p.cardSize + 'px' } }));
  renderGridOnly();
  updateStatus();
  setTimeout(() => search.focus(), 30);
}

function renderGridOnly() {
  const scroll = root.querySelector('.lib-scroll');
  if (!scroll) return;
  scroll.style.setProperty('--card-w', prefs().cardSize + 'px');
  if (state.scanning && !state.files.length) { setChildren(scroll, h('div.lib-empty', ic('loader', 28), h('div', 'Scanning folders…'))); return; }
  if (!roots().length) {
    setChildren(scroll, h('div.lib-empty', h('div.big', ic('library', 34)), h('h3', 'Set up your library'),
      h('p', { style: { maxWidth: '560px' } }, 'Add the folders where your models live (they are only read). Optionally choose a library folder: “Organize” copies a model there in one standard layout, ',
        h('b', 'Project \\ Category \\ Asset'), ', with one .blend, one Unity FBX, a Textures folder and a Versions folder for older .blend files.'),
      h('div.btn-row', h('button.btn.primary', { onclick: addFolder }, ic('plus', 16), 'Add a models folder…'),
        h('button.btn', { onclick: () => app.actions.openSettings() }, ic('settings', 16), 'Choose library folder…'))));
    hydrateIcons(scroll);
    return;
  }
  if (state.source === 'folders' && !state.q.trim()) { renderFolderView(scroll); return; }
  const items = visibleItems();
  const colEmpty = state.source.startsWith('col:') && !state.q.trim();
  if (!items.length) { setChildren(scroll, h('div.lib-empty', h('h3', 'Nothing here'), h('p', state.q ? 'No model matches your search.' : colEmpty ? 'Right-click a model > Add to collection to put it here.' : 'No models in this view.'))); return; }
  // Group by asset folder
  const groups = new Map();
  for (const it of items) {
    const label = state.source === 'recent' ? 'Recently changed' : it.file.asset.label;
    if (!groups.has(label)) groups.set(label, { label, root: it.file.asset.root, items: [] });
    groups.get(label).items.push(it);
  }
  const frag = document.createDocumentFragment();
  for (const g of groups.values()) {
    frag.append(h('div.lib-group',
      h('div.lib-group-head', h('h4', g.label), g.root && state.source !== 'recent' ? h('span.path', basename(g.root.path)) : null, h('span.path', `· ${g.items.length}`)),
      h('div.lib-grid', ...g.items.map(card))));
  }
  setChildren(scroll, frag);
  hydrateIcons(scroll);
  observeCards(scroll);
}

function refreshCards() {
  // Cheap refresh of thumbnails and badges after the index changes.
  const scroll = root?.querySelector('.lib-scroll');
  if (!scroll) return;
  const y = scroll.scrollTop;
  renderGridOnly();
  scroll.scrollTop = y;
}

function card(it) {
  const f = it.file;
  const fam = it.fam;
  const e = entry(f.path);
  const m = e?.meta;
  const t = thumbUrl(f.path);
  const blendFallback = !t && f.ext === '.blend';
  const pic = h('div.pic',
    t ? h('img', { src: t, alt: '', loading: 'lazy', draggable: false })
      : blendFallback ? h('img.blendthumb', { src: blendThumbUrl(f.path, f.modified), alt: '', loading: 'lazy', draggable: false, onerror: (ev) => ev.target.remove() })
        : h('div.ph', ic('box', 30)),
    h('div.tl', ...(fam ? fam.exts : [f.ext]).slice(0, 3).map((x) => h('span.fmt-badge.' + fmtClass(x), x.slice(1).toUpperCase()))),
    h('div.tr', e?.starred ? h('span.badge.accent', ic('star', 11)) : null),
    h('div.bl',
      m?.bones ? h('span.badge' + (m.humanoid ? '.ok' : ''), { 'data-tip': m.humanoid ? 'Humanoid rig' : `${m.bones} bones` }, ic(m.humanoid ? 'person' : 'bone', 11)) : null,
      m?.clips ? h('span.badge', ic('film', 11), String(m.clips)) : null,
      m?.texMissing ? h('span.badge.bad', { 'data-tip': `${m.texMissing} missing textures` }, ic('unlink', 11), String(m.texMissing)) : null,
      m && m.facing && m.facing !== '+Z' ? h('span.badge.warn', { 'data-tip': `Faces ${m.facing}` }, ic('compass', 11)) : null,
      fam && fam.files.length > 1 ? h('span.badge.accent', { 'data-tip': 'Versions - click to see them', onclick: (ev) => { ev.stopPropagation(); openDrawer(fam); } }, ic('git-branch', 11), String(fam.files.length)) : null),
    !t && AUTO_THUMB.has(f.ext) ? h('span.gen', { 'data-tip': 'Thumbnail on its way' }, ic('loader', 14, 'spin')) : null,
    h('div.br',
      h('span.badge', { 'data-tip': 'Organize into the library: one .blend, one Unity FBX, standard texture names', onclick: (ev) => { ev.stopPropagation(); organize(fam || familyOf(f)); } }, ic('archive', 12), 'Organize'),
      h('span.badge', { 'data-tip': 'More (or right-click)', onclick: (ev) => { ev.stopPropagation(); cardMenu(ev, it); } }, ic('more', 13))),
  );
  const sub = fam ? `${fam.files.length > 1 ? `${fam.files.length} files · ` : ''}${timeAgo(fam.mtime)}` : `${fmtBytes(f.size)} · ${timeAgo(f.mtime)}`;
  const el = h('button.card', {
    'data-path': f.path, 'data-tip': f.path,
    onclick: () => app.actions.open(f.path),
    oncontextmenu: (ev) => { ev.preventDefault(); cardMenu(ev, it); },
  }, pic, h('div.meta', h('div.title', fam ? fam.display : f.name), h('div.sub', sub)));
  // no thumbnail yet, or one drawn before the viewer's last material fixes (the old one shows meanwhile)
  el.dataset.thumbless = (!t || thumbOutdated(f.path)) && AUTO_THUMB.has(f.ext) ? '1' : '';
  return el;
}

function cardMenu(ev, it) {
  const f = it.file;
  const fam = it.fam;
  const e = entry(f.path);
  const isCurrent = app.viewer.info?.sourcePath?.toLowerCase() === f.path.toLowerCase();
  showMenu(ev.clientX, ev.clientY, [
    { label: 'Open', icon: 'folder-open', onClick: () => app.actions.open(f.path) },
    { label: 'Open in new window', icon: 'app-window', onClick: () => call('app.openWindow', { path: f.path }) },
    f.ext === '.blend' ? { label: 'Open in Blender', icon: 'blender', onClick: () => call('fs.openInBlender', { path: f.path }) } : null,
    { label: 'Show in Explorer', icon: 'external', onClick: () => call('fs.reveal', { path: f.path }) },
    '-',
    { label: 'Update thumbnail', icon: 'refresh', hint: 'front view', onClick: () => regenerateThumb(f) },
    isCurrent ? { label: 'Use current view as thumbnail', icon: 'camera', onClick: () => app.actions.thumbFromView() } : null,
    { label: e?.starred ? 'Unstar' : 'Star', icon: 'star', onClick: () => updateEntry(f.path, { starred: !e?.starred }) },
    { label: 'Add to collection…', icon: 'layers', onClick: () => collectionMenu(ev, it) },
    state.source.startsWith('col:') && collection(state.source.slice(4)) ? { label: `Remove from ${collection(state.source.slice(4)).name}`, icon: 'x', onClick: () => toggleInCollection(collection(state.source.slice(4)), it) } : null,
    '-',
    fam && fam.files.length > 1 ? { label: `Versions (${fam.files.length})…`, icon: 'git-branch', onClick: () => openDrawer(fam) } : null,
    { label: 'Organize into library…', icon: 'archive', onClick: () => organize(fam || familyOf(f)) },
    '-',
    { label: 'Move to Recycle Bin…', icon: 'trash', danger: true, onClick: () => recycle([f]) },
  ].filter(Boolean));
}

/** How many models share this model's folder (a model alone in its folder is named after the folder). */
function siblingCount(fam) {
  const dir = fam.asset?.dir?.toLowerCase();
  return state.families.filter((x) => !x.isAnim && x.asset.dir.toLowerCase() === dir).length || 1;
}
function organize(fam) { return openOrganizer(fam, { siblings: siblingCount(fam) }); }

/** Organize several models in one go (the ones shown in the library, or a Cleanup list). */
export function organizeMany(fams, title) {
  const list = [...new Set(fams)].filter((f) => !f.isAnim);
  if (!list.length) { toast('No models to organize in this view.'); return; }
  openBatchOrganizer(list, {
    title, siblings: siblingCount,
    onRun: (on) => { paused = on; if (!on) pump(); },
    onDone: () => scan(),
  });
}

function familiesInView() {
  return [...new Set(visibleItems().map((it) => it.fam || familyOf(it.file)))].filter((f) => !f.isAnim);
}

function familyOf(f) {
  return state.families.find((fam) => fam.files.includes(f)) || { name: familyKey(f.name), display: stem(f.name), files: [f], main: f, asset: f.asset || assetRootOf(f.path), exts: [f.ext] };
}

/** Organize the model at `path` together with its other versions (the viewer's Organize button). */
export async function organizeFile(path) {
  if (!state.scanned) await scan();
  const lower = path.toLowerCase();
  let fam = state.families.find((x) => !x.isAnim && x.files.some((f) => f.path.toLowerCase() === lower));
  if (!fam) {
    // Not in a scanned folder: this file plus its versions next to it (Hero1, Hero2...).
    const key = familyKey(basename(path));
    const sibs = await call('fs.list', { dir: dirname(path), exts: ['.blend', '.fbx', '.glb', '.gltf', '.obj', '.vrm'] }).catch(() => []);
    const list = sibs.filter((f) => familyKey(f.name) === key && !f.name.includes('@'));
    if (!list.some((f) => f.path.toLowerCase() === lower)) {
      const st = await call('fs.stat', { path });
      list.push({ path, name: basename(path), size: st.size, modified: st.modified });
    }
    const asset = assetRootOf(path);
    const files = list.map((f) => ({ ...f, ext: extname(f.name).toLowerCase(), mtime: new Date(f.modified).getTime(), asset })).sort((a, b) => b.mtime - a.mtime);
    const opened = files.find((f) => f.path.toLowerCase() === lower);
    fam = { key: asset.dir.toLowerCase() + '|' + key, name: key, asset, files, main: files.find((f) => f.ext === '.blend') || opened || files[0],
      exts: [...new Set(files.map((f) => f.ext))], size: files.reduce((s, f) => s + f.size, 0), mtime: files[0].mtime };
    fam.display = prettyName(fam);
  }
  return openOrganizer(fam, { siblings: siblingCount(fam) });
}

export async function recycle(files, { title } = {}) {
  const total = files.reduce((s, f) => s + (f.size || 0), 0);
  const ok = await confirmDialog({
    title: title || (files.length === 1 ? `Move ${files[0].name} to the Recycle Bin?` : `Move ${files.length} files to the Recycle Bin?`),
    message: `${fmtBytes(total)} will be freed when you empty the Recycle Bin. You can restore them from there until then.`,
    details: files.length > 1 ? h('div.file-list', ...files.slice(0, 200).map((f) => h('div.list-item', ic(f.ext === '.blend' ? 'blender' : 'file', 14), h('span.name.sel', f.path), h('span.meta', fmtBytes(f.size))))) : h('div.path-preview', files[0].path),
    confirmLabel: 'Move to Recycle Bin', danger: true,
  });
  if (!ok) return null;
  const res = await call('fs.recycle', { paths: files.map((f) => f.path) });
  if (res.failed?.length) toast(`${res.failed.length} could not be moved: ${res.failed[0].error}`, { kind: 'bad' });
  if (res.ok?.length) toast(`Moved ${res.ok.length} file${res.ok.length > 1 ? 's' : ''} to the Recycle Bin (${fmtBytes(res.freedBytes)})`, { kind: 'ok' });
  const gone = new Set((res.ok || []).map((p) => p.toLowerCase()));
  if (state.scanned) {
    state.scanned.models = state.scanned.models.filter((f) => !gone.has(f.path.toLowerCase()));
    state.scanned.backups = state.scanned.backups.filter((f) => !gone.has(f.path.toLowerCase()));
    build();
    if (state.drawer) state.drawer = state.families.find((x) => x.key === state.drawer.key) || null;
    render();
    if (state.drawer) openDrawer(state.drawer);
  }
  return res;
}

// ---------------------------------------------------------------- versions drawer
function openDrawer(fam) {
  state.drawer = fam;
  root.querySelector('.versions-drawer')?.remove();
  const selected = new Set();
  const body = h('div.body');
  const recycleBtn = h('button.btn.small.danger', { disabled: true, onclick: () => recycle(fam.files.filter((f) => selected.has(f.path))) }, ic('trash', 14), 'Recycle selected');
  const drawer = h('div.versions-drawer',
    h('div.head', ic('git-branch', 18), h('h3', `${fam.display} - ${fam.files.length} files`), h('button.icon-btn', { onclick: () => { drawer.remove(); state.drawer = null; } }, ic('x', 18))),
    h('div', { style: { padding: '0 16px 10px' } },
      h('div.note', `${fam.asset.label} · ${fmtBytes(fam.size)} in total`),
      h('div.btn-row', { style: { marginTop: '8px' } },
        h('button.btn.small.primary', { onclick: () => organize(fam) }, ic('archive', 14), 'Organize into library…'),
        recycleBtn)),
    body);
  const update = () => { recycleBtn.disabled = !selected.size; recycleBtn.lastChild.textContent = selected.size ? `Recycle ${selected.size}` : 'Recycle selected'; };
  for (const f of fam.files) {
    const t = thumbUrl(f.path) || (f.ext === '.blend' ? blendThumbUrl(f.path, f.modified) : null);
    const cb = h('input', { type: 'checkbox', onchange: () => { cb.checked ? selected.add(f.path) : selected.delete(f.path); update(); } });
    body.append(h('div.ver',
      cb,
      t ? h('img', { src: t, loading: 'lazy', onerror: (e) => e.target.replaceWith(h('div.noimg')) }) : h('div.noimg'),
      h('div', { style: { minWidth: 0 } },
        h('div.t', { 'data-tip': f.path }, f.name, f === fam.main ? h('span.chip.accent', { style: { marginLeft: '6px', height: '18px' } }, 'latest') : null),
        h('div.s', `${fmtDate(f.mtime)} · ${fmtBytes(f.size)} · ${f.path.slice(fam.asset.dir.length + 1, -f.name.length) || './'}`),
        h('div.acts',
          h('button.btn.small', { onclick: () => app.actions.open(f.path) }, 'Open'),
          h('button.btn.small.ghost', { onclick: () => call('app.openWindow', { path: f.path }) }, 'Compare'),
          h('button.btn.small.ghost', { onclick: () => call('fs.reveal', { path: f.path }) }, ic('folder', 14))))));
  }
  root.querySelector('.lib-main').append(drawer);
  hydrateIcons(drawer);
}

// ---------------------------------------------------------------- cleanup
function renderCleanup(main) {
  const backups = state.scanned?.backups || [];
  const byDir = new Map();
  for (const b of backups) {
    const d = dirname(b.path);
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d).push(b);
  }
  const total = backups.reduce((s, b) => s + b.size, 0);
  const famsWithVersions = state.families.filter((f) => !f.isAnim && f.files.filter((x) => x.ext === '.blend').length > 2)
    .sort((a, b) => b.files.filter((x) => x.ext === '.blend').length - a.files.filter((x) => x.ext === '.blend').length);
  const scroll = h('div.lib-scroll', { style: { paddingTop: '6px' } },
    h('h3', { style: { color: 'var(--strong)', margin: '6px 0 4px' } }, 'Cleanup'),
    h('p.note', 'Everything here goes to the Recycle Bin, never deleted outright, and nothing moves without your confirmation.'),

    h('div.section', h('div.section-label', ic('history', 14), `Blender auto-backups (.blend1, .blend2…)`, h('span.count', `${backups.length} files · ${fmtBytes(total)}`)),
      backups.length ? h('div.banner.info', ic('info', 16), h('div', 'Blender writes these each time you save (the previous save). They are safe to remove once the .blend opens fine. ',
        h('b', 'Tip: '), 'Blender → Preferences → Save & Load → Save Versions = 0 or 1 stops them piling up.',
        h('div', h('button.btn.small.danger', { style: { marginTop: '8px' }, onclick: () => recycle(backups.map((b) => ({ ...b, ext: b.ext })), { title: `Move ${backups.length} Blender backups (${fmtBytes(total)}) to the Recycle Bin?` }) }, ic('trash', 14), `Recycle all ${backups.length} (${fmtBytes(total)})`))))
        : h('div.note', 'No .blend1 backups in the scanned folders.'),
      backups.length ? h('table.cleanup-table', { style: { marginTop: '10px' } },
        h('thead', h('tr', h('th', 'Folder'), h('th', 'Files'), h('th', 'Size'), h('th', ''))),
        h('tbody', ...[...byDir.entries()].sort((a, b) => b[1].reduce((s, x) => s + x.size, 0) - a[1].reduce((s, x) => s + x.size, 0)).map(([d, list]) =>
          h('tr', h('td.sel', d), h('td.num', String(list.length)), h('td.num', fmtBytes(list.reduce((s, x) => s + x.size, 0))),
            h('td.num', h('button.btn.small.ghost', { onclick: () => recycle(list) }, ic('trash', 14))))))) : null),

    h('div.section', h('div.section-label', ic('git-branch', 14), 'Models with many .blend versions',
        famsWithVersions.length ? h('button.btn.small', { style: { marginLeft: 'auto', textTransform: 'none', letterSpacing: '0' }, onclick: () => organizeMany(famsWithVersions, `Organize ${famsWithVersions.length} models with many versions`) }, ic('archive', 14), `Organize all ${famsWithVersions.length}…`) : null),
      h('div.note', { style: { marginBottom: '8px' } }, 'Best move: “Organize” keeps one working .blend plus every old version compressed in a Versions folder, so you can still go back to old weights or a missing mesh. Or keep only the newest few here.'),
      famsWithVersions.length ? h('table.cleanup-table',
        h('thead', h('tr', h('th', 'Model'), h('th', 'Folder'), h('th', '.blend files'), h('th', 'Size'), h('th', ''))),
        h('tbody', ...famsWithVersions.slice(0, 80).map((fam) => {
          const blends = fam.files.filter((x) => x.ext === '.blend');
          return h('tr', h('td', h('b', fam.display)), h('td.sel', fam.asset.label), h('td.num', String(blends.length)), h('td.num', fmtBytes(blends.reduce((s, x) => s + x.size, 0))),
            h('td.num', h('div.btn-row.end',
              h('button.btn.small', { onclick: () => openDrawer(fam) }, 'Review'),
              h('button.btn.small', { onclick: () => organize(fam) }, ic('archive', 14), 'Organize'),
              h('button.btn.small.ghost', { 'data-tip': 'Recycle all but the 3 newest .blend files', onclick: () => recycle(blends.slice(3), { title: `Keep the 3 newest ${fam.display} .blend files and recycle ${blends.length - 3}?` }) }, 'Keep 3 newest'))));
        }))) : h('div.note', 'No model with more than two .blend versions.')),

    h('div.section', h('div.section-label', ic('copy', 14), 'Exact duplicates'),
      h('div.note', { style: { marginBottom: '8px' } }, 'Finds byte-identical copies of the same model (same size, then same SHA-256).'),
      h('div#dupes', h('button.btn.small', { onclick: findDuplicates }, ic('search', 14), 'Find duplicates'))),
  );
  main.append(h('div.lib-toolbar', h('h4', { style: { margin: 0, color: 'var(--strong)' } }, 'Tidy up'), h('span.grow'),
    h('button.icon-btn', { 'data-tip': 'Rescan', 'data-tip-pos': 'bottom-end', onclick: () => scan() }, ic('refresh', 18)),
    h('button.icon-btn', { 'data-tip': 'Back to the viewer', 'data-tip-pos': 'bottom-end', onclick: () => app.actions.showLibrary(false) }, ic('x', 18))), scroll);
}

async function findDuplicates() {
  const box = root.querySelector('#dupes');
  const bySize = new Map();
  for (const f of state.files) { if (f.size < 1024) continue; const k = f.size + f.ext; if (!bySize.has(k)) bySize.set(k, []); bySize.get(k).push(f); }
  const candidates = [...bySize.values()].filter((l) => l.length > 1);
  const n = candidates.reduce((s, l) => s + l.length, 0);
  setChildren(box, h('div.note', `Hashing ${n} files with matching sizes…`));
  const groups = [];
  let done = 0;
  for (const list of candidates) {
    const byHash = new Map();
    for (const f of list) {
      try { const hsh = await call('fs.hash', { path: f.path }); if (!byHash.has(hsh)) byHash.set(hsh, []); byHash.get(hsh).push(f); } catch { /* unreadable */ }
      done++;
      if (done % 5 === 0) setChildren(box, h('div.note', `Hashing… ${done} / ${n}`));
    }
    for (const g of byHash.values()) if (g.length > 1) groups.push(g.sort((a, b) => a.mtime - b.mtime));
  }
  if (!groups.length) { setChildren(box, h('div.note', 'No exact duplicates found.')); return; }
  const extra = groups.flatMap((g) => g.slice(1));
  setChildren(box,
    h('div.banner.warn', ic('copy', 16), h('div', `${groups.length} sets of identical files - ${fmtBytes(extra.reduce((s, f) => s + f.size, 0))} in extra copies.`,
      h('div', h('button.btn.small.danger', { style: { marginTop: '8px' }, onclick: () => recycle(extra, { title: `Recycle ${extra.length} duplicate copies (keeping the oldest of each)?` }) }, ic('trash', 14), 'Recycle extra copies')))),
    h('table.cleanup-table', { style: { marginTop: '8px' } }, h('tbody', ...groups.flatMap((g) => g.map((f, i) =>
      h('tr', h('td', i === 0 ? h('span.chip.ok', 'keep') : h('span.chip.warn', 'copy')), h('td.sel', f.path), h('td.num', fmtBytes(f.size))))))));
  hydrateIcons(box);
}

// ---------------------------------------------------------------- thumbnails in the background
let queue = [], running = false, observer = null, tv = null, paused = false;

function observeCards(scroll) {
  observer?.disconnect();
  observer = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const path = en.target.dataset.path;
      if (en.target.dataset.thumbless === '1' && !queue.includes(path)) queue.push(path);
      observer.unobserve(en.target);
    }
    pump();
  }, { root: scroll, rootMargin: '300px' });
  scroll.querySelectorAll('.card[data-thumbless="1"]').forEach((c) => observer.observe(c));
}

function stopQueue() { queue = []; observer?.disconnect(); }

function updateStatus(text) {
  const el = root?.querySelector('#libStatus');
  if (!el) return;
  const s = state.scanned;
  const blendsWithout = state.files.filter((f) => f.ext === '.blend' && !entry(f.path)?.thumb).length;
  setChildren(el,
    h('span', s ? `${fmtNum(state.files.length)} models · ${fmtNum(state.families.length)} families` : ''),
    text ? h('span', ic('loader', 13, 'spin'), ' ', text) : null,
    text ? h('button.link', { onclick: () => { paused = !paused; if (!paused) pump(); updateStatus(paused ? 'Thumbnails paused' : text); } }, paused ? 'resume' : 'pause') : null,
    !text && blendsWithout ? h('button.link', { 'data-tip': 'Converts each .blend with Blender in the background (also makes opening them instant later)', onclick: () => {
      queue.push(...state.files.filter((f) => f.ext === '.blend' && !entry(f.path)?.thumb).map((f) => f.path));
      pump();
    } }, `Make thumbnails for ${blendsWithout} .blend files (uses Blender)`) : null);
  hydrateIcons(el);
}

function thumbViewer() {
  if (tv) return tv;
  const canvas = h('canvas');
  const wrap = h('div', { style: { position: 'fixed', left: '-10000px', top: '0', width: '384px', height: '384px', pointerEvents: 'none' } }, canvas, h('div.gizmo'));
  document.body.append(wrap);
  tv = new Viewer(canvas, wrap, { grid: false, gizmo: false, stats: false, dims: false, env: 'studio', viewMode: 'textured', wireframe: false, background: 'gradient', thumbAngle: app.viewer.settings.thumbAngle });
  return tv;
}

async function pump() {
  if (running || paused) return;
  running = true;
  try {
    while (queue.length && !paused && !root.hidden) {
      const path = queue.shift();
      const f = state.files.find((x) => x.path === path);
      if (!f || (entry(path)?.thumb && entry(path)?.thumbFor === f.modified && !thumbOutdated(path))) continue;
      updateStatus(`Thumbnail: ${f.name} (${queue.length} left)`);
      try { await makeThumb(f); } catch (e) { console.warn('thumb failed', path, e); updateEntry(path, { thumbError: String(e.message || e) }); }
      await new Promise((r) => setTimeout(r, 30));
    }
  } finally {
    running = false;
    updateStatus();
  }
}

let thumbLock = Promise.resolve();
export function makeThumb(f, opts) {
  const run = thumbLock.then(() => makeThumbNow(f, opts));
  thumbLock = run.catch(() => {});
  return run;
}

async function makeThumbNow(f, { viewer } = {}) {
  const v = viewer || thumbViewer();
  v.settings.thumbAngle = app.viewer.settings.thumbAngle;
  let loadPath = f.path, meta = { sourcePath: f.path };
  if (f.ext === '.blend') {
    const jobId = newJobId();
    const res = await call('blender.preview', { path: f.path, jobId });
    loadPath = res.glb;
    meta = { sourcePath: f.path, kind: 'blend', blendInfo: res.info };
  }
  const info = await v.open(loadPath, meta);
  const e = entry(f.path);
  if (e?.fix?.q) v.setFix({ quaternion: new THREE.Quaternion().fromArray(e.fix.q), scale: e.fix.scale || 1 });
  const blob = await v.thumbnail({ size: 384 });
  await saveThumbnail(f.path, blob, { modelStamp: f.modified });
  updateEntry(f.path, { meta: metaFromInfo(info, v) });
  v.clear();
}

export function metaFromInfo(info, v = app.viewer) {
  const st = info.stats;
  const imgs = info.blendInfo?.images?.filter((i) => i.usedByMaterials !== false && i.source === 'FILE');
  const tex = imgs
    ? imgs.map((i) => ({ status: i.packed ? 'embedded' : i.exists ? 'found' : 'missing' }))
    : info.textures || [];
  return {
    format: info.format, faces: info.blendInfo?.totals?.faces ?? st.polygons, tris: st.triangles, verts: info.blendInfo?.totals?.vertices ?? st.vertices,
    bones: st.boneCount, humanoid: !!info.human?.isHumanoid, clips: st.animations, morphs: st.morphCount,
    texEmbedded: tex.filter((t) => t.status === 'embedded').length, texLinked: tex.filter((t) => t.status === 'found').length,
    texSubstituted: tex.filter((t) => t.status === 'substituted').length, texMissing: tex.filter((t) => t.status === 'missing').length,
    dimsCm: info.dims ? [info.dims.x * 100, info.dims.y * 100, info.dims.z * 100].map((x) => +x.toFixed(2)) : null,
    facing: info.facing ? (v.fix.quaternion.w < 0.99999 ? '+Z' : info.facing.faces) : null,
    unityOk: !!(info.unity?.scaleOk && info.unity?.rotationOk), at: new Date().toISOString(),
  };
}

async function regenerateThumb(f) {
  if (app.viewer.info?.sourcePath?.toLowerCase() === f.path.toLowerCase()) {
    const blob = await app.viewer.thumbnail({ size: 384 });
    await saveThumbnail(f.path, blob, { modelStamp: f.modified });
    toast('Thumbnail updated', { kind: 'ok' });
    return;
  }
  const close = toast(`Updating thumbnail for ${f.name}…`, { timeout: 120000 });
  try { await makeThumb(f); close(); toast('Thumbnail updated', { kind: 'ok' }); }
  catch (e) { close(); toast(e.message, { kind: 'bad' }); }
}

export { state as libraryState, build as rebuildLibrary };
