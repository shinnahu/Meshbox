import * as THREE from 'three';

/** Free navigation: drag to look around, WASD/arrows to move, Q/E down/up, Shift faster, wheel = speed. */
export class FlyControls {
  constructor(camera, dom) {
    this.camera = camera;
    this.dom = dom;
    this.enabled = false;
    this.keys = new Set();
    this.speed = 1;
    this.baseSpeed = 1;
    this.yaw = 0;
    this.pitch = 0;
    this.dragging = false;
    this.onDown = this.onDown.bind(this);
    this.onMove = this.onMove.bind(this);
    this.onUp = this.onUp.bind(this);
    this.onKey = this.onKey.bind(this);
    this.onWheel = this.onWheel.bind(this);
    this.onBlur = () => this.keys.clear();
  }

  setEnabled(on, sceneSize = 1) {
    if (on === this.enabled) return;
    this.enabled = on;
    if (on) {
      this.baseSpeed = Math.max(0.05, sceneSize * 0.6);
      this.speed = this.baseSpeed;
      const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
      this.yaw = e.y; this.pitch = e.x;
      this.dom.addEventListener('pointerdown', this.onDown);
      this.dom.addEventListener('wheel', this.onWheel, { passive: false });
      window.addEventListener('keydown', this.onKey);
      window.addEventListener('keyup', this.onKey);
      window.addEventListener('blur', this.onBlur);
    } else {
      this.dom.removeEventListener('pointerdown', this.onDown);
      this.dom.removeEventListener('wheel', this.onWheel);
      window.removeEventListener('keydown', this.onKey);
      window.removeEventListener('keyup', this.onKey);
      window.removeEventListener('blur', this.onBlur);
      this.keys.clear();
    }
  }

  onDown(e) {
    if (e.button !== 0 && e.button !== 2) return;
    this.dragging = true;
    this.dom.setPointerCapture(e.pointerId);
    this.dom.addEventListener('pointermove', this.onMove);
    this.dom.addEventListener('pointerup', this.onUp);
    this.dom.addEventListener('pointercancel', this.onUp);
  }
  onMove(e) {
    if (!this.dragging) return;
    this.yaw -= e.movementX * 0.0035;
    this.pitch = THREE.MathUtils.clamp(this.pitch - e.movementY * 0.0035, -1.55, 1.55);
    this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
    this.changed = true;
  }
  onUp(e) {
    this.dragging = false;
    try { this.dom.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    this.dom.removeEventListener('pointermove', this.onMove);
    this.dom.removeEventListener('pointerup', this.onUp);
    this.dom.removeEventListener('pointercancel', this.onUp);
  }
  onKey(e) {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const k = e.code;
    if (!['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight', 'Space', 'KeyC'].includes(k)) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.type === 'keydown') this.keys.add(k); else this.keys.delete(k);
    if (k !== 'ShiftLeft' && k !== 'ShiftRight') e.preventDefault();
  }
  onWheel(e) {
    e.preventDefault();
    this.speed = THREE.MathUtils.clamp(this.speed * (e.deltaY < 0 ? 1.15 : 1 / 1.15), this.baseSpeed * 0.02, this.baseSpeed * 50);
  }

  update(dt) {
    if (!this.enabled) return false;
    const k = this.keys;
    const f = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    const r = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const u = (k.has('KeyE') || k.has('Space') ? 1 : 0) - (k.has('KeyQ') || k.has('KeyC') ? 1 : 0);
    let moved = this.changed;
    this.changed = false;
    if (f || r || u) {
      const boost = k.has('ShiftLeft') || k.has('ShiftRight') ? 3 : 1;
      const step = this.speed * boost * dt;
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
      this.camera.position.addScaledVector(fwd, f * step).addScaledVector(right, r * step);
      this.camera.position.y += u * step;
      moved = true;
    }
    return moved;
  }

  /** A point in front of the camera, to hand back to orbit mode. */
  focusPoint(distance) {
    return new THREE.Vector3(0, 0, -distance).applyQuaternion(this.camera.quaternion).add(this.camera.position);
  }
}
