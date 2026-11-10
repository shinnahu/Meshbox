import { app } from '../app.js';
import { h, ic, modal, setChildren, toggleRow, seg, toast, confirmDialog } from '../dom.js';
import { call, newJobId, on as onHost } from '../host.js';

export function openSettings() {
  const body = h('div');
  const m = modal({ title: 'Settings', wide: true, body, buttons: [{ label: 'Done', kind: 'primary' }] });
  render();

  async function save(patch) {
    app.host.settings = await call('settings.set', { patch });
  }

  function folderList(title, list, key, help) {
    const box = h('div.list', { style: { background: 'var(--panel)', borderRadius: '8px', padding: '4px', marginBottom: '6px' } });
    if (!list.length) box.append(h('div.note', { style: { padding: '8px' } }, 'None yet.'));
    list.forEach((dir, i) => box.append(h('div.list-item', ic('folder', 15), h('span.name.sel', dir),
      h('button.icon-btn', { style: { width: '28px', height: '28px' }, 'aria-label': 'Remove', onclick: async () => { const next = list.filter((_, j) => j !== i); await save({ [key]: next }); render(); } }, ic('x', 15)))));
    return h('div.field', h('label', title), help ? h('div.note', { style: { marginTop: '-2px', marginBottom: '4px' } }, help) : null, box,
      h('div', h('button.btn.small', { onclick: async () => {
        const dir = await call('dialog.folder', { title });
        if (dir && !list.some((d) => d.toLowerCase() === dir.toLowerCase())) { await save({ [key]: [...list, dir] }); render(); }
      } }, ic('plus', 15), 'Add folder…')));
  }

  async function render() {
    const s = app.host.settings;
    const blenders = await call('blender.installs', { refresh: false }).catch(() => []);
    const v = app.viewer.settings;
    setChildren(body,
      h('div.section', h('div.section-label', ic('library', 14), 'Library'),
        h('div.field', h('label', 'Library folder (where organized assets go)'),
          h('div.input-group', h('input.input.sel', { readOnly: true, value: s.libraryRoot || '', placeholder: 'Not set - e.g. E:\\3D Library' }),
            h('button.btn', { onclick: async () => {
              const dir = await call('dialog.folder', { title: 'Library folder', initialDir: s.libraryRoot || undefined });
              if (dir) { await save({ libraryRoot: dir }); render(); }
            } }, 'Choose…')),
          h('div.note', 'One place for every project: Project \\ Category \\ Asset \\ (Asset.blend, Asset.fbx, Textures, Versions). Pick a drive with free space.')),
        folderList('Also scan these folders', s.scanRoots || [], 'scanRoots', 'Project folders that are not organized yet (e.g. D:\\MyGame\\3D Models).'),
        folderList('Texture folders', s.textureFolders || [], 'textureFolders', 'Searched when a model asks for a texture that is not next to it.'),
        h('div.field', h('label', 'Thumbnail angle'), seg([{ value: 'front', label: 'Front (+Z)' }, { value: 'threeQuarter', label: 'Three-quarter' }], v.thumbAngle, (x) => app.viewer.set('thumbAngle', x))),
      ),
      h('div.section', h('div.section-label', ic('blender', 14), 'Blender'),
        blenders.length ? h('div.list', { style: { background: 'var(--panel)', borderRadius: '8px', padding: '4px' } },
          ...blenders.map((b, i) => h('label.list-item', { style: { cursor: 'pointer' } },
            h('input', { type: 'radio', name: 'blender', checked: s.blenderPath ? s.blenderPath.toLowerCase() === b.path.toLowerCase() : i === 0, onchange: async () => { await save({ blenderPath: i === 0 && !s.blenderPath ? null : b.path }); app.host.blender = await call('blender.installs', { refresh: true }); render(); } }),
            h('span.name', `Blender ${b.version}`), h('span.meta.sel', b.path), h('span.chip', b.source))))
          : h('div.banner.warn', ic('alert', 16), h('div', 'No Blender found. .blend previews and FBX export need it.')),
        h('div.btn-row', { style: { marginTop: '8px' } },
          h('button.btn.small', { onclick: async () => {
            const f = await call('dialog.open', { title: 'Find blender.exe', filters: [{ name: 'Blender', exts: ['exe'] }] });
            if (f?.[0]) { await save({ blenderPath: f[0] }); app.host.blender = await call('blender.installs', { refresh: true }); render(); }
          } }, ic('folder-open', 15), 'Browse for blender.exe…'),
          h('button.btn.small', { onclick: () => installAddon() }, ic('history', 15), 'Install “Save Milestone” add-on…')),
        h('div.note', { style: { marginTop: '6px' } }, 'The newest Blender is used by default (newer versions open older files, not the other way round).')),
      h('div.section', h('div.section-label', ic('ruler', 14), 'Units'),
        h('div.field', h('label', 'Show lengths in'), seg([{ value: 'cm', label: 'Centimeters' }, { value: 'in', label: 'Inches' }], app.prefs.units || 'cm', (u) => app.actions.setUnits(u))),
        h('div.note', 'Only changes how sizes are shown and typed. FBX files are still exported in Unity units (1 unit = 1 m).')),
      h('div.section', h('div.section-label', ic('app-window', 14), 'Windows'),
        toggleRow('Show in “Open with” for 3D files', 'FBX, BLEND, GLB, OBJ… (your defaults stay as they are)', app.host.shellRegistered, async (on) => {
          app.host.shellRegistered = await call(on ? 'shell.register' : 'shell.unregister');
          toast(on ? 'Added to “Open with”. To make it the default for .fbx: right-click a file → Open with → Choose another app → Always.' : 'Removed from “Open with”.', { timeout: 8000 });
        }),
        toggleRow('Files opened from Explorer get their own window', 'Off: they replace the model in the last window', s.openInNewWindow, (on) => save({ openInNewWindow: on })),
        h('div.field', { style: { marginTop: '8px' } }, h('label', 'Screenshots folder'),
          h('div.input-group', h('input.input.sel', { readOnly: true, value: s.screenshotDir || app.host.screenshotDir }),
            h('button.btn', { onclick: async () => { const d = await call('dialog.folder', { title: 'Screenshots folder' }); if (d) { await save({ screenshotDir: d }); app.host.screenshotDir = d; render(); } } }, 'Choose…'))),
      ),
      h('div.section', h('div.section-label', ic('info', 14), 'About'),
        h('div.note', `Meshbox ${app.host.version} · three.js r187 · WebView2.`),
        h('div.note', 'HDRIs: Studio Small 09, Spiaggia di Mondello, Goegap, Forest Slope, Lebombo, Satara Night - Poly Haven, CC0.'),
        h('div.btn-row', { style: { marginTop: '8px' } },
          h('button.btn.small', { onclick: () => call('fs.reveal', { path: app.host.dataDir }) }, ic('folder', 15), 'Open data folder (cache, thumbnails)'))),
    );
  }

  async function installAddon() {
    const blenders = app.host.blender || [];
    if (!blenders.length) return toast('No Blender found.', { kind: 'bad' });
    const target = blenders.find((b) => app.host.settings.blenderPath && b.path.toLowerCase() === app.host.settings.blenderPath.toLowerCase()) || blenders[0];
    const ok = await confirmDialog({
      title: `Install the milestone add-on in Blender ${target.version}?`,
      message: h('div.col', h('p.note', { style: { margin: 0, color: 'var(--text)', fontSize: '14px' } }, 'Adds File → “Save Milestone…” to Blender: you keep working on one file (Hero.blend) and each milestone is copied, compressed, into a Versions folder next to it with a note - instead of Hero1, Hero2, Hero3final…'),
        h('p.note', { style: { margin: 0 } }, 'It copies one .py file into Blender’s add-ons folder and enables it in your Blender preferences. You can disable it from Blender’s Preferences → Add-ons.')),
      confirmLabel: 'Install',
    });
    if (!ok) return;
    const jobId = newJobId();
    const close = toast('Installing the add-on…', { timeout: 60000 });
    const off = onHost('job.progress', () => {});
    try {
      const r = await call('blender.installAddon', { jobId, blenderPath: target.path });
      close();
      toast(`Installed in Blender ${target.version}${r?.installedTo ? ` (${r.installedTo})` : ''}. Restart Blender to see File → Save Milestone.`, { kind: 'ok', timeout: 9000 });
    } catch (e) {
      close();
      toast(e.message, { kind: 'bad' });
    } finally { off(); }
  }
  return m;
}
