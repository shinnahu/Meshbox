import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

// Anime and sketch styles: a normals+depth prepass drives outlines (silhouettes and creases);
// anime composites cel-shaded color under ink lines, sketch draws graphite hatching on paper
// (or manga ink with screentone dots) from a plain lit pass.

const vertexShader = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const fragmentShader = /* glsl */`
uniform sampler2D tColor;
uniform sampler2D tND;
uniform vec2 uRes;
uniform int uStyle;          // 0 anime, 1 pencil, 2 ink
uniform float uThickness;    // edge sample distance in device px
uniform float uScale;        // device px per CSS px (keeps hatching density stable in screenshots)
uniform float uTransparent;
uniform vec3 uLine;
uniform vec3 uPaper;
uniform float uDepthThreshold;
varying vec2 vUv;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
vec4 nd(vec2 uv) { vec4 s = texture2D(tND, uv); if (s.a <= 0.0) s.a = 1e6; return s; }
float pairEdge(vec4 c, vec2 uv) {
  vec4 s = nd(uv);
  float rel = abs(s.a - c.a) / max(min(s.a, c.a), 1e-5);
  float e = smoothstep(uDepthThreshold, uDepthThreshold * 2.5, rel);
  if (s.a < 1e5 && c.a < 1e5) {
    float nd2 = 1.0 - dot(normalize(s.rgb * 2.0 - 1.0), normalize(c.rgb * 2.0 - 1.0));
    e = max(e, smoothstep(0.3, 0.6, nd2));
  }
  return e;
}
float edgeAt(vec2 uv, float t) {
  vec2 px = t / uRes;
  vec4 c = nd(uv);
  float e = pairEdge(c, uv + vec2(px.x, 0.0));
  e = max(e, pairEdge(c, uv - vec2(px.x, 0.0)));
  e = max(e, pairEdge(c, uv + vec2(0.0, px.y)));
  e = max(e, pairEdge(c, uv - vec2(0.0, px.y)));
  e = max(e, 0.7 * pairEdge(c, uv + px));
  e = max(e, 0.7 * pairEdge(c, uv - px));
  e = max(e, 0.7 * pairEdge(c, uv + vec2(px.x, -px.y)));
  e = max(e, 0.7 * pairEdge(c, uv + vec2(-px.x, px.y)));
  return e;
}
vec3 toSRGB(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
float hatch(vec2 p, float ang, float spacing, float width) {
  vec2 d = vec2(cos(ang), sin(ang));
  float t = dot(p, vec2(-d.y, d.x)) / spacing;
  t += (noise(p * 0.03 + ang) - 0.5) * 0.7;
  float f = abs(fract(t) - 0.5) * 2.0;
  float broken = smoothstep(0.15, 0.45, noise(p * vec2(0.05, 0.11) + ang * 3.0));
  return (1.0 - smoothstep(width, width + 0.22, f)) * mix(0.55, 1.0, broken);
}
float dots(vec2 p, float spacing, float coverage) {
  float a = 0.785398;
  vec2 q = mat2(cos(a), -sin(a), sin(a), cos(a)) * p / spacing;
  vec2 cell = fract(q) - 0.5;
  float r = sqrt(clamp(coverage, 0.0, 1.0)) * 0.62;
  return 1.0 - smoothstep(r - 0.06, r + 0.06, length(cell));
}

void main() {
  vec4 col = texture2D(tColor, vUv);
  float cov = col.a;
  vec3 straight = cov > 0.0001 ? col.rgb / cov : vec3(0.0);

  if (uStyle == 0) {
    float e = edgeAt(vUv, uThickness);
    vec3 prem = toSRGB(straight) * cov;
    prem = prem * (1.0 - e) + uLine * e;
    float a = cov * (1.0 - e) + e;
    gl_FragColor = vec4(prem, a);
    return;
  }

  vec2 p = gl_FragCoord.xy / uScale;
  float lum = clamp(dot(straight, vec3(0.299, 0.587, 0.114)), 0.0, 1.0);
  lum = pow(lum, 1.0 / 2.2);
  vec2 wob = (vec2(noise(p * 0.08), noise(p * 0.08 + 17.0)) - 0.5) * 1.6 / uRes * uScale;
  float e = edgeAt(vUv + wob, uThickness);
  vec3 paper = uPaper * (0.955 + 0.045 * noise(p * 0.9)) * (0.985 + 0.015 * noise(p * vec2(0.02, 0.6)));
  vec3 c;
  float ink = 0.0;
  if (uStyle == 1) {
    float h1 = hatch(p, 0.785, 6.0, 0.16) * (1.0 - smoothstep(0.58, 0.8, lum));
    float h2 = hatch(p, -0.785, 6.0, 0.14) * (1.0 - smoothstep(0.36, 0.55, lum));
    float h3 = hatch(p, 0.2, 4.5, 0.12) * (1.0 - smoothstep(0.14, 0.3, lum));
    float shade = max(h1, max(h2, h3)) * cov;
    vec3 graphite = vec3(0.16, 0.16, 0.19);
    c = mix(paper, graphite, shade * 0.62);
    c = mix(c, graphite, e * 0.9);
    ink = max(shade * 0.62, e * 0.9);
  } else {
    float tone = (1.0 - smoothstep(0.42, 0.78, lum));
    float d = dots(p, 5.0, tone * 0.85) * step(0.18, lum);
    float solid = 1.0 - smoothstep(0.12, 0.2, lum);
    float shade = max(d, solid) * cov;
    c = mix(paper, vec3(0.04), shade);
    c = mix(c, vec3(0.02), e);
    ink = max(shade, e);
  }
  if (uTransparent > 0.5) {
    float a = max(ink, 0.0);
    gl_FragColor = vec4(vec3(0.05) * a, a);
  } else {
    gl_FragColor = vec4(c, 1.0);
  }
}`;

