import * as THREE from 'three';
import { FBXLoader } from '../vendor/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';
import { TDSLoader } from 'three/examples/jsm/loaders/TDSLoader.js';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { USDZLoader } from 'three/examples/jsm/loaders/USDZLoader.js';
import { TGALoader } from 'three/examples/jsm/loaders/TGALoader.js';
import { TIFFLoader } from 'three/examples/jsm/loaders/TIFFLoader.js';
import { fileUrl, urlToPath, searchUrl, call, basename } from '../host.js';

export const MODEL_EXTS = ['.fbx', '.glb', '.gltf', '.vrm', '.obj', '.stl', '.ply', '.dae', '.3ds', '.3mf', '.usdz', '.blend'];
const IMAGE_RE = /\.(png|jpe?g|tga|bmp|gif|webp|tiff?|psd|dds|exr|hdr|ktx2)(\?|$)/i;

let shared = null;
function sharedDecoders(renderer) {
  if (shared) return shared;
  const draco = new DRACOLoader().setDecoderPath('assets/draco/');
  const ktx2 = new KTX2Loader().setTranscoderPath('assets/basis/');
  if (renderer) ktx2.detectSupport(renderer);
  shared = { draco, ktx2 };
  return shared;
}

// ---------------------------------------------------------------- texture formats the browser can't decode
function decodePSD(buffer) {
  const dv = new DataView(buffer);
  if (dv.getUint32(0) !== 0x38425053) throw new Error('Not a PSD');
  const version = dv.getUint16(4);
  const channels = dv.getUint16(12);
  const height = dv.getUint32(14);
  const width = dv.getUint32(18);
  const depth = dv.getUint16(22);
  const mode = dv.getUint16(24);
  if (depth !== 8 || !(mode === 3 || mode === 1)) throw new Error('Only 8-bit RGB/gray PSD composites are supported');
  let off = 26;
  off += 4 + dv.getUint32(off);
  off += 4 + dv.getUint32(off);
  off += version === 2 ? 8 + Number(dv.getBigUint64(off)) : 4 + dv.getUint32(off);
  const compression = dv.getUint16(off); off += 2;
  const bytes = new Uint8Array(buffer);
  const px = new Uint8ClampedArray(width * height * 4);
  for (let i = 3; i < px.length; i += 4) px[i] = 255;
  const target = (c) => (mode === 1 ? (c === 0 ? [0, 1, 2] : c === 1 ? [3] : []) : c < 4 ? [c] : []);
  const plane = new Uint8Array(width);
  const writeRow = (c, y, row) => {
    for (const t of target(c)) for (let x = 0; x < width; x++) px[(y * width + x) * 4 + t] = row[x];
  };
  if (compression === 0) {
    for (let c = 0; c < channels; c++) for (let y = 0; y < height; y++) { writeRow(c, y, bytes.subarray(off, off + width)); off += width; }
  } else if (compression === 1) {
    const cs = version === 2 ? 4 : 2;
    const counts = new Array(channels * height);
    for (let i = 0; i < counts.length; i++) { counts[i] = cs === 2 ? dv.getUint16(off) : dv.getUint32(off); off += cs; }
    for (let c = 0; c < channels; c++) {
      for (let y = 0; y < height; y++) {
        const end = off + counts[c * height + y];
        let x = 0;
        while (off < end && x < width) {
          const n = dv.getInt8(off++);
          if (n >= 0) { for (let k = 0; k <= n && x < width; k++) plane[x++] = bytes[off++]; }
          else if (n !== -128) { const v = bytes[off++]; for (let k = 0; k < 1 - n && x < width; k++) plane[x++] = v; }
        }
        off = end;
        writeRow(c, y, plane);
      }
    }
  } else throw new Error('Unsupported PSD compression');
  return new ImageData(px, width, height);
}

