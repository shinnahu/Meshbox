// Shared app state, preferences and the library index (thumbnails, per-model facing/scale fixes).
import { call, fileUrl } from './host.js';
import { debounce, store } from './dom.js';

export const app = {
  host: null,          // result of app.init
  viewer: null,
  current: null,       // { path, ext, kind, info, header }
  index: { version: 1, files: {} },
  bus: new EventTarget(),
  actions: {},         // filled in by main.js: open, openDialog, ...
  prefs: {
    panel: null,                // 'info' | 'anim' | 'export' | null
    screenshot: { scale: 2, background: 'transparent', grid: false, ask: false },
    export: { textures: 'folder', animations: 'all', pbrManifest: true, packUnityMaskMaps: false, applyModifiers: true, dest: 'beside' },
    library: { view: 'all', type: 'all', group: true, cardSize: 176, sort: 'date', source: 'all' },
    ...(store('prefs') || {}),
  },
};

export function emit(name, detail) { app.bus.dispatchEvent(new CustomEvent(name, { detail })); }
export function on(name, fn) { const h = (e) => fn(e.detail); app.bus.addEventListener(name, h); return () => app.bus.removeEventListener(name, h); }

export const savePrefs = debounce(() => store('prefs', app.prefs), 250);

// ---------------------------------------------------------------- library index
const key = (p) => (p || '').toLowerCase();

export async function loadIndex() {
  try {
    const idx = await call('library.readIndex');
    if (idx && typeof idx === 'object' && idx.files) app.index = idx;
  } catch { /* first run */ }
  return app.index;
}

const flush = debounce(() => call('library.writeIndex', { index: app.index }).catch(() => {}), 800);

export function entry(path) { return app.index.files[key(path)] || null; }

/** Save the library index after changing something other than a file entry (e.g. collections). */
export function saveIndex() { flush(); emit('index', {}); }

export function updateEntry(path, patch) {
  const k = key(path);
  const cur = app.index.files[k] || { path };
  app.index.files[k] = { ...cur, ...patch, path };
  flush();
  emit('index', { path });
  return app.index.files[k];
}

export function thumbUrl(path) {
  const e = entry(path);
  if (!e?.thumb) return null;
  return fileUrl(e.thumb) + '?v=' + encodeURIComponent(e.thumbAt || '');
}

export async function saveThumbnail(path, blob, { manual = false, modelStamp } = {}) {
  if (!blob) return null;
  const data = await blobToBase64(blob);
  const thumb = await call('library.saveThumb', { path, data });
  updateEntry(path, { thumb, thumbAt: new Date().toISOString(), thumbFor: modelStamp || null, thumbManual: manual, thumbVer: THUMB_VERSION });
  return thumb;
}

/**
 * Bump when the viewer draws FBX/OBJ/Collada/3DS materials differently: their automatic thumbnails are made
 * again in the background (2: alpha, roughness and colors read the way Blender and Unity read them).
 */
export const THUMB_VERSION = 2;
export const thumbOutdated = (path, e = entry(path)) =>
  !!e?.thumb && !e.thumbManual && /\.(fbx|obj|dae|3ds)$/i.test(path) && (e.thumbVer || 1) < THUMB_VERSION;

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}
