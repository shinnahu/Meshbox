import * as THREE from 'three';

// View modes keep the original materials untouched and swap in derived ones per mesh:
//   textured  original look, legacy FBX/OBJ Phong/Lambert converted to PBR so the HDRI lights it
//   solid     gray clay          normal   view-space normals      unlit   base color only
//   anime     toon (cel) shading - outlines come from the post pass
//   sketchShade / prepass        internal passes for the anime/sketch post effects

const toonRamp = (() => {
  const data = new Uint8Array([90, 90, 90, 255, 255, 255, 255, 255]);
  const t = new THREE.DataTexture(data, 2, 1, THREE.RGBAFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
})();

const COPY_KEYS = ['map', 'alphaMap', 'aoMap', 'aoMapIntensity', 'lightMap', 'lightMapIntensity', 'normalMap', 'normalMapType', 'normalScale',
  'bumpMap', 'bumpScale', 'displacementMap', 'displacementScale', 'displacementBias', 'emissive', 'emissiveMap', 'emissiveIntensity',
  'transparent', 'opacity', 'alphaTest', 'side', 'vertexColors', 'depthWrite', 'depthTest', 'alphaToCoverage', 'name', 'visible', 'blending'];

function copyCommon(dst, src, keys = COPY_KEYS) {
  for (const k of keys) {
    if (!(k in src) || !(k in dst) || src[k] === undefined) continue;
    const v = src[k];
    if (v && typeof v === 'object' && typeof v.clone === 'function' && !v.isTexture) dst[k] = v.clone();
    else dst[k] = v;
  }
  if (src.color && dst.color) dst.color.copy(src.color);
  if (dst.alphaMap && src.userData.alphaMapChannel === 'a') alphaMapFromAlpha(dst);
  dst.userData.source = src;
  return dst;
}

/** three.js reads alphaMap from the green channel; an RGBA cut-out image keeps its alpha in A. */
function alphaMapFromAlpha(mat) {
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <alphamap_fragment>',
      '#ifdef USE_ALPHAMAP\n\tdiffuseColor.a *= texture2D( alphaMap, vAlphaMapUv ).a;\n#endif');
  };
  mat.customProgramCacheKey = () => 'alphaMapA';
}

// ---------------------------------------------------------------- legacy (FBX/OBJ/DAE/3DS) alpha
// Those formats only say "this image drives transparency", never how: Blender's FBX exporter links the
// base color image a second time as the alpha texture, which three.js would read from the green channel
// (dark eyes turn see-through), and every alpha link becomes a blended material. Here each one is
// sorted by what its image really holds: no transparency (opaque), a cut-out (alpha test at 0.5 like
// Blender's "Alpha > 0.5" or Unity's Cutout, only the anti-aliased rim blends) or real see-through alpha.

/** Alpha content of an image: 'none' | 'cutout' | 'soft', or null while it has not loaded. */
function alphaKind(texture, channel, cache) {
  const img = texture?.source?.data;
  const w0 = img?.naturalWidth || img?.width || 0, h0 = img?.naturalHeight || img?.height || 0;
  if (!w0 || !h0 || img.complete === false) return null;
  const key = (img.currentSrc || img.src || texture.source.uuid) + '|' + channel;
  if (cache.has(key)) return cache.get(key);
  let kind = null;
  try {
    let data;
    if (img.data && img.data.length === w0 * h0 * 4) data = img.data;            // DataTexture (TGA/PSD/TIFF)
    else {
      const s = Math.min(1, 512 / Math.max(w0, h0));
      const w = Math.max(1, Math.round(w0 * s)), h = Math.max(1, Math.round(h0 * s));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.imageSmoothingEnabled = false;   // real texels: averaging would invent soft edges
      g.drawImage(img, 0, 0, w, h);
      data = g.getImageData(0, 0, w, h).data;
    }
    const off = channel === 'a' ? 3 : 1;
    let visible = 0, soft = 0, clear = 0;
    for (let i = off; i < data.length; i += 4) {
      const a = data[i];
      if (a < 8) clear++;
      else { visible++; if (a < 248) soft++; }
    }
    kind = !clear && soft / Math.max(1, visible) < 0.002 ? 'none' : soft / Math.max(1, visible) <= 0.4 ? 'cutout' : 'soft';
  } catch { /* unreadable image: leave the material as it is */ }
  cache.set(key, kind);
  return kind;
}