async function decodeAny(buffer) {
  const b = new Uint8Array(buffer, 0, Math.min(12, buffer.byteLength));
  const isPNG = b[0] === 0x89 && b[1] === 0x50;
  const isJPG = b[0] === 0xff && b[1] === 0xd8;
  const isGIF = b[0] === 0x47 && b[1] === 0x49;
  const isBMP = b[0] === 0x42 && b[1] === 0x4d;
  const isWEBP = b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57;
  if (isPNG || isJPG || isGIF || isBMP || isWEBP) {
    const url = URL.createObjectURL(new Blob([buffer]));
    const img = new Image();
    img.src = url;
    try { await img.decode(); } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
    return img;
  }
  if (b[0] === 0x38 && b[1] === 0x42 && b[2] === 0x50 && b[3] === 0x53) return decodePSD(buffer);
  if ((b[0] === 0x49 && b[1] === 0x49) || (b[0] === 0x4d && b[1] === 0x4d)) {
    const t = new TIFFLoader().parse(buffer);
    return new ImageData(new Uint8ClampedArray(t.data.buffer, t.data.byteOffset, t.data.byteLength), t.width, t.height);
  }
  const t = new TGALoader().parse(buffer); // TGA has no magic number; last resort
  return new ImageData(new Uint8ClampedArray(t.data.buffer, t.data.byteOffset, t.data.byteLength), t.width, t.height);
}

/** Handles .tga/.psd/.tif - and whatever the host substitutes for them (often a .png with the same name). */
class SmartTextureLoader extends THREE.Loader {
  load(url, onLoad, onProgress, onError) {
    const texture = new THREE.Texture();
    const loader = new THREE.FileLoader(this.manager).setPath(this.path).setResponseType('arraybuffer');
    loader.load(url, async (buffer) => {
      try {
        texture.image = await decodeAny(buffer);
        texture.needsUpdate = true;
        onLoad?.(texture);
        this.onDecoded?.(texture);
      } catch (e) {
        console.warn('Texture decode failed', url, e);
        this.onFailed?.(this.manager.resolveURL((this.path || '') + url), e);
        onError?.(e);
      }
    }, onProgress, onError);
    return texture;
  }
}

// ---------------------------------------------------------------- fetch with progress
async function fetchBytes(url, onProgress, signal, knownSize = 0) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(res.status === 404 ? 'File not found.' : `Could not read the file (${res.status}).`);
  const total = +res.headers.get('Content-Length') || knownSize || 0;
  if (!res.body) return res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress?.(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out.buffer;
}

function fbxVersion(buffer) {
  const head = new Uint8Array(buffer, 0, Math.min(64, buffer.byteLength));
  const text = new TextDecoder('latin1').decode(head);
  if (text.startsWith('Kaydara FBX Binary')) {
    const v = new DataView(buffer).getUint32(23, true);
    return { binary: true, version: v, label: `FBX ${Math.floor(v / 1000)}.${Math.floor((v % 1000) / 100)} binary` };
  }
  const m = /FBX (\d+)\.(\d+)/.exec(new TextDecoder('latin1').decode(new Uint8Array(buffer, 0, Math.min(400, buffer.byteLength))));
  return { binary: false, version: m ? +m[1] * 1000 + +m[2] * 100 : 0, label: m ? `FBX ${m[1]}.${m[2]} ASCII` : 'FBX ASCII' };
}

/**
 * Loads a model file served by the host. Returns { root, clips, format, unitScale (meters per unit),
 * textures: [{name, url, path, status, how, embedded, slots}] }.
 */
