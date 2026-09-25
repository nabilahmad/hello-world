/** Window-level controller: tabs, toolbar, status bar, settings and host wiring. */
import { DISPLAY_UNITS, Formatter, INSUNITS, formatNumber } from '../geom/measure';
import type { DocRef, Host } from '../host/host';
import { parseInWorker, warmUp } from '../view/loader';
import { DocView, type Theme, Viewer } from '../view/viewer';
import { LayersPanel } from './layers';
import { type MenuItem, showMenu } from './menu';
import { TabStrip } from './tabs';

interface Tab {
  ref: DocRef;
  status: 'loading' | 'ready' | 'error';
  error?: string;
  doc?: DocView;
}

interface Settings {
  theme: Theme;
  dims: boolean;
  includeAnnotation: boolean;
  /** Display unit ($INSUNITS code), 0 = drawing units. */
  units: number;
  /** Maximum decimals, -1 = from the drawing ($LUPREC). */
  precision: number;
  layersOpen: boolean;
}

const SETTINGS_KEY = 'dxf-viewer.settings';
const APP_NAME = 'DXF Viewer';
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl+';

function loadSettings(): Settings {
  const defaults: Settings = {
    theme: matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark',
    dims: true,
    includeAnnotation: false,
    units: 0,
    precision: -1,
    layersOpen: false,
  };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return defaults;
  }
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

export class App {
  private tabs: Tab[] = [];
  private active: string | null = null;
  private readonly settings = loadSettings();
  private readonly viewer: Viewer;
  private readonly strip: TabStrip;
  private readonly layers: LayersPanel;
  /** Models of tabs that just moved to another window, kept briefly in case they come back. */
  private readonly released = new Map<string, { doc: DocView; at: number }>();
  private status = { cursor: '', extents: '', zoom: '' };

  constructor(private readonly host: Host) {
    this.viewer = new Viewer($('#stage'), this.viewerSettings(), new Formatter({ drawing: 0, display: 0, precision: 3 }));
    this.viewer.onChange = () => this.updateStatus();
    this.strip = new TabStrip($('#tabs'), {
      activate: (id) => this.activate(id),
      close: (id) => this.closeTab(id),
      reorder: (ids) => this.reorder(ids),
      dragOut: (id, gx, gy, detach) => this.dragOut(id, gx, gy, detach),
      dragMove: () => void this.host.dragMove(),
      dragEnd: () => void this.host.dragEnd(),
      dragCancel: () => void this.host.dragCancel(),
      contextMenu: (id, x, y) => this.tabMenu(id, x, y),
      openFile: () => void this.host.openDialog(),
    });
    this.strip.multiWindow = host.multiWindow;
    this.layers = new LayersPanel($('#layers-panel'), (vis) => {
      const doc = this.current()?.doc;
      if (!doc) return;
      doc.setLayerVisibility(vis);
      this.layers.render(doc, this.settings.theme);
      this.viewer.invalidate();
    });
    this.bindChrome();
    this.applySettings();
  }

  async start(): Promise<void> {
    warmUp();
    const docs = await this.host.init({
      adopt: (docs, at) => this.adopt(docs, at),
      dropHover: (x, name) => this.strip.showDropMarker(x, name),
      fileDrag: (active) => ($('#drop-overlay').hidden = !active),
    });
    if (docs.length) this.adopt(docs, null);
    this.render();
    this.reportLayout();
  }

  // ---- tabs -----------------------------------------------------------------

  private current(): Tab | undefined {
    return this.tabs.find((t) => t.ref.id === this.active);
  }

  adopt(docs: DocRef[], at: { x?: number; index?: number } | null): void {
    this.strip.showDropMarker(null);
    const now = Date.now();
    for (const [id, r] of this.released) if (now - r.at > 60_000) this.released.delete(id);
    let index = at?.index ?? (at?.x !== undefined ? this.strip.insertionPoint(at.x).index : this.tabs.length);
    index = Math.max(0, Math.min(this.tabs.length, index));
    let first: string | null = null;
    for (const ref of docs) {
      const existing = this.tabs.find((t) => t.ref.id === ref.id);
      if (existing) {
        first ??= ref.id;
        continue;
      }
      const tab: Tab = { ref, status: 'loading' };
      this.tabs.splice(index++, 0, tab);
      first ??= ref.id;
      void this.load(tab);
    }
    if (first) this.activate(first);
    else this.render();
  }