const sameImage = (a, b) => a && b && (a.source === b.source || a.source?.data === b.source?.data
  || (!!(a.source?.data?.src) && a.source.data.src === b.source?.data?.src));
const hasAlphaChannel = (t, cache) => { const k = alphaKind(t, 'a', cache); return k && k !== 'none'; };

/**
 * Call once per loaded model (legacy formats, textures loaded). `fbx`: roughness from Shininess the way
 * Blender writes it and Unity reads it, and textures on color slots used as FBX defines them.
 */
export function fixLegacyMaterials(root, { fbx = false } = {}) {
  const cache = new Map();
  const done = new Set();
  root.traverse((o) => {
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
      if (!m || done.has(m)) continue;
      done.add(m);
      if (fbx) {
        m.userData.fbxShininess = true;
        // In FBX a texture on a color slot replaces the stored color (Blender and Unity read it that way).
        // Blender still writes the socket's leftover value (0.8 gray by default, black for emission) and
        // FBXLoader multiplied it in: textures came out darker or tinted, emission maps stayed dark.
        // The emission map can be any texture (a glow mask, lit windows...), its strength is EmissiveFactor.
        if (m.map && m.color) m.color.set(0xffffff);
        if (m.emissiveMap && m.emissive) m.emissive.set(0xffffff);
      }
      if (!m.map && !m.alphaMap) continue;
      if (!(m.transparent || m.alphaMap || m.alphaTest > 0)) continue;
      // The same picture as the base color: its alpha is already applied through `map`.
      if (m.alphaMap && sameImage(m.alphaMap, m.map)) m.alphaMap = null;
      let kind;
      if (m.alphaMap) {
        const a = hasAlphaChannel(m.alphaMap, cache);
        if (a) m.userData.alphaMapChannel = 'a';
        kind = alphaKind(m.alphaMap, a ? 'a' : 'g', cache);
        if (m.map && kind) { const k2 = alphaKind(m.map, 'a', cache); if (k2 === 'soft' || (k2 === 'cutout' && kind === 'none')) kind = k2; }
      } else kind = alphaKind(m.map, 'a', cache);
      if (!kind || m.opacity < 1) { m.needsUpdate = true; continue; }   // a see-through factor stays blended
      if (kind === 'none') { m.transparent = false; m.alphaTest = 0; }
      else if (kind === 'cutout') { m.transparent = true; m.alphaTest = 0.5; m.depthWrite = true; }
      else m.transparent = true;
      m.userData.alphaKind = kind;
      m.needsUpdate = true;
    }
  });
}

/** Phong/Lambert (FBX, OBJ) → MeshStandardMaterial, so image based lighting applies. */
export function toPBR(m) {
  if (!m || m.isMeshStandardMaterial || m.isShaderMaterial || m.isRawShaderMaterial || m.isMeshBasicMaterial || m.isMeshToonMaterial || m.isPointsMaterial || m.isLineBasicMaterial) return m;
  const std = copyCommon(new THREE.MeshStandardMaterial(), m);
  let roughness = 0.65;
  if (m.isMeshPhongMaterial) {
    const s = Math.max(0, m.shininess ?? 30);
    // FBX: Blender writes Shininess = ((1 - roughness) × 10)² and Unity reads smoothness = √(Shininess / 100),
    // so roughness = 1 - √Shininess / 10 matches both. Other formats: a Phong exponent → perceptual roughness.
    roughness = m.userData.fbxShininess ? 1 - Math.sqrt(Math.min(s, 100)) / 10 : Math.pow(2 / (s + 2), 0.25);
    roughness = Math.min(1, Math.max(0.04, roughness));
    if (m.specularMap) std.roughnessMap = null;
  }
  std.roughness = roughness;
  // Phong.reflectivity defaults to 1 when the file says nothing, so it cannot be trusted as metallic.
  std.metalness = 0;
  std.userData.convertedFrom = m.type;
  return std;
}

function alphaOnlyMap(mat, src) {
  // Keep cut-outs (hair cards, lashes) in solid/normal modes: sample only the map's alpha.
  if (!src.map || !(src.alphaTest > 0 || src.transparent)) return mat;
  mat.map = src.map;
  mat.alphaTest = src.alphaTest > 0 ? src.alphaTest : 0.5;
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>',
      '#ifdef USE_MAP\n\tdiffuseColor.a *= texture2D( map, vMapUv ).a;\n#endif');
  };
  mat.customProgramCacheKey = () => 'alphaOnly';
  return mat;
}

