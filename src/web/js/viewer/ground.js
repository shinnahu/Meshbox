import * as THREE from 'three';
import { HorizontalBlurShader } from 'three/examples/jsm/shaders/HorizontalBlurShader.js';
import { VerticalBlurShader } from 'three/examples/jsm/shaders/VerticalBlurShader.js';

export const HELPER_LAYER = 1;

/** Infinite-looking floor grid (fades with distance) with red X / blue Z axes and a "front +Z" arrow. */
export class Grid extends THREE.Group {
  constructor() {
    super();
    this.name = '__grid';
    this.userData.helper = true;
    this.uniforms = {
      uCell: { value: 0.1 }, uMajor: { value: 1 },
      uColor: { value: new THREE.Color(0x7c7f87) }, uMajorColor: { value: new THREE.Color(0xa8abb3) },
      uFade: { value: 20 }, uCam: { value: new THREE.Vector3() }, uOpacity: { value: 1 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
      extensions: { derivatives: true },
      vertexShader: /* glsl */`
        varying vec3 vWorld;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */`
        uniform float uCell, uMajor, uFade, uOpacity;
        uniform vec3 uColor, uMajorColor, uCam;
        varying vec3 vWorld;
        float lines(vec2 p, float size, float width) {
          vec2 q = p / size;
          vec2 g = abs(fract(q - 0.5) - 0.5) / fwidth(q);
          return 1.0 - min(min(g.x, g.y) / width, 1.0);
        }
        void main() {
          vec2 p = vWorld.xz;
          float minor = lines(p, uCell, 1.0);
          float major = lines(p, uMajor, 1.3);
          vec2 ad = abs(p) / fwidth(p);
          float xAxis = 1.0 - min(ad.y / 1.6, 1.0);
          float zAxis = 1.0 - min(ad.x / 1.6, 1.0);
          float d = length(p - uCam.xz);
          float fade = 1.0 - smoothstep(uFade * 0.25, uFade, d);
          vec3 col = mix(uColor, uMajorColor, major);
          float a = max(minor * 0.22, major * 0.5);
          col = mix(col, vec3(0.93, 0.32, 0.38), xAxis); a = max(a, xAxis * 0.75);
          col = mix(col, vec3(0.32, 0.56, 1.0), zAxis); a = max(a, zAxis * 0.75);
          gl_FragColor = vec4(col, a * fade * uOpacity);
          if (gl_FragColor.a < 0.004) discard;
        }`,
    });
    this.plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), mat);
    this.plane.frustumCulled = false;
    this.plane.renderOrder = -2;
    this.add(this.plane);

    // Arrow on the floor pointing +Z: models should face it (Unity forward).
    const shape = new THREE.Shape();
    shape.moveTo(-0.16, 0); shape.lineTo(0.16, 0); shape.lineTo(0.16, 0.45); shape.lineTo(0.36, 0.45);
    shape.lineTo(0, 0.9); shape.lineTo(-0.36, 0.45); shape.lineTo(-0.16, 0.45); shape.closePath();
    const arrowGeo = new THREE.ShapeGeometry(shape).rotateX(Math.PI / 2);
    this.arrow = new THREE.Mesh(arrowGeo, new THREE.MeshBasicMaterial({ color: 0x5290ff, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
    this.arrow.renderOrder = -1;
    this.add(this.arrow);
    this.traverse((o) => o.layers.set(HELPER_LAYER));
  }

  /** Size the grid to the model: minor cells ≈ 1/10 of a major cell sized to the model. */
  fit(size, footprintRadius) {
    const s = Math.max(size, 1e-4);
    const major = Math.pow(10, Math.round(Math.log10(s / 2)));
    this.uniforms.uMajor.value = major;
    this.uniforms.uCell.value = major / 10;
    this.uniforms.uFade.value = Math.max(major * 12, s * 6);
    this.plane.scale.setScalar(this.uniforms.uFade.value * 2.2);
    const a = Math.max(footprintRadius * 0.35, major * 0.12);
    this.arrow.scale.setScalar(a);
    this.arrow.position.set(0, 0.0005 * s, footprintRadius + a * 0.35);
    this.major = major;
  }

  update(camera) { this.uniforms.uCam.value.copy(camera.position); }
}

/**
 * Soft ground shadow independent of the lighting (the three.js "contact shadows" technique):
 * render the model's depth from below into a small target, blur it, show it on a floor plane.
 */
export class ContactShadow extends THREE.Group {
  constructor(renderer) {
    super();
    this.name = '__shadow';
    this.userData.helper = true;
    this.renderer = renderer;
    this.size = 512;
    this.rt = new THREE.WebGLRenderTarget(this.size, this.size);
    this.rt.texture.generateMipmaps = false;
    this.rtBlur = new THREE.WebGLRenderTarget(this.size, this.size);
    this.rtBlur.texture.generateMipmaps = false;
    this.opacity = 0.6;
    this.blur = 2.5;
    this.darkness = 1.4;

    const planeMat = new THREE.MeshBasicMaterial({ map: this.rt.texture, opacity: this.opacity, transparent: true, depthWrite: false, toneMapped: false });
    this.plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(Math.PI / 2), planeMat);
    this.plane.scale.y = -1; // the depth camera looks up; flip so it lines up with the model
    this.plane.renderOrder = -3;
    this.plane.layers.set(HELPER_LAYER);
    this.add(this.plane);

    this.blurPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(Math.PI / 2));
    this.blurPlane.visible = false;
    this.add(this.blurPlane);
    this.camera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 1);
    this.camera.rotation.x = Math.PI / 2; // look up
    this.add(this.camera);

    this.depthMat = new THREE.MeshDepthMaterial();
    this.depthMat.userData.darkness = { value: this.darkness };
    this.depthMat.onBeforeCompile = (shader) => {
      shader.uniforms.darkness = this.depthMat.userData.darkness;
      shader.fragmentShader = `uniform float darkness;\n${shader.fragmentShader.replace(
        'gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );',
        'gl_FragColor = vec4( vec3( 0.0 ), ( 1.0 - fragCoordZ ) * darkness );')}`;
    };
    this.depthMat.depthTest = false;
    this.depthMat.depthWrite = false;
    this.hBlur = new THREE.ShaderMaterial(HorizontalBlurShader);
    this.hBlur.depthTest = false;
    this.vBlur = new THREE.ShaderMaterial(VerticalBlurShader);
    this.vBlur.depthTest = false;
  }

  fit(width, depth, height) {
    const w = Math.max(width, depth) * 1.9 + 0.001;
    this.plane.scale.set(w, -1, w);      // y = -1 flips the plane to face up (the depth image is seen from below)
    this.blurPlane.scale.set(w, 1, w);   // fills the shadow camera's view exactly
    Object.assign(this.camera, { left: -w / 2, right: w / 2, top: w / 2, bottom: -w / 2, near: 0, far: Math.max(height, 1e-3) * 0.9 });
    this.camera.updateProjectionMatrix();
    this.extent = w;
  }

  /** Re-render the shadow map. `scene` must contain the model; helpers are hidden meanwhile. */
  update(scene, modelLayerMask = 1) {
    const r = this.renderer;
    const prev = { target: r.getRenderTarget(), bg: scene.background, override: scene.overrideMaterial, alpha: r.getClearAlpha(), autoClear: r.autoClear };
    const clear = new THREE.Color();
    r.getClearColor(clear);
    this.plane.visible = false;
    scene.background = null;
    scene.overrideMaterial = this.depthMat;
    this.depthMat.userData.darkness.value = this.darkness;
    this.camera.layers.mask = modelLayerMask;
    r.setClearColor(0x000000, 0);
    r.setRenderTarget(this.rt);
    r.clear();
    r.render(scene, this.camera);
    scene.overrideMaterial = null;

    this.blurPass(this.blur);
    this.blurPass(this.blur * 0.4);

    scene.overrideMaterial = prev.override;
    scene.background = prev.bg;
    r.setRenderTarget(prev.target);
    r.setClearColor(clear, prev.alpha);
    this.plane.visible = true;
  }

  blurPass(amount) {
    const r = this.renderer;
    this.blurPlane.visible = true;
    this.blurPlane.material = this.hBlur;
    this.hBlur.uniforms.tDiffuse.value = this.rt.texture;
    this.hBlur.uniforms.h.value = amount / 256;
    r.setRenderTarget(this.rtBlur);
    r.render(this.blurPlane, this.camera);
    this.blurPlane.material = this.vBlur;
    this.vBlur.uniforms.tDiffuse.value = this.rtBlur.texture;
    this.vBlur.uniforms.v.value = amount / 256;
    r.setRenderTarget(this.rt);
    r.render(this.blurPlane, this.camera);
    this.blurPlane.visible = false;
  }

  setOpacity(v) { this.plane.material.opacity = v; }

  dispose() {
    this.rt.dispose(); this.rtBlur.dispose();
    this.plane.geometry.dispose(); this.plane.material.dispose();
    this.depthMat.dispose(); this.hBlur.dispose(); this.vBlur.dispose();
  }
}
