import { icon, hydrateIcons } from './icons.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Tiny hyperscript: h('button.btn.primary', {onclick, title}, 'Text', child...). `html:` sets innerHTML. */
export function h(tag, props = {}, ...children) {
  const m = tag.match(/^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i);
  const el = document.createElement(m?.[1] || 'div');
  for (const part of (m?.[2] || '').match(/[.#][\w-]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1)); else el.id = part.slice(1);
  }
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) { children.unshift(props); props = {}; }
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className += (el.className ? ' ' : '') + v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function ic(name, size = 18, cls = '') {
  const t = document.createElement('template');
  t.innerHTML = icon(name, size, cls);
  return t.content.firstElementChild || document.createElement('span');
}

export function clear(el) { while (el.firstChild) el.firstChild.remove(); return el; }
export function setChildren(el, ...children) { clear(el); append(el, children); hydrateIcons(el); return el; }

// ---------------------------------------------------------------- formatting
export function fmtBytes(n) {
  if (n == null || n < 0) return '-';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
}
export const fmtNum = (n) => (n == null ? '-' : Math.round(n).toLocaleString('en-US'));
// Lengths are shown in centimeters or inches (Settings / the Size page). Values stay in meters.
let lengthUnit = 'cm';
export function setLengthUnit(u) { lengthUnit = u === 'in' ? 'in' : 'cm'; }
export const lengthUnitLabel = () => lengthUnit;
/** meters → number in the chosen unit (for inputs) and back. */
export const toUnit = (m) => lengthUnit === 'in' ? m / 0.0254 : m * 100;
export const fromUnit = (v) => lengthUnit === 'in' ? v * 0.0254 : v / 100;

/** A length in meters, written in the chosen unit: "56.0 cm" / "22.0 in" (m, km or ft for big ones). */
export function fmtCm(m) {
  if (m == null || !isFinite(m)) return '-';
  if (lengthUnit === 'in') {
    const inch = m / 0.0254;
    if (inch >= 1200) return `${(inch / 12).toFixed(0)} ft`;
    if (inch >= 10) return `${inch.toFixed(1)} in`;
    return `${inch.toFixed(2)} in`;
  }
  const cm = m * 100;
  if (cm >= 100000) return `${(m / 1000).toFixed(1)} km`;
  if (cm >= 1000) return `${m.toFixed(2)} m`;
  if (cm >= 10) return `${cm.toFixed(1)} cm`;
  return `${cm.toFixed(2)} cm`;
}
export function fmtDate(d) {
  if (!d) return '';
  const date = new Date(d);
  if (isNaN(date)) return '';
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
export function fmtDateTime(d) {
  const date = new Date(d);
  if (isNaN(date)) return '';
  return date.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
export function fmtTime(s) {
  if (!isFinite(s)) s = 0;
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${String(m).padStart(2, '0')}:${sec.toFixed(1).padStart(4, '0')}`;
}
export function timeAgo(d) {
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} days ago`;
  return fmtDate(d);
}

export function debounce(fn, ms = 200) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function store(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem('bv.' + key) ?? 'null');
    localStorage.setItem('bv.' + key, JSON.stringify(value));
  } catch { return null; }
}

// ---------------------------------------------------------------- toast
export function toast(message, opts = {}) {
  const { kind = '', action, timeout = kind === 'bad' ? 9000 : 4200 } = opts;
  const box = $('#toasts');
  const el = h('div.toast' + (kind ? '.' + kind : ''),
    kind === 'bad' ? ic('alert', 17) : kind === 'ok' ? ic('check-circle', 17) : null,
    h('span.msg', message));
  if (action) {
    el.append(h('button.btn.small', { onclick: () => { action.fn(); close(); } }, action.label));
  }
  el.append(h('button.icon-btn', { style: { width: '26px', height: '26px' }, onclick: () => close(), 'aria-label': 'Dismiss' }, ic('x', 15)));
  box.append(el);
  let timer = setTimeout(close, timeout);
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  el.addEventListener('mouseleave', () => { timer = setTimeout(close, 2500); });
  function close() { clearTimeout(timer); el.remove(); }
  while (box.children.length > 4) box.firstChild.remove();
  return close;
}

// ---------------------------------------------------------------- context menu
let openMenuEl = null;
export function closeMenu() { openMenuEl?.remove(); openMenuEl = null; }
/** items: [{label, icon, hint, onClick, disabled, danger, checked}] | '-' | {header: 'Label'} */
export function showMenu(x, y, items, { minWidth } = {}) {
  closeMenu();
  const menu = h('div.menu', { role: 'menu', style: minWidth ? { minWidth: minWidth + 'px' } : null });
  for (const it of items) {
    if (!it) continue;
    if (it === '-') { menu.append(h('div.menu-sep')); continue; }
    if (it.header) { menu.append(h('div.menu-label', it.header)); continue; }
    const b = h('button.menu-item' + (it.danger ? '.danger' : '') + (it.checked ? '.checked' : ''), {
      role: 'menuitem', disabled: !!it.disabled,
      onclick: (e) => { e.stopPropagation(); closeMenu(); it.onClick?.(); },
    }, it.checked ? ic('check', 16) : it.icon ? ic(it.icon, 16) : h('span', { style: { width: '16px' } }), h('span.ellipsis', it.label), it.hint ? h('span.hint', it.hint) : null);
    menu.append(b);
  }
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  const vx = Math.min(x, window.innerWidth - r.width - 8);
  const vy = y + r.height > window.innerHeight - 8 ? Math.max(8, y - r.height) : y;
  menu.style.left = Math.max(8, vx) + 'px';
  menu.style.top = vy + 'px';
  openMenuEl = menu;
  return menu;
}
export function menuAt(el, items, opts) {
  const r = el.getBoundingClientRect();
  return showMenu(r.left, r.bottom + 6, items, opts);
}
document.addEventListener('pointerdown', (e) => { if (openMenuEl && !openMenuEl.contains(e.target)) closeMenu(); }, true);
window.addEventListener('blur', closeMenu);
window.addEventListener('resize', closeMenu);

// ---------------------------------------------------------------- popovers (anchored panels)
let openPop = null;
export function closePopover() { openPop?.close(); }
export function popover(anchor, content, { container, onClose, placement = 'left' } = {}) {
  if (openPop?.anchor === anchor) { closePopover(); return null; }
  closePopover();
  const parent = container || anchor.offsetParent || document.body;
  const pop = h('div.pop', content);
  parent.append(pop);
  hydrateIcons(pop);
  const pr = parent.getBoundingClientRect();
  const ar = anchor.getBoundingClientRect();
  const r = pop.getBoundingClientRect();
  let left, top;
  if (placement === 'left') { left = ar.left - pr.left - r.width - 10; top = ar.top - pr.top - 6; }
  else { left = ar.left - pr.left + ar.width / 2 - r.width / 2; top = ar.top - pr.top - r.height - 12; }
  left = Math.max(8, Math.min(left, pr.width - r.width - 8));
  top = Math.max(8, Math.min(top, pr.height - r.height - 8));
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
  anchor.classList.add('on');
  const onDown = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) close(); };
  setTimeout(() => document.addEventListener('pointerdown', onDown, true));
  function close() {
    pop.remove();
    anchor.classList.remove('on');
    document.removeEventListener('pointerdown', onDown, true);
    if (openPop?.pop === pop) openPop = null;
    onClose?.();
  }
  openPop = { pop, anchor, close };
  return openPop;
}