  private async load(tab: Tab): Promise<void> {
    try {
      const cached = this.released.get(tab.ref.id);
      if (cached) {
        this.released.delete(tab.ref.id);
        tab.doc = cached.doc;
      } else {
        const bytes = await this.host.read(tab.ref);
        tab.doc = new DocView(await parseInWorker(bytes));
      }
      if (tab.ref.view) tab.doc.view = { ...tab.ref.view };
      tab.status = 'ready';
    } catch (err) {
      tab.status = 'error';
      tab.error = err instanceof Error ? err.message : String(err);
      console.error(`Failed to open ${tab.ref.name}`, err);
    }
    if (!this.tabs.includes(tab)) return;
    if (tab.ref.id === this.active) this.show();
    this.render();
  }

  activate(id: string): void {
    if (!this.tabs.some((t) => t.ref.id === id)) return;
    this.active = id;
    this.show();
    this.render();
  }

  private show(): void {
    const tab = this.current();
    const doc = tab?.status === 'ready' ? tab.doc! : null;
    this.viewer.fmt = this.formatter(doc);
    this.viewer.setDoc(doc);
    this.layers.render(doc, this.settings.theme);
    this.syncUnitsUi(doc);
    const info = doc?.model.info;
    const skipped = info ? Object.entries(info.skipped).filter(([k]) => k !== 'VIEWPORT') : [];
    $('#st-info').textContent = info
      ? `${info.entityCount.toLocaleString()} entities · ${Math.round(info.parseMs + info.flattenMs)} ms` +
        (info.version ? ` · ${info.version}` : '')
      : '';
    $('#st-info').title = skipped.length ? `Not drawn: ${skipped.map(([k, n]) => `${k} ×${n}`).join(', ')}` : '';
    this.host.setTitle(tab ? `${tab.ref.name} — ${APP_NAME}` : APP_NAME);
    this.updateStatus();
  }

  closeTab(id: string): void {
    const i = this.tabs.findIndex((t) => t.ref.id === id);
    if (i < 0) return;
    this.tabs.splice(i, 1);
    this.host.closeDoc(id);
    this.afterRemoval(id, i);
  }

  /** Removes a tab that now lives in another window (its model is kept for a minute). */
  private releaseTab(id: string): void {
    const i = this.tabs.findIndex((t) => t.ref.id === id);
    if (i < 0) return;
    const [tab] = this.tabs.splice(i, 1);
    if (tab.doc) this.released.set(id, { doc: tab.doc, at: Date.now() });
    this.afterRemoval(id, i);
  }

  private afterRemoval(id: string, index: number): void {
    if (this.active === id) {
      const next = this.tabs[Math.min(index, this.tabs.length - 1)];
      this.active = next?.ref.id ?? null;
      this.show();
    }
    this.render();
  }

  private reorder(ids: string[]): void {
    const pos = new Map(ids.map((id, i) => [id, i]));
    this.tabs.sort((a, b) => (pos.get(a.ref.id) ?? 0) - (pos.get(b.ref.id) ?? 0));
    this.host.reorder(ids);
    this.render();
  }

  private refWithView(tab: Tab): DocRef {
    const view = tab.doc?.view;
    return { ...tab.ref, view: view ? { ...view } : tab.ref.view };
  }

  private async dragOut(id: string, grabX: number, grabY: number, detach: boolean): Promise<boolean> {
    const tab = this.tabs.find((t) => t.ref.id === id);
    if (!tab) return false;
    const ok = await this.host.dragBegin({ doc: this.refWithView(tab), grabX, grabY, detach });
    if (ok && detach) this.releaseTab(id);
    return ok;
  }

  private tabMenu(id: string, x: number, y: number): void {
    const tab = this.tabs.find((t) => t.ref.id === id);
    if (!tab) return;
    const items: Array<MenuItem | '-'> = [];
    if (this.host.multiWindow) {
      items.push({
        label: 'Move to new window',
        disabled: this.tabs.length < 2,
        action: async () => {
          await this.host.moveToNewWindow(this.refWithView(tab));
          this.releaseTab(id);
        },
      });
      items.push({ label: 'Merge all windows here', action: () => void this.host.mergeAllWindows() });
      items.push('-');
    }
    if (tab.ref.path) {
      items.push({ label: 'Copy file path', action: () => void navigator.clipboard?.writeText(tab.ref.path!) });
      items.push('-');
    }
    items.push({ label: 'Close other tabs', disabled: this.tabs.length < 2, action: () => this.tabs.filter((t) => t !== tab).forEach((t) => this.closeTab(t.ref.id)) });
    items.push({ label: 'Close tab', shortcut: `${MOD}W`, action: () => this.closeTab(id) });
    showMenu(x, y, items);
  }