export class StylePost {
  constructor(renderer) {
    this.renderer = renderer;
    this.rtN = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    this.rtC = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: this.rtC.texture }, tND: { value: this.rtN.texture },
        uRes: { value: new THREE.Vector2(1, 1) }, uStyle: { value: 0 }, uThickness: { value: 1.5 }, uScale: { value: 1 },
        uTransparent: { value: 0 }, uLine: { value: new THREE.Color(0x231c26) }, uPaper: { value: new THREE.Color(0xf3efe6) },
        uDepthThreshold: { value: 0.012 },
      },
      vertexShader, fragmentShader, depthTest: false, depthWrite: false, transparent: false,
    });
    this.quad = new FullScreenQuad(this.material);
    this.size = new THREE.Vector2();
  }

  /**
   * @param {string} style 'anime' | 'pencil' | 'ink'
   * @param opts {scale: device px per CSS px, transparent: bool, lineWidth: CSS px}
   */
  render(scene, camera, modes, style, target = null, opts = {}) {
    const r = this.renderer;
    const size = target ? new THREE.Vector2(target.width, target.height) : r.getDrawingBufferSize(new THREE.Vector2());
    if (!size.equals(this.size)) {
      this.size.copy(size);
      this.rtN.setSize(size.x, size.y);
      this.rtC.setSize(size.x, size.y);
    }
    const prev = {
      mask: camera.layers.mask, bg: scene.background, env: scene.environment,
      color: r.getClearColor(new THREE.Color()), alpha: r.getClearAlpha(), target: r.getRenderTarget(),
    };

    // 1) normals + depth of the model only
    scene.background = null;
    camera.layers.set(0);
    r.setRenderTarget(this.rtN);
    r.setClearColor(0x000000, 0);
    r.clear();
    modes.with('prepass', () => r.render(scene, camera));

    // 2) color: cel shading (keeps floor helpers) or a plain lit pass for the drawing
    scene.environment = null;
    if (style === 'anime') { camera.layers.mask = prev.mask; scene.background = opts.transparent ? null : prev.bg; }
    r.setRenderTarget(this.rtC);
    r.setClearColor(0x000000, 0);
    r.clear();
    modes.with(style === 'anime' ? 'anime' : 'sketchShade', () => r.render(scene, camera));

    // 3) composite
    const u = this.material.uniforms;
    u.uRes.value.copy(size);
    u.uStyle.value = style === 'anime' ? 0 : style === 'ink' ? 2 : 1;
    const scale = opts.scale || 1;
    u.uScale.value = scale;
    u.uThickness.value = Math.max(1, (opts.lineWidth ?? (style === 'anime' ? 1.1 : 1.0)) * scale);
    u.uTransparent.value = opts.transparent ? 1 : 0;
    r.setRenderTarget(target);
    this.quad.render(r);

    camera.layers.mask = prev.mask;
    scene.background = prev.bg;
    scene.environment = prev.env;
    r.setClearColor(prev.color, prev.alpha);
    r.setRenderTarget(prev.target);
  }

  dispose() {
    this.rtN.dispose();
    this.rtC.dispose();
    this.material.dispose();
    this.quad.dispose();
  }
}