// ---------------------------------------------------------------- modal
export function modal({ title, subtitle, body, wide, buttons = [], footNote, onClose, dismissable = true }) {
  const foot = h('div.modal-foot');
  const bodyEl = h('div.modal-body', body);
  const head = h('div.modal-head', h('div.grow', h('h3', title), subtitle ? h('p', subtitle) : null),
    dismissable ? h('button.icon-btn', { onclick: () => close(), 'aria-label': 'Close' }, ic('x')) : null);
  const box = h('div.modal' + (wide ? '.wide' : ''), { role: 'dialog', 'aria-modal': 'true' }, head, bodyEl, foot);
  const backdrop = h('div.modal-backdrop', box);
  if (dismissable) backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop) close(); });
  const onKey = (e) => { if (e.key === 'Escape' && dismissable) { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  document.body.append(backdrop);
  let closed = false;
  function setButtons(list, note) {
    clear(foot);
    if (note) foot.append(h('span.left', note));
    for (const b of list) {
      const el = h('button.btn' + (b.kind ? '.' + b.kind : ''), {
        disabled: !!b.disabled,
        onclick: async () => {
          if (!b.onClick) return close();
          const keep = await b.onClick(api);
          if (keep !== false && keep !== 'keep') close();
        },
      }, b.icon ? ic(b.icon, 16) : null, b.label);
      foot.append(el);
    }
  }
  function close(result) {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    backdrop.remove();
    onClose?.(result);
  }
  const api = {
    el: box, body: bodyEl, close, setButtons,
    setBody: (...c) => setChildren(bodyEl, ...c),
    setTitle: (t, s) => { head.querySelector('h3').textContent = t; if (s != null) { const p = head.querySelector('p'); if (p) p.textContent = s; } },
  };
  setButtons(buttons, footNote);
  hydrateIcons(box);
  setTimeout(() => box.querySelector('input, select, textarea, .btn.primary')?.focus(), 30);
  return api;
}

export function confirmDialog({ title, message, details, confirmLabel = 'OK', cancelLabel = 'Cancel', danger }) {
  return new Promise((resolve) => {
    let result = false;
    modal({
      title,
      body: h('div.col', typeof message === 'string' ? h('p.note', { style: { fontSize: '14px', color: 'var(--text)', margin: 0 } }, message) : message, details || null),
      buttons: [
        { label: cancelLabel, kind: 'ghost' },
        { label: confirmLabel, kind: danger ? 'danger' : 'primary', onClick: () => { result = true; } },
      ],
      onClose: () => resolve(result),
    });
  });
}

export function promptDialog({ title, label, value = '', placeholder = '', confirmLabel = 'OK' }) {
  return new Promise((resolve) => {
    let result = null;
    const input = h('input.input', { value, placeholder });
    const m = modal({
      title,
      body: h('div.field', label ? h('label', label) : null, input),
      buttons: [{ label: 'Cancel', kind: 'ghost' }, { label: confirmLabel, kind: 'primary', onClick: () => { result = input.value; } }],
      onClose: () => resolve(result),
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { result = input.value; m.close(); } });
  });
}

export function toggleRow(label, sub, on, onChange) {
  const sw = h('span.switch' + (on ? '.on' : ''));
  const row = h('div.toggle-row', { role: 'switch', tabindex: 0, 'aria-checked': String(!!on) },
    h('span.label', h('span', label), sub ? h('small', sub) : null), sw);
  const flip = () => {
    const v = !sw.classList.contains('on');
    sw.classList.toggle('on', v);
    row.setAttribute('aria-checked', String(v));
    onChange(v);
  };
  row.addEventListener('click', flip);
  row.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); } });
  row.setValue = (v) => { sw.classList.toggle('on', !!v); row.setAttribute('aria-checked', String(!!v)); };
  return row;
}

