// Renders src/Host/icon/meshbox.svg (40 px and up) and meshbox-small.svg (16-32 px) with headless
// Edge and packs every size into src/Host/app.ico (PNG entries, Windows Vista and later).
//   node --experimental-websocket tools/make-icon.mjs [preview.png]
// The optional preview.png shows the icon at real sizes on light and dark backgrounds.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
const SMALL_MAX = 32;
const big = readFileSync(join(root, 'src/Host/icon/meshbox.svg'), 'utf8');
const small = readFileSync(join(root, 'src/Host/icon/meshbox-small.svg'), 'utf8');
const previewOut = process.argv[2];

const edge = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
if (!edge) throw new Error('Microsoft Edge not found');
const profile = mkdtempSync(join(tmpdir(), 'meshbox-icon-'));
const browser = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], { stdio: 'ignore' });

try {
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 100));
  const port = readFileSync(portFile, 'utf8').split('\n')[0].trim();
  const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = pages.find((p) => p.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); pending.get(d.id)?.(d); pending.delete(d.id); };
  const send = (method, params) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

  const expr = `(async () => {
    const load = (svg) => new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = rej;
      img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg))); });
    const big = await load(${JSON.stringify(big)}), small = await load(${JSON.stringify(small)});
    const draw = (s) => { const c = document.createElement('canvas'); c.width = c.height = s;
      c.getContext('2d').drawImage(s <= ${SMALL_MAX} ? small : big, 0, 0, s, s); return c; };
    const out = {};
    for (const s of ${JSON.stringify(SIZES)}) out[s] = draw(s).toDataURL('image/png').split(',')[1];
    // preview: real sizes on a light and a dark strip
    const P = document.createElement('canvas'); P.width = 760; P.height = 400;
    const g = P.getContext('2d');
    for (const [y, bg] of [[0, '#f3f3f3'], [200, '#202020']]) {
      g.fillStyle = bg; g.fillRect(0, y, 760, 200);
      let x = 24;
      for (const s of [256, 128, 64, 48, 32, 24, 16]) { const sz = Math.min(s, 168); g.drawImage(draw(s), x, y + 100 - sz / 2, sz, sz); x += sz + 26; }
    }
    out.preview = P.toDataURL('image/png').split(',')[1];
    return out;
  })()`;
  const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (res.result?.exceptionDetails) throw new Error('render failed: ' + JSON.stringify(res.result.exceptionDetails));
  const pngs = res.result.result.value;
  ws.close();

  // ICO: header, one 16-byte entry per size, then the PNG data
  const images = SIZES.map((s) => Buffer.from(pngs[s], 'base64'));
  const header = Buffer.alloc(6 + 16 * SIZES.length);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(SIZES.length, 4);
  let offset = header.length;
  SIZES.forEach((s, i) => {
    const e = 6 + i * 16;
    header.writeUInt8(s >= 256 ? 0 : s, e); header.writeUInt8(s >= 256 ? 0 : s, e + 1);
    header.writeUInt8(0, e + 2); header.writeUInt8(0, e + 3);
    header.writeUInt16LE(1, e + 4); header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(images[i].length, e + 8); header.writeUInt32LE(offset, e + 12);
    offset += images[i].length;
  });
  const ico = Buffer.concat([header, ...images]);
  writeFileSync(join(root, 'src/Host/app.ico'), ico);
  console.log(`wrote src/Host/app.ico (${SIZES.join(', ')} px, ${(ico.length / 1024).toFixed(1)} KB)`);
  if (previewOut) { writeFileSync(previewOut, Buffer.from(pngs.preview, 'base64')); console.log('wrote ' + previewOut); }
} finally {
  browser.kill();
  await new Promise((r) => setTimeout(r, 400));
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* Edge may still hold a file */ }
}