export async function loadModel(path, { renderer, onProgress, signal, displayName, onTexture } = {}) {
  const ext = ('.' + path.split('.').pop()).toLowerCase();
  const url = fileUrl(path);
  const base = url.slice(0, url.lastIndexOf('/') + 1);

  // Track every texture request so the info panel can say embedded / found / substituted / missing.
  const manager = new THREE.LoadingManager();
  const seen = new Map();
  let started = 0, ended = 0, idleResolve = null;
  manager.setURLModifier((u) => {
    if (/^(blob:|data:)/.test(u)) { seen.set(u, { url: u, embedded: true, status: 'pending' }); return u; }
    if (IMAGE_RE.test(u)) {
      // Textures go through the host so a missing one is searched for (Textures\, .fbm, .psd → .png...).
      const s = searchUrl(u);
      seen.set(s, { url: s, embedded: false, status: 'pending' });
      return s;
    }
    return u;
  });
  const origStart = manager.itemStart.bind(manager);
  const origEnd = manager.itemEnd.bind(manager);
  const origError = manager.itemError.bind(manager);
  manager.itemStart = (u) => { started++; origStart(u); };
  manager.itemEnd = (u) => {
    ended++;
    const e = seen.get(u);
    if (e && e.status === 'pending') e.status = 'ok';
    onProgress?.({ stage: 'textures', loaded: ended, total: started });
    origEnd(u);
    if (ended >= started) idleResolve?.();
  };
  manager.itemError = (u) => { const e = seen.get(u); if (e) e.status = 'error'; origError(u); };
  const smart = new SmartTextureLoader(manager);
  smart.onDecoded = () => onTexture?.();
  smart.onFailed = (u) => { const e = seen.get(u); if (e) e.status = 'error'; };
  manager.addHandler(/\.(tga|psd|tiff?)$/i, smart);

  // The native drive mapping sends no Content-Length: ask the host for the size so progress is real.
  let knownSize = 0;
  try { knownSize = (await call('fs.stat', { path })).size || 0; } catch { /* no host */ }
  const fetchBytesP = (u, p, s) => fetchBytes(u, p, s, knownSize);
  const progressBytes = (loaded, total) => onProgress?.({ stage: 'download', loaded, total });
  let result;
  switch (ext) {
    case '.fbx': {
      const buf = await fetchBytesP(url, progressBytes, signal);
      const ver = fbxVersion(buf);
      if (ver.version && ver.version < 7000) throw new Error(`${ver.label.replace('binary', '')} is too old to read (FBX 2011+ / 7.0 needed). Re-export it as FBX 7.4 from Blender, Maya or the Autodesk FBX Converter.`);
      onProgress?.({ stage: 'parse' });
      await nextFrame();
      const root = new FBXLoader(manager).parse(buf, base);
      const usf = root.userData?.unitScaleFactor;
      result = { root, clips: root.animations || [], format: ver.label, unitScale: (usf || 1) / 100, unitScaleFactor: usf ?? null };
      break;
    }
    case '.glb': case '.gltf': case '.vrm': {
      const buf = await fetchBytesP(url, progressBytes, signal);
      onProgress?.({ stage: 'parse' });
      await nextFrame();
      const { draco, ktx2 } = sharedDecoders(renderer);
      const loader = new GLTFLoader(manager).setDRACOLoader(draco).setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
      const gltf = await new Promise((res, rej) => loader.parse(buf, base, res, rej));
      const root = gltf.scene || gltf.scenes?.[0];
      const asset = gltf.parser?.json?.asset || {};
      const exts = gltf.parser?.json?.extensionsUsed || [];
      const fmt = ext === '.vrm' || exts.some((e) => e.startsWith('VRM')) ? 'VRM (glTF)' : `glTF ${asset.version || '2.0'}${ext === '.glb' ? ' binary' : ''}`;
      result = { root, clips: gltf.animations || [], format: fmt, unitScale: 1, generator: asset.generator, extensions: exts };
      break;
    }
    case '.obj': {
      const text = new TextDecoder().decode(await fetchBytesP(url, progressBytes, signal));
      onProgress?.({ stage: 'parse' });
      const loader = new OBJLoader(manager);
      const mtl = /^mtllib\s+(.+)$/m.exec(text)?.[1]?.trim();
      const candidates = [mtl, basename(path).replace(/\.obj$/i, '.mtl')].filter(Boolean);
      for (const name of candidates) {
        try {
          const mtlLoader = new MTLLoader(manager).setPath(base).setResourcePath(base);
          const materials = await mtlLoader.loadAsync(name.replace(/\\/g, '/'));
          materials.preload();
          loader.setMaterials(materials);
          break;
        } catch { /* no material library */ }
      }
      const root = loader.parse(text);
      result = { root, clips: [], format: 'Wavefront OBJ', unitScale: 1 };
      break;
    }
    case '.stl': {
      const buf = await fetchBytesP(url, progressBytes, signal);
      const geo = new STLLoader().parse(buf);
      geo.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({ color: geo.hasColors ? 0xffffff : 0xb9bcc4, roughness: 0.55, vertexColors: !!geo.hasColors });
      const root = new THREE.Group();
      root.add(new THREE.Mesh(geo, mat));
      result = { root, clips: [], format: 'STL', unitScale: 1 };
      break;
    }
    case '.ply': {
      const buf = await fetchBytesP(url, progressBytes, signal);
      const geo = new PLYLoader().parse(buf);
      const root = new THREE.Group();
      const colors = !!geo.attributes.color;
      if (geo.index) {
        if (!geo.attributes.normal) geo.computeVertexNormals();
        root.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: colors ? 0xffffff : 0xb9bcc4, vertexColors: colors, roughness: 0.6 })));
      } else root.add(new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.01, vertexColors: colors })));
      result = { root, clips: [], format: 'PLY', unitScale: 1 };
      break;
    }
    case '.dae': {
      const text = new TextDecoder().decode(await fetchBytesP(url, progressBytes, signal));
      const dae = new ColladaLoader(manager).parse(text, base);
      result = { root: dae.scene, clips: dae.scene.animations || dae.animations || [], format: 'Collada', unitScale: 1 };
      break;
    }
    case '.3ds': {
      const buf = await fetchBytesP(url, progressBytes, signal);
      const loader = new TDSLoader(manager);
      loader.setResourcePath(base);
      result = { root: loader.parse(buf, base), clips: [], format: '3D Studio', unitScale: 1 };
      break;
    }
    case '.3mf': {
      const buf = await fetchBytesP(url, progressBytes, signal);
      result = { root: new ThreeMFLoader(manager).parse(buf), clips: [], format: '3MF', unitScale: 0.001 };
      break;
    }
    case '.usdz': {
      const buf = await fetchBytesP(url, progressBytes, signal);
      result = { root: await new USDZLoader(manager).parse(buf), clips: [], format: 'USDZ', unitScale: 1 };
      break;
    }
    default:
      throw new Error(`${ext.toUpperCase().slice(1)} files are not supported.`);
  }

  // Wait for textures (or give up waiting after a while; late textures still appear when ready).
  onProgress?.({ stage: 'textures', loaded: ended, total: started });
  if (ended < started) {
    await Promise.race([new Promise((r) => { idleResolve = r; }), new Promise((r) => setTimeout(r, 45000))]);
  }

  result.textures = await textureReport(result.root, seen);
  result.displayName = displayName || basename(path);
  return result;
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