export function seg(options, value, onChange) {
  const el = h('div.seg');
  for (const o of options) {
    const b = h('button' + (o.value === value ? '.on' : ''), { type: 'button', 'data-tip': o.tip || null, onclick: () => {
      el.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      onChange(o.value);
    } }, o.icon ? ic(o.icon, 15) : null, o.label);
    b._value = o.value;
    el.append(b);
  }
  el.setValue = (v) => el.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x._value === v));
  return el;
}

// "?" next to a label: the explanation shows in a small box on hover / focus instead of filling the panel.
let helpBox = null;
export function help(text) {
  const dot = h('span.help-dot', { role: 'button', tabindex: 0, 'aria-label': 'Help: ' + text }, '?');
  const show = () => {
    helpBox ??= document.body.appendChild(h('div.help-box', { role: 'tooltip' }));
    helpBox.textContent = text;
    helpBox.hidden = false;
    const r = dot.getBoundingClientRect(), b = helpBox.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left + r.width / 2 - b.width / 2, innerWidth - b.width - 8));
    const top = r.bottom + 8 + b.height > innerHeight - 8 ? r.top - b.height - 8 : r.bottom + 8;
    helpBox.style.left = left + 'px';
    helpBox.style.top = top + 'px';
  };
  const hide = () => { if (helpBox) helpBox.hidden = true; };
  dot.addEventListener('mouseenter', show);
  dot.addEventListener('mouseleave', hide);
  dot.addEventListener('focus', show);
  dot.addEventListener('blur', hide);
  dot.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); show(); });
  return dot;
}

/**
 * Slider + number field. With `def` (the default value): a mark on the track shows where the default is,
 * a reset button appears once the value differs, and double-clicking the slider resets it.
 * The returned row has setValue(v) to follow outside changes (undo) without calling onInput.
 */
export function sliderRow(min, max, step, value, onInput, { fmt = (v) => v, def = null } = {}) {
  const range = h('input.range', { type: 'range', min, max, step, value });
  const num = h('input.input.num', { type: 'number', min, max, step, value: fmt(value) });
  const hasDef = def != null;
  const pct = hasDef ? ((def - min) / (max - min)) * 100 : 0;
  // the thumb (16px) travels from 8px to width-8px, so the mark is offset the same way
  const mark = hasDef ? h('span.slider-default', { style: { left: `calc(${pct}% + ${8 - (pct / 100) * 16}px)` } }) : null;
  const reset = hasDef ? h('button.slider-reset', { type: 'button', 'aria-label': `Reset to ${fmt(def)}`, 'data-tip': `Reset to ${fmt(def)} (default)` }, ic('rotate-ccw', 13)) : null;
  const track = h('div.slider-track', mark, range);
  if (hasDef) track.dataset.tip = `Default ${fmt(def)} · double-click to reset`;
  const row = h('div.slider-row' + (hasDef ? '.has-reset' : ''), track, num, reset);
  const show = (v) => {
    range.value = v;
    num.value = fmt(+v);
    reset?.classList.toggle('show', Math.abs(+v - def) > step / 2);
  };
  // onInput(value, { merge, seal }): dragging joins one undo step until the slider is released
  const commit = (v, how = {}) => { show(v); onInput(+v, how); };
  range.addEventListener('input', () => commit(+range.value, { merge: true }));
  range.addEventListener('change', () => commit(+range.value, { merge: true, seal: true }));
  num.addEventListener('change', () => commit(Math.min(max, Math.max(min, +num.value || 0))));
  if (hasDef) {
    reset.addEventListener('click', () => commit(def));
    range.addEventListener('dblclick', () => commit(def));
  }
  row.setValue = show;
  show(value);
  return row;
}