  // ---- rendering ----------------------------------------------------------------

  private render(): void {
    this.renderTabs();
    const tab = this.current();
    $('#empty').hidden = this.tabs.length > 0;
    $('#loading').hidden = tab?.status !== 'loading';
    $('#loading-name').textContent = tab?.ref.name ?? '';
    const err = $('#error');
    err.hidden = tab?.status !== 'error';
    if (tab?.status === 'error') $('#error-text').textContent = `Could not open ${tab.ref.name}: ${tab.error}`;
    $('#status').classList.toggle('idle', !tab || tab.status !== 'ready');
  }

  private renderTabs(): void {
    this.strip.render(
      this.tabs.map((t) => ({ id: t.ref.id, name: t.ref.name, title: t.ref.path ?? t.ref.name, status: t.status })),
      this.active,
    );
    $('#loading').hidden = this.current()?.status !== 'loading';
  }

  private reportLayout(): void {
    this.host.reportLayout($('#tabbar').getBoundingClientRect());
  }

  private updateStatus(): void {
    const doc = this.viewer.doc;
    const fmt = this.viewer.fmt;
    const set = (key: 'cursor' | 'extents' | 'zoom', sel: string, text: string) => {
      if (this.status[key] !== text) {
        this.status[key] = text;
        $(sel).textContent = text;
      }
    };
    const c = this.viewer.cursor;
    set('cursor', '#st-cursor', c && doc ? `X ${fmt.coord(c[0])}   Y ${fmt.coord(c[1])}` : '');
    const box = doc?.extents(this.settings.includeAnnotation);
    set('extents', '#st-extents', box ? `${fmt.length(box[2] - box[0])} × ${fmt.length(box[3] - box[1])}` : '');
    set('zoom', '#st-zoom', doc?.view && doc.fitScale ? `${formatNumber((doc.view.scale / doc.fitScale) * 100, 0)}%` : '');
  }

  // ---- settings -----------------------------------------------------------------

  private viewerSettings() {
    return { theme: this.settings.theme, dims: this.settings.dims, includeAnnotation: this.settings.includeAnnotation };
  }

  private formatter(doc: DocView | null): Formatter {
    const info = doc?.model.info;
    const precision =
      this.settings.precision >= 0 ? this.settings.precision : info && info.precision >= 0 ? Math.min(info.precision, 6) : 3;
    return new Formatter({ drawing: info?.insunits ?? 0, display: this.settings.units, precision });
  }