export function makeSolid(m) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xc8c9cc, roughness: 0.62, metalness: 0, side: m.side ?? THREE.FrontSide });
  mat.vertexColors = false;
  mat.userData.source = m;
  return alphaOnlyMap(mat, m);
}

export function makeNormal(m) {
  const mat = new THREE.MeshNormalMaterial({ side: m.side ?? THREE.FrontSide });
  mat.userData.source = m;
  return mat;
}

export function makeUnlit(m) {
  const mat = copyCommon(new THREE.MeshBasicMaterial(), m, ['map', 'alphaMap', 'transparent', 'opacity', 'alphaTest', 'side', 'vertexColors', 'name', 'visible', 'depthWrite']);
  if (!m.color) mat.color.set(0xffffff);
  // Emissive-only materials (e.g. glowing eyes) would turn black without lighting.
  if (m.emissiveMap && !m.map) mat.map = m.emissiveMap;
  return mat;
}

export function makeToon(m) {
  const mat = copyCommon(new THREE.MeshToonMaterial({ gradientMap: toonRamp }), m,
    ['map', 'alphaMap', 'transparent', 'opacity', 'alphaTest', 'side', 'vertexColors', 'emissive', 'emissiveMap', 'emissiveIntensity', 'normalMap', 'normalScale', 'name', 'visible']);
  mat.toneMapped = false;
  return mat;
}

export function makeSketchShade(m) {
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, side: m.side ?? THREE.FrontSide });
  mat.userData.source = m;
  return alphaOnlyMap(mat, m);
}

/** Normals in RGB, view-space depth in A - input for the outline / hatching post pass. */
export function makePrepass(m) {
  const mat = new THREE.MeshNormalMaterial({ side: m.side ?? THREE.FrontSide });
  if (m.map && (m.alphaTest > 0 || m.transparent)) { mat.map = m.map; mat.alphaTest = m.alphaTest > 0 ? m.alphaTest : 0.5; }
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vDepth;')
      .replace('#include <project_vertex>', '#include <project_vertex>\n\tvDepth = -mvPosition.z;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <uv_pars_fragment>', '#include <uv_pars_fragment>\n#include <map_pars_fragment>\n#include <alphatest_pars_fragment>\nvarying float vDepth;')
      .replace('gl_FragColor = vec4( normalize( normal ) * 0.5 + 0.5, diffuseColor.a );',
        '#ifdef USE_MAP\n\tdiffuseColor.a *= texture2D( map, vMapUv ).a;\n#endif\n#include <alphatest_fragment>\n\tgl_FragColor = vec4( normalize( normal ) * 0.5 + 0.5, vDepth );')
      .replace(/#ifdef OPAQUE[\s\S]*?#endif/, '');
  };
  mat.customProgramCacheKey = () => 'prepass';
  mat.userData.source = m;
  return mat;
}

const MAKERS = { textured: toPBR, solid: makeSolid, normal: makeNormal, unlit: makeUnlit, anime: makeToon, sketchShade: makeSketchShade, prepass: makePrepass };

export class MaterialModes {
  constructor(root) {
    this.entries = [];
    this.mode = 'textured';
    this.flat = false;
    this.wire = null;
    root.traverse((o) => {
      if ((o.isMesh || o.isSkinnedMesh) && !o.userData.helper && o.material) {
        this.entries.push({ mesh: o, original: o.material, cache: new Map() });
      }
    });
    this.apply('textured');
  }

  get(entry, mode) {
    if (mode === 'original') return entry.original;
    let m = entry.cache.get(mode);
    if (!m) {
      const make = MAKERS[mode] || toPBR;
      m = Array.isArray(entry.original) ? entry.original.map((x) => make(x)) : make(entry.original);
      entry.cache.set(mode, m);
      this.applyFlatTo(m);
      if (this.wire) for (const x of Array.isArray(m) ? m : [m]) { x.polygonOffset = true; x.polygonOffsetFactor = 1; x.polygonOffsetUnits = 1; }
    }
    return m;
  }

  apply(mode) {
    this.mode = mode;
    for (const e of this.entries) e.mesh.material = this.get(e, mode);
  }

