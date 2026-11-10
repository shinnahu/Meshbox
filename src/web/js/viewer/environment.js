import * as THREE from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';

// CC0 HDRIs from Poly Haven (1k is plenty for lighting; the background is shown blurred).
export const ENVIRONMENTS = [
  { id: 'studio', name: 'Studio', file: 'assets/env/studio.hdr', credit: 'Studio Small 09' },
  { id: 'beach', name: 'Beach', file: 'assets/env/beach.hdr', credit: 'Spiaggia di Mondello' },
  { id: 'desert', name: 'Desert', file: 'assets/env/desert.hdr', credit: 'Goegap' },
  { id: 'forest', name: 'Forest', file: 'assets/env/forest.hdr', credit: 'Forest Slope' },
  { id: 'interior', name: 'Interior', file: 'assets/env/interior.hdr', credit: 'Lebombo' },
  { id: 'night', name: 'Night', file: 'assets/env/night.hdr', credit: 'Satara Night' },
];

const cache = new Map();
const previews = new Map();

export async function loadEnvironment(id) {
  const env = ENVIRONMENTS.find((e) => e.id === id) || ENVIRONMENTS[0];
  if (cache.has(env.id)) return cache.get(env.id);
  const promise = new HDRLoader().setDataType(THREE.HalfFloatType).loadAsync(env.file).then((tex) => {
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.name = env.id;
    return tex;
  });
  cache.set(env.id, promise);
  try { return await promise; } catch (e) { cache.delete(env.id); throw e; }
}

/** A small tone-mapped JPEG of the panorama for the picker (cached per session and in localStorage). */
export async function environmentPreview(id) {
  if (previews.has(id)) return previews.get(id);
  const key = `bv.envprev.${id}.v1`;
  try {
    const cached = localStorage.getItem(key);
    if (cached) { previews.set(id, cached); return cached; }
  } catch { /* ignore */ }
  const tex = await loadEnvironment(id);
  const { data, width, height } = tex.image;
  const W = 256, H = 128;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(W, H);
  const half = data instanceof Uint16Array;
  const from = half ? THREE.DataUtils.fromHalfFloat : (v) => v;
  const channels = data.length / (width * height);
  for (let y = 0; y < H; y++) {
    // HDR data is stored bottom-up after HDRLoader (flipY false) - sample top-down for display.
    const sy = Math.min(height - 1, Math.floor((y + 0.5) / H * height));
    for (let x = 0; x < W; x++) {
      const sx = Math.min(width - 1, Math.floor((x + 0.5) / W * width));
      const i = (sy * width + sx) * channels;
      const o = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) {
        let v = from(data[i + c]) * 1.1;
        v = v / (1 + v);              // Reinhard
        v = Math.pow(v, 1 / 2.2);
        img.data[o + c] = Math.max(0, Math.min(255, v * 255 * 1.08));
      }
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const url = canvas.toDataURL('image/jpeg', 0.82);
  previews.set(id, url);
  try { localStorage.setItem(key, url); } catch { /* quota */ }
  return url;
}