  private saveSettings(): void {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      /* storage unavailable */
    }
  }

  private applySettings(): void {
    const s = this.settings;
    document.documentElement.dataset.theme = s.theme;
    $('#btn-dims').classList.toggle('on', s.dims);
    $('#btn-dims').setAttribute('aria-pressed', String(s.dims));
    $('#btn-layers').classList.toggle('on', s.layersOpen);
    $('#btn-layers').setAttribute('aria-pressed', String(s.layersOpen));
    $('#layers-panel').hidden = !s.layersOpen;
    $<HTMLInputElement>('#chk-annot').checked = s.includeAnnotation;
    Object.assign(this.viewer.settings, this.viewerSettings());
    this.viewer.fmt = this.formatter(this.viewer.doc);
    this.layers.render(this.viewer.doc, s.theme);
    this.viewer.invalidate();
    this.viewer.refreshTooltip();
    this.updateStatus();
    this.saveSettings();
  }

  private syncUnitsUi(doc: DocView | null): void {
    const sel = $<HTMLSelectElement>('#sel-units');
    const code = doc?.model.info.insunits ?? 0;
    const unit = INSUNITS[code];
    sel.options[0].textContent = unit ? `Drawing (${unit.abbr})` : 'Unitless';
    sel.value = String(this.settings.units);
    const prec = $<HTMLSelectElement>('#sel-prec');
    const auto = doc && doc.model.info.precision >= 0 ? Math.min(doc.model.info.precision, 6) : 3;
    prec.options[0].textContent = `Auto (${auto})`;
    prec.value = String(this.settings.precision);
  }

  private bindChrome(): void {
    const units = $<HTMLSelectElement>('#sel-units');
    for (const code of DISPLAY_UNITS) units.append(new Option(INSUNITS[code].abbr, String(code)));
    units.addEventListener('change', () => {
      this.settings.units = Number(units.value);
      this.applySettings();
    });
    const prec = $<HTMLSelectElement>('#sel-prec');
    for (let p = 0; p <= 6; p++) prec.append(new Option(`${p} decimals`, String(p)));
    prec.addEventListener('change', () => {
      this.settings.precision = Number(prec.value);
      this.applySettings();
    });
    $('#chk-annot').addEventListener('change', (e) => {
      this.settings.includeAnnotation = (e.target as HTMLInputElement).checked;
      this.applySettings();
    });

    $('#btn-open').addEventListener('click', () => void this.host.openDialog());
    $('#btn-empty-open').addEventListener('click', () => void this.host.openDialog());
    $('#btn-fit').addEventListener('click', () => this.viewer.fit());
    $('#btn-dims').addEventListener('click', () => this.toggle('dims'));
    $('#btn-layers').addEventListener('click', () => this.toggle('layersOpen'));
    $('#btn-theme').addEventListener('click', () => {
      this.settings.theme = this.settings.theme === 'dark' ? 'light' : 'dark';
      this.applySettings();
    });
    $('#empty-shortcut').textContent = `${MOD}O`;

    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('resize', () => this.reportLayout());

    // Browser build: files dropped from the OS (the desktop build gets them natively).
    if (this.host.dropFiles) {
      let depth = 0;
      const overlay = $('#drop-overlay');
      const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
      window.addEventListener('dragenter', (e) => {
        if (!hasFiles(e)) return;
        depth++;
        overlay.hidden = false;
      });
      window.addEventListener('dragleave', (e) => {
        if (!hasFiles(e)) return;
        if (--depth <= 0) overlay.hidden = true;
      });
      window.addEventListener('dragover', (e) => {
        if (hasFiles(e)) e.preventDefault();
      });
      window.addEventListener('drop', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth = 0;
        overlay.hidden = true;
        this.host.dropFiles!([...e.dataTransfer!.files]);
      });
    }
  }

  private toggle(key: 'dims' | 'layersOpen'): void {
    this.settings[key] = !this.settings[key];
    this.applySettings();
  }

  private onKey(e: KeyboardEvent): void {
    const target = e.target as HTMLElement;
    if (target.closest('input, select, textarea') && e.key !== 'Escape') return;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const key = e.key.toLowerCase();
    if (mod && key === 'o') {
      e.preventDefault();
      void this.host.openDialog();
    } else if (mod && key === 'w') {
      e.preventDefault();
      if (this.active) this.closeTab(this.active);
    } else if ((e.ctrlKey && key === 'tab') || (mod && (key === 'pagedown' || key === 'pageup'))) {
      e.preventDefault();
      const back = e.shiftKey || key === 'pageup';
      const i = this.tabs.findIndex((t) => t.ref.id === this.active);
      const next = this.tabs[(i + (back ? -1 : 1) + this.tabs.length) % this.tabs.length];
      if (next) this.activate(next.ref.id);
    } else if (!mod && !e.altKey) {
      const pan = 80;
      switch (e.key) {
        case 'f':
        case 'F':
        case 'Home':
          this.viewer.fit();
          break;
        case 'd':
        case 'D':
          this.toggle('dims');
          break;
        case 'l':
        case 'L':
          this.toggle('layersOpen');
          break;
        case '+':
        case '=':
          this.viewer.zoomAt(1.25);
          break;
        case '-':
        case '_':
          this.viewer.zoomAt(0.8);
          break;
        case 'ArrowLeft':
          this.viewer.panBy(pan, 0);
          break;
        case 'ArrowRight':
          this.viewer.panBy(-pan, 0);
          break;
        case 'ArrowUp':
          this.viewer.panBy(0, pan);
          break;
        case 'ArrowDown':
          this.viewer.panBy(0, -pan);
          break;
        default:
          return;
      }
      e.preventDefault();
    }
  }
}
