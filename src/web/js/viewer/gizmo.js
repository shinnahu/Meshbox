import * as THREE from 'three';

const AXES = [
  { id: '+x', v: new THREE.Vector3(1, 0, 0), color: '#f0525f', label: 'X', pos: true },
  { id: '-x', v: new THREE.Vector3(-1, 0, 0), color: '#f0525f', label: '', pos: false },
  { id: '+y', v: new THREE.Vector3(0, 1, 0), color: '#6fd35b', label: 'Y', pos: true },
  { id: '-y', v: new THREE.Vector3(0, -1, 0), color: '#6fd35b', label: '', pos: false },
  { id: '+z', v: new THREE.Vector3(0, 0, 1), color: '#4f8dff', label: 'Z', pos: true },
  { id: '-z', v: new THREE.Vector3(0, 0, -1), color: '#4f8dff', label: '', pos: false },
];
const NS = 'http://www.w3.org/2000/svg';

/** Tripo/Blender-style axis gizmo drawn in SVG (never ends up in screenshots). Click an axis to look along it. */
export class AxisGizmo {
  constructor(container, onPick) {
    this.container = container;
    this.svg = document.createElementNS(NS, 'svg');
    this.svg.setAttribute('viewBox', '-46 -46 92 92');
    this.items = AXES.map((a) => {
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', 'ax' + (a.pos ? '' : ' neg'));
      const line = document.createElementNS(NS, 'line');
      line.setAttribute('stroke', a.color);
      line.setAttribute('stroke-width', a.pos ? '2.4' : '0');
      line.setAttribute('stroke-linecap', 'round');
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('r', a.pos ? '8' : '6');
      c.setAttribute('fill', a.pos ? a.color : 'rgba(30,31,34,.85)');
      c.setAttribute('stroke', a.color);
      c.setAttribute('stroke-width', a.pos ? '0' : '1.6');
      const t = document.createElementNS(NS, 'text');
      t.textContent = a.label;
      const title = document.createElementNS(NS, 'title');
      title.textContent = { '+x': 'Right (+X)', '-x': 'Left (-X)', '+y': 'Top (+Y)', '-y': 'Bottom (-Y)', '+z': 'Front (+Z, Unity forward)', '-z': 'Back (-Z)' }[a.id];
      g.append(title, line, c, t);
      g.addEventListener('click', (e) => { e.stopPropagation(); onPick(a.id); });
      this.svg.append(g);
      return { a, g, line, c, t };
    });
    container.append(this.svg);
    this.q = new THREE.Quaternion();
  }

  update(camera) {
    this.q.copy(camera.quaternion).invert();
    const R = 31;
    const placed = this.items.map((it) => {
      const v = it.a.v.clone().applyQuaternion(this.q);
      return { it, x: v.x * R, y: -v.y * R, z: v.z };
    }).sort((p, q) => p.z - q.z);
    for (const p of placed) {
      p.it.line.setAttribute('x1', '0'); p.it.line.setAttribute('y1', '0');
      p.it.line.setAttribute('x2', (p.x * 0.78).toFixed(2)); p.it.line.setAttribute('y2', (p.y * 0.78).toFixed(2));
      p.it.c.setAttribute('cx', p.x.toFixed(2)); p.it.c.setAttribute('cy', p.y.toFixed(2));
      p.it.t.setAttribute('x', p.x.toFixed(2)); p.it.t.setAttribute('y', (p.y + 0.5).toFixed(2));
      p.it.g.style.opacity = (0.55 + 0.45 * (p.z + 1) / 2).toFixed(2);
      this.svg.append(p.it.g); // depth order
    }
  }
}

/** Unit vector from target to camera for each named view. */
export function viewDirection(id) {
  switch (id) {
    case '+x': return new THREE.Vector3(1, 0, 0);
    case '-x': return new THREE.Vector3(-1, 0, 0);
    case '+y': return new THREE.Vector3(0, 1, 0.0001).normalize();
    case '-y': return new THREE.Vector3(0, -1, 0.0001).normalize();
    case '-z': return new THREE.Vector3(0, 0, -1);
    case '+z': return new THREE.Vector3(0, 0, 1);
    default: return null;
  }
}
