// Undo / redo for the viewer's look: sliders, toggles, view modes, environment...
// A slider drag (many small changes of one setting in a row) becomes a single step.

/** Settings that Ctrl+Z / Ctrl+Y walk through, with the names shown in the "Undo: ..." toast. */
export const SETTING_LABELS = {
  env: 'Environment', envStrength: 'HDRI strength', envRotation: 'HDRI rotation', envAutoRotate: 'HDRI auto rotate',
  background: 'Background', bgBlur: 'Background blur', bgColor: 'Background color', exposure: 'Exposure',
  toneMapping: 'Tone mapping', grid: 'Grid', gizmo: '3D gizmo', stats: 'Topology', dims: 'Size & facing',
  shadow: 'Ground shadow', viewMode: 'View', wireframe: 'Wireframe', flat: 'Flat shading', sketchVariant: 'Sketch style',
  ortho: 'Orthographic', turntable: 'Turntable', importedLights: 'Lights from the file',
  bloom: 'Bloom', bloomStrength: 'Bloom strength', bloomRadius: 'Bloom radius', bloomThreshold: 'Bloom threshold',
};

const MERGE_MS = 800;

export class SettingsHistory {
  constructor(limit = 200) {
    this.limit = limit;
    this.undoStack = [];
    this.redoStack = [];
  }

  /**
   * Remember `changes` (key → new value) against the current settings, before they are applied.
   * merge: part of a continuous gesture (slider drag) that joins the previous step of the same setting;
   * seal: the gesture ended (slider released), so the next change starts a new step.
   */
  record(changes, current, { merge = false, seal = false } = {}) {
    const from = {}, to = {};
    for (const [k, v] of Object.entries(changes)) {
      if (k in SETTING_LABELS && current[k] !== v) { from[k] = current[k]; to[k] = v; }
    }
    const keys = Object.keys(to).sort().join(',');
    const last = this.undoStack[this.undoStack.length - 1];
    if (!keys) { if (seal && last) last.sealed = true; return; }
    const now = performance.now();
    if (merge && last && last.merge && !last.sealed && last.keys === keys && now - last.time < MERGE_MS) {
      Object.assign(last.to, to);
      last.time = now;
      if (Object.keys(last.to).every((k) => last.to[k] === last.from[k])) this.undoStack.pop();   // dragged back to the start
    } else {
      this.undoStack.push({ keys, from, to, time: now, merge });
      if (this.undoStack.length > this.limit) this.undoStack.shift();
    }
    const top = this.undoStack[this.undoStack.length - 1];
    if (seal && top) top.sealed = true;
    this.redoStack.length = 0;
  }

  undo() { const e = this.undoStack.pop(); if (e) { e.sealed = true; this.redoStack.push(e); } return e || null; }
  redo() { const e = this.redoStack.pop(); if (e) { e.sealed = true; this.undoStack.push(e); } return e || null; }
}

const DEGREES = new Set(['envRotation']);
const show = (k, v) => typeof v === 'number' ? (DEGREES.has(k) ? `${Math.round(v)}°` : v.toFixed(2))
  : typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v);

/** "Exposure 1.40 → 1.00" for an undo/redo toast; `dir` is 'from' (undo) or 'to' (redo). */
export function describeChange(entry, dir) {
  const other = dir === 'from' ? 'to' : 'from';
  return Object.keys(entry[dir]).map((k) => `${SETTING_LABELS[k] || k} ${show(k, entry[other][k])} → ${show(k, entry[dir][k])}`).join(', ');
}