async function textureReport(root, seen) {
  let log = [];
  try { log = await call('textures.log'); } catch { /* browser preview */ }
  const byRequested = new Map(log.map((l) => [l.requested.toLowerCase(), l]));
  const slots = new Map();
  root.traverse((o) => {
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
      if (!m) continue;
      for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'alphaMap', 'bumpMap', 'specularMap', 'lightMap', 'displacementMap']) {
        const t = m[key];
        if (!t?.isTexture) continue;
        const src = t.source?.data;
        const srcUrl = src?.currentSrc || src?.src || '';
        const k = t.uuid;
        if (!slots.has(k)) slots.set(k, { texture: t, slots: new Set(), materials: new Set(), url: srcUrl });
        slots.get(k).slots.add(key);
        slots.get(k).materials.add(m.name || '(unnamed)');
      }
    }
  });
  const out = [];
  const used = new Set();
  for (const [u, e] of seen) {
    if (e.embedded) continue;
    const path = urlToPath(u);
    const l = path ? byRequested.get(path.toLowerCase()) : null;
    let status = e.status === 'error' ? 'missing' : 'found';
    let how = l?.how || (e.status === 'error' ? 'missing' : 'exact');
    if (l && l.how === 'missing') status = 'missing';
    // FBXLoader only keeps file names, so "Textures\x.png" relative links resolve as "nearby": that is a
    // healthy link (Unity looks in the same places). Other extensions or a deep search are substitutions.
    if (l && l.resolved && l.how !== 'exact' && l.how !== 'nearby') status = 'substituted';
    out.push({ name: basename(path || u), requested: path, path: l?.resolved || (status === 'missing' ? null : path), status, how, embedded: false });
    used.add(u);
  }
  const embeddedCount = [...seen.values()].filter((e) => e.embedded).length;
  // glTF/GLB keep images inside the file; FBX may embed them (blob: URLs above).
  for (const { texture, slots: s, materials } of slots.values()) {
    const src = texture.source?.data;
    const srcUrl = src?.currentSrc || src?.src || '';
    const isBlob = /^(blob:|data:)/.test(srcUrl) || (!srcUrl && src);
    if (isBlob && !out.some((x) => x.texture === texture)) {
      out.push({ name: texture.name || 'embedded image', status: 'embedded', embedded: true, slots: [...s], materials: [...materials], texture, width: src?.width, height: src?.height });
    } else {
      const match = out.find((x) => x.requested && srcUrl && decodeURIComponent(srcUrl).toLowerCase().endsWith(x.name.toLowerCase()));
      if (match) { match.slots = [...s]; match.materials = [...materials]; match.width = src?.width; match.height = src?.height; }
    }
  }
  out.embeddedCount = embeddedCount;
  return out;
}