  /** Calls fn(copy, mode) for every view-mode material made from `mat` (Materials page edits). */
  forCopies(mat, fn) {
    for (const e of this.entries) {
      for (const [mode, m] of e.cache) {
        for (const x of [].concat(m)) if (x && x !== mat && x.userData.source === mat) fn(x, mode);
      }
    }
  }

  /** Temporarily render with another material set (post passes), then restore. */
  with(mode, fn) {
    const prev = this.mode;
    for (const e of this.entries) e.mesh.material = this.get(e, mode);
    try { fn(); } finally { for (const e of this.entries) e.mesh.material = this.get(e, prev); }
  }

  applyFlatTo(m) {
    for (const x of Array.isArray(m) ? m : [m]) {
      if (!x || x.isMeshBasicMaterial || x.isShaderMaterial) continue;
      if (x.flatShading !== this.flat) { x.flatShading = this.flat; x.needsUpdate = true; }
    }
  }

  setFlat(flat) {
    this.flat = flat;
    for (const e of this.entries) for (const m of e.cache.values()) this.applyFlatTo(m);
  }

  /** Wireframe overlay. FBX polygons are outlined as quads/n-gons (no triangulation diagonals). */
  setWireframe(on, color = 0x15161a, opacity = 0.5) {
    if (!on) {
      if (this.wire) for (const w of this.wire) { w.parent?.remove(w); w.geometry.dispose(); }
      this.wire = null;
      this.setPolygonOffset(false);
      return;
    }
    if (this.wire) return;
    this.wire = [];
    const mat = new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity, depthWrite: false, toneMapped: false });
    for (const { mesh } of this.entries) {
      const src = mesh.geometry;
      const geo = new THREE.BufferGeometry();
      for (const [k, v] of Object.entries(src.attributes)) geo.setAttribute(k, v);
      geo.morphAttributes = src.morphAttributes;
      geo.morphTargetsRelative = src.morphTargetsRelative;
      const edges = src.userData?.polyEdges;
      if (edges) {
        // Each outline edge becomes a degenerate triangle (a, b, b): drawn as wireframe it is just a-b.
        const idx = new Uint32Array((edges.length / 2) * 3);
        for (let i = 0, j = 0; i < edges.length; i += 2, j += 3) { idx[j] = edges[i]; idx[j + 1] = edges[i + 1]; idx[j + 2] = edges[i + 1]; }
        geo.setIndex(new THREE.BufferAttribute(idx, 1));
      } else if (src.index) geo.setIndex(src.index);
      if (src.boundingSphere) geo.boundingSphere = src.boundingSphere;
      if (src.boundingBox) geo.boundingBox = src.boundingBox;
      let w;
      if (mesh.isSkinnedMesh) {
        w = new THREE.SkinnedMesh(geo, mat);
        w.bind(mesh.skeleton, mesh.bindMatrix);
      } else w = new THREE.Mesh(geo, mat);
      if (mesh.morphTargetInfluences) {
        w.morphTargetInfluences = mesh.morphTargetInfluences;
        w.morphTargetDictionary = mesh.morphTargetDictionary;
      }
      w.userData.helper = true;
      w.name = '__wire';
      w.frustumCulled = false;
      w.renderOrder = 2;
      mesh.add(w);
      this.wire.push(w);
    }
    this.setPolygonOffset(true);
  }

  setWireColor(color, opacity) {
    if (!this.wire?.length) return;
    const m = this.wire[0].material;
    m.color.set(color);
    m.opacity = opacity;
  }

  setPolygonOffset(on) {
    for (const e of this.entries) for (const m of e.cache.values()) {
      for (const x of Array.isArray(m) ? m : [m]) {
        x.polygonOffset = on; x.polygonOffsetFactor = on ? 1 : 0; x.polygonOffsetUnits = on ? 1 : 0;
      }
    }
  }

  dispose() {
    this.setWireframe(false);
    for (const e of this.entries) {
      e.mesh.material = e.original;
      for (const [mode, m] of e.cache) {
        for (const x of Array.isArray(m) ? m : [m]) if (x && x !== e.original && mode !== 'textured') x.dispose?.();
        if (mode === 'textured') for (const x of Array.isArray(m) ? m : [m]) if (x?.userData?.convertedFrom) x.dispose();
      }
    }
    this.entries = [];
  }
}

export { toonRamp };
