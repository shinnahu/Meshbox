// Bridge to the .NET host (WebView2). UI → host: {id, cmd, args}; host → UI: {id, ok, result|error} or {event, data}.
const wv = window.chrome?.webview;
export const hasHost = !!wv;

const pending = new Map();
const listeners = new Map();
let nextId = 1;

if (wv) {
  wv.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.id) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.ok) p.resolve(m.result);
      else {
        const err = new Error(m.error || 'Host error');
        err.cancelled = !!m.cancelled;
        p.reject(err);
      }
    } else if (m.event) {
      for (const fn of listeners.get(m.event) || []) {
        try { fn(m.data); } catch (err) { console.error(err); }
      }
    }
  });
}

export function call(cmd, args = {}) {
  if (!wv) return Promise.reject(new Error('This feature needs the desktop app.'));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    wv.postMessage({ id, cmd, args });
  });
}

/** Full paths of dropped File objects (WebView2 hands them to the host as CoreWebView2File). */
export function dropPaths(files) {
  if (!wv || !wv.postMessageWithAdditionalObjects) return Promise.resolve([]);
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    wv.postMessageWithAdditionalObjects({ id, cmd: 'drop.paths', args: {} }, files);
  });
}

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event)?.delete(fn);
}

let jobSeq = 0;
/** Runs a long host job, forwarding job.progress events to onProgress(p, message). */
export async function job(cmd, args, onProgress) {
  const jobId = `job${Date.now().toString(36)}${++jobSeq}`;
  const off = on('job.progress', (d) => { if (d?.jobId === jobId) onProgress?.(d.progress, d.message); });
  try { return await call(cmd, { ...args, jobId }); }
  finally { off(); }
}
export function newJobId() { return `job${Date.now().toString(36)}${++jobSeq}`; }

/**
 * D:\a b\c.fbx → https://d.drive.viewer/a%20b/c.fbx - each drive is mapped natively by WebView2 (fast);
 * the host still answers missing textures with its fallback search. Network paths use files.viewer.
 */
export function fileUrl(path) {
  if (!path) return '';
  if (/^(blob:|data:|https?:)/i.test(path)) return path;
  const p = path.replace(/\//g, '\\');
  const enc = (rest) => rest.split('\\').filter(Boolean).map(encodeURIComponent).join('/');
  if (p.startsWith('\\\\')) return 'https://files.viewer/~unc/' + enc(p.slice(2));
  return `https://${p[0].toLowerCase()}.drive.viewer/` + enc(p.slice(3));
}

/** The host-answered form (slower, but missing files get the texture fallback search). */
export function searchUrl(url) {
  const m = /^https:\/\/([a-z])\.drive\.viewer\//i.exec(url);
  return m ? `https://files.viewer/${m[1].toUpperCase()}/` + url.slice(m[0].length) : url;
}

export function urlToPath(url) {
  try {
    const u = new URL(url);
    const segs = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const drive = /^([a-z])\.drive\.viewer$/i.exec(u.host);
    if (drive) return drive[1].toUpperCase() + ':\\' + segs.join('\\');
    if (u.host !== 'files.viewer') return null;
    if (segs[0] === '~unc') return '\\\\' + segs.slice(1).join('\\');
    return segs[0] + ':\\' + segs.slice(1).join('\\');
  } catch { return null; }
}

export function blendThumbUrl(path, stamp = '') {
  return `https://files.viewer/_/blendthumb?path=${encodeURIComponent(path)}&t=${encodeURIComponent(stamp)}`;
}

export const basename = (p) => (p || '').split(/[\\/]/).pop();
export const dirname = (p) => { const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')); return i > 0 ? p.slice(0, i) : p; };
export const extname = (p) => { const b = basename(p); const i = b.lastIndexOf('.'); return i >= 0 ? b.slice(i).toLowerCase() : ''; };
export const stem = (p) => { const b = basename(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(0, i) : b; };
export const joinPath = (...parts) => parts.filter(Boolean).map((s, i) => i === 0 ? s.replace(/[\\/]+$/, '') : s.replace(/^[\\/]+|[\\/]+$/g, '')).join('\\');
