/**
 * Canvas viewer: a base canvas with the drawing (redrawn on pan/zoom) and an
 * overlay canvas for the bounding-box dimensions and the hover highlight
 * (redrawn on mouse moves, which keeps hovering cheap on big drawings).
 */
import Flatbush from 'flatbush';
import { groupVisibility, visibleExtents } from '../geom/extents';
import { hitDistance, type Formatter } from '../geom/measure';
import { type BBox, FG, HIT_ARC, HIT_LINE, HIT_STRIDE, type RenderModel } from '../geom/model';
import type { ViewState } from '../host/host';
import { type Description, describeHit } from './describe';
import { buildPath } from './loader';

export type Theme = 'dark' | 'light';

interface Palette {
  bg: string;
  fg: string;
  accent: string;
  accentText: string;
  hover: string;
  hoverSoft: string;
  bbox: string;
}

export const PALETTES: Record<Theme, Palette> = {
  dark: {
    bg: '#1d1f23',
    fg: '#e8e8e8',
    accent: '#58a6ff',
    accentText: '#08121f',
    hover: '#ffb224',
    hoverSoft: 'rgba(255, 178, 36, 0.32)',
    bbox: 'rgba(88, 166, 255, 0.5)',
  },
  light: {
    bg: '#ffffff',
    fg: '#171717',
    accent: '#0b62d6',
    accentText: '#ffffff',
    hover: '#e2570b',
    hoverSoft: 'rgba(226, 87, 11, 0.28)',
    bbox: 'rgba(11, 98, 214, 0.5)',
  },
};

const FONT = 'Arial, "Liberation Sans", "Helvetica Neue", Helvetica, sans-serif';
/** Cap height / em of the fonts above (DXF text height is the cap height). */
const CAP = 0.716;
const REF = 100; // reference font size for text layout
const DIM_GAP = 30;
/** Path numbers per frame above which interactive pan/zoom uses a snapshot. */
const HEAVY_WORK = 300_000;
const ARROW = 8;

function luminance(rgb: number): number {
  const ch = [(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

const hex = (rgb: number) => '#' + rgb.toString(16).padStart(6, '0');

/** CSS colour for a drawing colour, nudged away from the background when it would vanish. */
export function displayColor(c: number, theme: Theme): string {
  if (c === FG) return PALETTES[theme].fg;
  const bgL = theme === 'dark' ? luminance(0x1d1f23) : 1;
  const target = theme === 'dark' ? 255 : 0;
  let rgb = c;
  for (let step = 0; step < 8; step++) {
    const L = luminance(rgb);
    const ratio = (Math.max(L, bgL) + 0.05) / (Math.min(L, bgL) + 0.05);
    if (ratio >= 2.6) break;
    const mix = (v: number) => Math.round(v + (target - v) * 0.25);
    rgb = (mix((rgb >> 16) & 255) << 16) | (mix((rgb >> 8) & 255) << 8) | mix(rgb & 255);
  }
  return hex(rgb);
}

/** A document prepared for display; lives as long as its tab. */
export class DocView {
  readonly paths: (Path2D | null)[];
  layerVisible: boolean[];
  groupVisible: boolean[];
  view: ViewState | null = null;
  /** Scale of the fitted view (0 = not computed yet); zoom % is relative to it. */
  fitScale = 0;
  readonly index: Flatbush | null;
  private entHits: { start: Int32Array; list: Int32Array } | null = null;
  private extCache: Array<BBox | null | undefined> = [undefined, undefined];
  textCache: Array<{ w: number[]; wrapped?: string[] } | undefined> = [];
  colors: { theme: Theme | null; batch: string[]; text: string[] } = { theme: null, batch: [], text: [] };

  constructor(readonly model: RenderModel) {
    this.paths = model.batches.map(() => null);
    this.layerVisible = model.layers.map((l) => l.visible);
    this.groupVisible = groupVisibility(model, this.layerVisible);
    this.index = model.hits.index ? Flatbush.from(model.hits.index) : null;
  }

  path(i: number): Path2D {
    return (this.paths[i] ??= buildPath(this.model.batches[i]));
  }

  setLayerVisibility(visible: boolean[]): void {
    this.layerVisible = visible;
    this.groupVisible = groupVisibility(this.model, visible);
    this.extCache = [undefined, undefined];
  }

  extents(includeAnnotation: boolean): BBox | null {
    const k = includeAnnotation ? 1 : 0;
    if (this.extCache[k] === undefined) this.extCache[k] = visibleExtents(this.model, this.groupVisible, includeAnnotation);
    return this.extCache[k]!;
  }

  /** All hit primitives of an entity (e.g. every segment of a polyline). */
  hitsOfEntity(ent: number): Int32Array {
    if (!this.entHits) {
      const h = this.model.hits;
      const n = this.model.entities.length;
      const start = new Int32Array(n + 1);
      for (let i = 0; i < h.count; i++) start[h.ent[i] + 1]++;
      for (let i = 0; i < n; i++) start[i + 1] += start[i];
      const fill = start.slice(0, n);
      const list = new Int32Array(h.count);
      for (let i = 0; i < h.count; i++) list[fill[h.ent[i]]++] = i;
      this.entHits = { start, list };
    }
    return this.entHits.list.subarray(this.entHits.start[ent], this.entHits.start[ent + 1]);
  }

  ensureColors(theme: Theme): void {
    if (this.colors.theme === theme) return;
    const memo = new Map<number, string>();
    const css = (c: number) => {
      let v = memo.get(c);
      if (v === undefined) memo.set(c, (v = displayColor(c, theme)));
      return v;
    };
    this.colors = {
      theme,
      batch: this.model.batches.map((b) => css(b.color)),
      text: this.model.texts.map((t) => css(t.color)),
    };
  }
}

export interface ViewerSettings {
  theme: Theme;
  dims: boolean;
  /** Include text and dimensions in the measured bounding box. */
  includeAnnotation: boolean;
}

export class Viewer {
  doc: DocView | null = null;
  settings: ViewerSettings;
  fmt: Formatter;
  /** Called (at most once per frame) when the view, cursor or hover changes. */
  onChange: () => void = () => {};
  /** Cursor position in drawing coordinates. */
  cursor: [number, number] | null = null;
  hover = -1;

  private readonly base: HTMLCanvasElement;
  private readonly over: HTMLCanvasElement;
  private readonly tip: HTMLDivElement;
  private W = 0;
  private H = 0;
  private dpr = 1;
  private mouse: { x: number; y: number } | null = null;
  private raf = 0;
  private dirtyBase = true;
  private dirtyOver = true;
  private dirtyHover = false;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pan: { id: number; x: number; y: number; moved: boolean } | null = null;
  private pinch: { d: number; x: number; y: number } | null = null;
  private lastBaseMs = 0;
  /** The last full frame was expensive: pan/zoom from a snapshot until the view settles. */
  private heavy = false;
  private snap: { canvas: HTMLCanvasElement; view: ViewState } | null = null;
  private interacting = false;
  private settleTimer = 0;
  private description: Description | null = null;

  constructor(
    private readonly stage: HTMLElement,
    settings: ViewerSettings,
    fmt: Formatter,
  ) {
    this.settings = settings;
    this.fmt = fmt;
    this.base = document.createElement('canvas');
    this.base.className = 'layer-base';
    this.over = document.createElement('canvas');
    this.over.className = 'layer-overlay';
    this.tip = document.createElement('div');
    this.tip.className = 'tooltip';
    this.tip.hidden = true;
    stage.prepend(this.base, this.over, this.tip);

    const o = this.over;
    o.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    o.addEventListener('pointermove', (e) => this.onPointerMove(e));
    o.addEventListener('pointerup', (e) => this.onPointerUp(e));
    o.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    o.addEventListener('pointerleave', () => {
      if (this.pan) return;
      this.mouse = null;
      this.cursor = null;
      this.setHover(-1);
      this.schedule();
    });
    o.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    o.addEventListener('dblclick', () => this.fit());
    o.addEventListener('contextmenu', (e) => e.preventDefault());
    new ResizeObserver(() => this.resize()).observe(stage);
    this.resize();
  }

  setDoc(doc: DocView | null): void {
    this.doc = doc;
    this.hover = -1;
    this.description = null;
    this.snap = null;
    this.tip.hidden = true;
    if (doc && this.W > 1) {
      if (!doc.view) this.fit();
      // A view that came from another window: the zoom % is relative to this window's fit.
      else if (!doc.fitScale) doc.fitScale = this.fitView(doc).scale;
    }
    this.invalidate();
  }

  invalidate(): void {
    this.dirtyBase = true;
    this.dirtyOver = true;
    this.snap = null;
    this.schedule();
  }

  invalidateOverlay(): void {
    this.dirtyOver = true;
    this.schedule();
  }

  refreshTooltip(): void {
    if (this.hover >= 0 && this.doc) {
      this.description = describeHit(this.doc.model, this.hover, this.fmt);
      this.renderTip();
    }
    this.invalidateOverlay();
  }

  private schedule(): void {
    if (!this.raf) this.raf = requestAnimationFrame(() => this.frame());
  }

  private frame(): void {
    this.raf = 0;
    if (this.dirtyHover) {
      this.dirtyHover = false;
      this.updateHover();
    }
    if (this.dirtyBase) {
      this.dirtyBase = false;
      this.drawBase();
    }
    if (this.dirtyOver) {
      this.dirtyOver = false;
      this.drawOverlay();
    }
    this.onChange();
  }

  private resize(): void {
    const r = this.stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(r.width));
    const H = Math.max(1, Math.round(r.height));
    if (W === this.W && H === this.H && dpr === this.dpr) return;
    this.W = W;
    this.H = H;
    this.dpr = dpr;
    for (const c of [this.base, this.over]) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
      c.style.width = `${W}px`;
      c.style.height = `${H}px`;
    }
    if (this.doc && !this.doc.view) this.fit();
    else if (this.doc && !this.doc.fitScale) this.doc.fitScale = this.fitView(this.doc).scale;
    this.invalidate();
  }

  // ---- view transform ----------------------------------------------------

  toLocal(sx: number, sy: number): [number, number] {
    const v = this.doc!.view!;
    return [v.cx + (sx - this.W / 2) / v.scale, v.cy - (sy - this.H / 2) / v.scale];
  }

  toScreen(x: number, y: number): [number, number] {
    const v = this.doc!.view!;
    return [(x - v.cx) * v.scale + this.W / 2, this.H / 2 - (y - v.cy) * v.scale];
  }

  /** The view that shows the whole drawing, leaving room for the dimension lines. */
  private fitView(d: DocView): ViewState {
    const box = d.extents(true);
    if (!box) return { cx: 0, cy: 0, scale: 1 };
    const dims = this.settings.dims;
    const ml = 28;
    const mt = 28;
    const mr = 28 + (dims ? 64 : 0);
    const mb = 28 + (dims ? 48 : 0);
    const w = box[2] - box[0];
    const h = box[3] - box[1];
    const aw = Math.max(20, this.W - ml - mr);
    const ah = Math.max(20, this.H - mt - mb);
    let s = Math.min(w > 0 ? aw / w : Infinity, h > 0 ? ah / h : Infinity);
    if (!Number.isFinite(s)) s = 1;
    return {
      cx: (box[0] + box[2]) / 2 + (mr - ml) / (2 * s),
      cy: (box[1] + box[3]) / 2 - (mb - mt) / (2 * s),
      scale: s,
    };
  }

  fit(): void {
    const d = this.doc;
    if (!d || this.W < 2) return;
    d.view = this.fitView(d);
    d.fitScale = d.view.scale;
    this.hover = -1;
    this.tip.hidden = true;
    this.invalidate();
  }

  zoomAt(factor: number, sx = this.W / 2, sy = this.H / 2): void {
    const d = this.doc;
    if (!d?.view) return;
    const v = d.view;
    const [wx, wy] = this.toLocal(sx, sy);
    const base = d.fitScale || v.scale;
    const s = Math.min(base * 1e7, Math.max(base * 1e-3, v.scale * factor));
    v.cx = wx - (sx - this.W / 2) / s;
    v.cy = wy + (sy - this.H / 2) / s;
    v.scale = s;
    this.interact();
  }

  panBy(dx: number, dy: number): void {
    const v = this.doc?.view;
    if (!v) return;
    v.cx -= dx / v.scale;
    v.cy += dy / v.scale;
    this.interact();
  }

  /** Marks an interactive view change: heavy drawings redraw from a snapshot until it settles. */
  private interact(): void {
    this.interacting = true;
    clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => {
      this.interacting = false;
      this.invalidate();
    }, 140);
    this.dirtyBase = true;
    this.dirtyOver = true;
    this.dirtyHover = true;
    this.schedule();
  }

  // ---- input ---------------------------------------------------------------

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0 && e.button !== 1) return;
    this.over.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (this.pointers.size === 1) {
      this.pan = { id: e.pointerId, x: e.offsetX, y: e.offsetY, moved: false };
    } else if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      this.pan = null;
    }
    if (e.button === 1) e.preventDefault();
  }

  private onPointerMove(e: PointerEvent): void {
    const x = e.offsetX;
    const y = e.offsetY;
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x, y });
    this.mouse = { x, y };
    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      if (this.pinch.d > 0) this.zoomAt(d / this.pinch.d, mx, my);
      this.panBy(mx - this.pinch.x, my - this.pinch.y);
      this.pinch = { d, x: mx, y: my };
      return;
    }
    const p = this.pan;
    if (p && p.id === e.pointerId) {
      const dx = x - p.x;
      const dy = y - p.y;
      if (!p.moved && Math.hypot(dx, dy) < 3) return;
      if (!p.moved) {
        p.moved = true;
        this.over.classList.add('panning');
        this.setHover(-1);
      }
      p.x = x;
      p.y = y;
      this.panBy(dx, dy);
      return;
    }
    this.dirtyHover = true;
    this.schedule();
  }

  private onPointerUp(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (this.pan?.id === e.pointerId || this.pointers.size === 0) {
      this.pan = null;
      this.over.classList.remove('panning');
      this.dirtyHover = true;
      this.schedule();
    }
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    if (!this.doc?.view) return;
    const unit = e.deltaMode === 1 ? 32 : e.deltaMode === 2 ? this.H : 1;
    // Trackpad pinch arrives as ctrl+wheel with small deltas.
    const k = e.ctrlKey ? 0.01 : 0.0018;
    this.zoomAt(Math.exp(-e.deltaY * unit * k), e.offsetX, e.offsetY);
  }

  // ---- hover ---------------------------------------------------------------

  private setHover(i: number): void {
    if (i === this.hover) return;
    this.hover = i;
    this.description = i >= 0 && this.doc ? describeHit(this.doc.model, i, this.fmt) : null;
    this.renderTip();
    this.dirtyOver = true;
    this.schedule();
  }

  private updateHover(): void {
    const d = this.doc;
    if (!d?.view || !this.mouse) {
      this.cursor = null;
      this.setHover(-1);
      return;
    }
    const [x, y] = this.toLocal(this.mouse.x, this.mouse.y);
    this.cursor = [x + d.model.origin[0], y + d.model.origin[1]];
    if (!d.index || this.pan?.moved || this.pinch) {
      this.setHover(-1);
      return;
    }
    const tol = 7 / d.view.scale;
    const h = d.model.hits;
    let best = -1;
    let bestD = tol;
    for (const i of d.index.search(x - tol, y - tol, x + tol, y + tol)) {
      if (!d.groupVisible[h.group[i]]) continue;
      const dist = hitDistance(h, i, x, y);
      if (dist < bestD || (dist === bestD && best < 0)) {
        best = i;
        bestD = dist;
      }
    }
    this.setHover(best);
    this.placeTip();
  }

  private renderTip(): void {
    const desc = this.description;
    if (!desc) {
      this.tip.hidden = true;
      return;
    }
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    this.tip.innerHTML =
      `<div class="tt-title">${esc(desc.title)}</div>` +
      `<div class="tt-sub">${esc(desc.subtitle)}</div>` +
      `<table>${desc.rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>`;
    this.tip.hidden = false;
    this.placeTip();
  }

  private placeTip(): void {
    if (this.tip.hidden || !this.mouse) return;
    const w = this.tip.offsetWidth;
    const h = this.tip.offsetHeight;
    let x = this.mouse.x + 18;
    let y = this.mouse.y + 20;
    if (x + w > this.W - 8) x = this.mouse.x - w - 14;
    if (y + h > this.H - 8) y = this.mouse.y - h - 14;
    this.tip.style.transform = `translate(${Math.max(4, x)}px, ${Math.max(4, y)}px)`;
  }

  // ---- drawing ---------------------------------------------------------------

  private drawBase(): void {
    const t0 = performance.now();
    const ctx = this.base.getContext('2d')!;
    const pal = PALETTES[this.settings.theme];
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = pal.bg;
    ctx.fillRect(0, 0, this.base.width, this.base.height);
    const d = this.doc;
    if (!d?.view) return;
    const v = d.view;

    // Heavy drawing being panned/zoomed: move the last full frame around instead.
    if (this.interacting && this.snap && this.heavy) {
      const sv = this.snap.view;
      const k = v.scale / sv.scale;
      const dpr = this.dpr;
      ctx.setTransform(
        k,
        0,
        0,
        k,
        dpr * ((this.W / 2) * (1 - k) + (sv.cx - v.cx) * v.scale),
        dpr * ((this.H / 2) * (1 - k) - (sv.cy - v.cy) * v.scale),
      );
      ctx.drawImage(this.snap.canvas, 0, 0);
      return;
    }

    d.ensureColors(this.settings.theme);
    const s = v.scale;
    const k = s * this.dpr;
    ctx.setTransform(k, 0, 0, -k, this.dpr * (this.W / 2 - v.cx * s), this.dpr * (this.H / 2 + v.cy * s));
    const x0 = v.cx - this.W / 2 / s;
    const x1 = v.cx + this.W / 2 / s;
    const y0 = v.cy - this.H / 2 / s;
    const y1 = v.cy + this.H / 2 / s;
    const hair = 1 / s;
    ctx.lineJoin = 'round';
    const batches = d.model.batches;
    const gv = d.groupVisible;
    // Canvas rasterises asynchronously, so estimate the cost from the work submitted.
    let work = 0;
    for (let i = 0; i < batches.length; i++) {
      const b = batches[i];
      if (!gv[b.group] || b.cmds.length === 0) continue;
      const bb = b.bbox;
      if (bb[0] > x1 || bb[2] < x0 || bb[1] > y1 || bb[3] < y0) continue;
      const color = d.colors.batch[i];
      const path = d.path(i);
      work += b.cmds.length;
      if (b.fill) {
        ctx.globalAlpha = b.alpha;
        ctx.fillStyle = color;
        ctx.fill(path, 'evenodd');
        ctx.globalAlpha = 1;
        continue;
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = b.width > 0 ? Math.max(b.width, hair) : hair;
      ctx.lineCap = b.roundCap ? 'round' : 'butt';
      if (b.dash) {
        let period = 0;
        for (const x of b.dash) period += x;
        // Dashes smaller than a few pixels only cost time and look solid anyway.
        ctx.setLineDash(period * s >= 6 ? b.dash.map((x) => (x > 0 ? x : hair)) : []);
      } else {
        ctx.setLineDash([]);
      }
      ctx.stroke(path);
    }
    ctx.setLineDash([]);
    ctx.lineCap = 'butt';

    // Points and text in screen space.
    const dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (let i = 0; i < batches.length; i++) {
      const b = batches[i];
      if (!b.points || !gv[b.group]) continue;
      ctx.fillStyle = d.colors.batch[i];
      const p = b.points;
      for (let j = 0; j < p.length; j += 2) {
        const sx = (p[j] - v.cx) * s + this.W / 2;
        const sy = this.H / 2 - (p[j + 1] - v.cy) * s;
        if (sx < -2 || sy < -2 || sx > this.W + 2 || sy > this.H + 2) continue;
        ctx.fillRect(sx - 1.5, sy - 1.5, 3, 3);
      }
    }
    this.drawTexts(ctx, d, x0, y0, x1, y1);

    this.lastBaseMs = performance.now() - t0;
    this.heavy = work > HEAVY_WORK || this.lastBaseMs > 28;
    if (this.heavy) {
      const snap = this.snap?.canvas ?? document.createElement('canvas');
      snap.width = this.base.width;
      snap.height = this.base.height;
      snap.getContext('2d')!.drawImage(this.base, 0, 0);
      this.snap = { canvas: snap, view: { ...v } };
    } else {
      this.snap = null;
    }
  }

  private drawTexts(ctx: CanvasRenderingContext2D, d: DocView, x0: number, y0: number, x1: number, y1: number): void {
    const v = d.view!;
    const s = v.scale;
    const texts = d.model.texts;
    const gv = d.groupVisible;
    const dpr = this.dpr;
    ctx.font = `${REF}px ${FONT}`;
    ctx.textBaseline = 'alphabetic';
    const capRef = REF * CAP;
    for (let i = 0; i < texts.length; i++) {
      const t = texts[i];
      if (!gv[t.group]) continue;
      const bb = t.bbox;
      if (bb[0] > x1 || bb[2] < x0 || bb[1] > y1 || bb[3] < y0) continue;
      const hpx = t.h * s;
      if (hpx < 1.5 || hpx > 20000) continue;
      let cache = d.textCache[i];
      if (!cache) {
        cache = { w: [] };
        let lines = t.lines;
        if (t.mtext && t.wrap > 0) {
          lines = wrapLines(ctx, lines, (t.wrap / t.h) * capRef);
          cache.wrapped = lines;
        }
        cache.w = lines.map((l) => ctx.measureText(l).width);
        d.textCache[i] = cache;
      }
      const lines = cache.wrapped ?? t.lines;
      const size = hpx / CAP;
      const k = size / REF;
      let wf = t.widthFactor;
      if (t.fitWidth > 0 && cache.w[0] > 0) wf = ((t.fitWidth / t.h) * capRef) / cache.w[0];
      const sx = (t.x - v.cx) * s + this.W / 2;
      const sy = this.H / 2 - (t.y - v.cy) * s;
      const c = Math.cos(t.rot);
      const sn = Math.sin(t.rot);
      // Screen Y points down, so the text rotation flips sign.
      ctx.setTransform(dpr * c * k * wf, -dpr * sn * k * wf, dpr * sn * k, dpr * c * k, dpr * sx, dpr * sy);
      ctx.fillStyle = d.colors.text[i];
      const step = (t.lineStep / t.h) * capRef;
      let y: number;
      if (t.mtext) {
        const block = capRef + (lines.length - 1) * step;
        y = t.vAlign === 3 ? capRef : t.vAlign === 2 ? capRef - block / 2 : capRef - block;
      } else {
        y = t.vAlign === 3 ? capRef : t.vAlign === 2 ? capRef / 2 : t.vAlign === 1 ? -0.21 * REF : 0;
      }
      for (let j = 0; j < lines.length; j++) {
        const w = cache.w[j] ?? 0;
        const x = t.fitWidth > 0 || t.hAlign === 0 ? 0 : t.hAlign === 1 ? -w / 2 : -w;
        ctx.fillText(lines[j], x, y);
        y += step;
      }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private drawOverlay(): void {
    const ctx = this.over.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.over.width, this.over.height);
    const d = this.doc;
    if (!d?.view) return;
    if (this.settings.dims) this.drawDims(ctx, d);
    if (this.hover >= 0) this.drawHover(ctx, d);
  }

  private traceHit(ctx: CanvasRenderingContext2D, d: DocView, i: number): void {
    const h = d.model.hits;
    const g = i * HIT_STRIDE;
    const G = h.geom;
    if (h.kind[i] === HIT_LINE) {
      ctx.moveTo(G[g], G[g + 1]);
      ctx.lineTo(G[g + 2], G[g + 3]);
    } else if (h.kind[i] === HIT_ARC) {
      ctx.moveTo(G[g] + G[g + 2] * Math.cos(G[g + 3]), G[g + 1] + G[g + 2] * Math.sin(G[g + 3]));
      ctx.arc(G[g], G[g + 1], G[g + 2], G[g + 3], G[g + 4], false);
    } else {
      const off = G[g];
      const n = G[g + 1];
      for (let k = 0; k < n; k++) {
        const x = h.pts[off + 2 * k];
        const y = h.pts[off + 2 * k + 1];
        if (k === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
    }
  }

  private drawHover(ctx: CanvasRenderingContext2D, d: DocView): void {
    const v = d.view!;
    const s = v.scale;
    const k = s * this.dpr;
    const pal = PALETTES[this.settings.theme];
    const i = this.hover;
    const h = d.model.hits;
    ctx.setTransform(k, 0, 0, -k, this.dpr * (this.W / 2 - v.cx * s), this.dpr * (this.H / 2 + v.cy * s));
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const siblings = d.hitsOfEntity(h.ent[i]);
    if (siblings.length > 1) {
      ctx.beginPath();
      for (const j of siblings) if (j !== i) this.traceHit(ctx, d, j);
      ctx.strokeStyle = pal.hoverSoft;
      ctx.lineWidth = 4 / s;
      ctx.stroke();
    }
    ctx.beginPath();
    this.traceHit(ctx, d, i);
    ctx.strokeStyle = pal.hover;
    ctx.lineWidth = 2.5 / s;
    ctx.stroke();

    // Construction marks in screen space.
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const G = h.geom;
    const g = i * HIT_STRIDE;
    const mark = (x: number, y: number) => {
      const [sx, sy] = this.toScreen(x, y);
      ctx.fillStyle = pal.bg;
      ctx.fillRect(sx - 3.5, sy - 3.5, 7, 7);
      ctx.strokeStyle = pal.hover;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(sx - 3.5, sy - 3.5, 7, 7);
    };
    if (h.kind[i] === HIT_LINE) {
      mark(G[g], G[g + 1]);
      mark(G[g + 2], G[g + 3]);
    } else if (h.kind[i] === HIT_ARC) {
      const [cx, cy] = this.toScreen(G[g], G[g + 1]);
      const r = G[g + 2];
      const full = G[g + 4] - G[g + 3] >= Math.PI * 2 - 1e-9;
      ctx.strokeStyle = pal.hover;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      const ends = full ? [Math.atan2(-(this.mouse!.y - cy), this.mouse!.x - cx)] : [G[g + 3], G[g + 4]];
      for (const a of ends) {
        const [ex, ey] = this.toScreen(G[g] + r * Math.cos(a), G[g + 1] + r * Math.sin(a));
        ctx.moveTo(cx, cy);
        ctx.lineTo(ex, ey);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx - 6, cy);
      ctx.lineTo(cx + 6, cy);
      ctx.moveTo(cx, cy - 6);
      ctx.lineTo(cx, cy + 6);
      ctx.stroke();
      if (!full) {
        mark(G[g] + r * Math.cos(G[g + 3]), G[g + 1] + r * Math.sin(G[g + 3]));
        mark(G[g] + r * Math.cos(G[g + 4]), G[g + 1] + r * Math.sin(G[g + 4]));
      }
    } else {
      const off = G[g];
      const n = G[g + 1];
      mark(h.pts[off], h.pts[off + 1]);
      mark(h.pts[off + 2 * (n - 1)], h.pts[off + 2 * (n - 1) + 1]);
    }
  }

  /** Overall width/height dimensions on the drawing's axis-aligned bounding box. */
  private drawDims(ctx: CanvasRenderingContext2D, d: DocView): void {
    const box = d.extents(this.settings.includeAnnotation);
    if (!box) return;
    const pal = PALETTES[this.settings.theme];
    const [L, B] = this.toScreen(box[0], box[1]);
    const [R, T] = this.toScreen(box[2], box[3]);
    const W = this.W;
    const H = this.H;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.lineWidth = 1;
    ctx.strokeStyle = pal.bbox;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(Math.round(L) + 0.5, Math.round(T) + 0.5, Math.round(R - L), Math.round(B - T));
    ctx.setLineDash([]);
    ctx.font = `600 12px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';

    // Only while the box is on screen; the lines stick to the viewport edges when zoomed in.
    if (R <= 0 || L >= W || B <= 0 || T >= H) return;
    // Width: dimension line below the box.
    if (R - L >= 0.5) {
      const y = Math.round(Math.min(Math.max(B + DIM_GAP, 18), H - 18)) + 0.5;
      const dir = y >= B ? 1 : -1;
      this.dimension(ctx, pal, L, y, R, y, [
        [L, B + 3 * dir, L, y + 6 * dir],
        [R, B + 3 * dir, R, y + 6 * dir],
      ], this.fmt.length(box[2] - box[0]), false);
    }
    // Height: dimension line right of the box.
    if (B - T >= 0.5) {
      const x = Math.round(Math.min(Math.max(R + DIM_GAP, 18), W - 18)) + 0.5;
      const dir = x >= R ? 1 : -1;
      this.dimension(ctx, pal, x, B, x, T, [
        [R + 3 * dir, B, x + 6 * dir, B],
        [R + 3 * dir, T, x + 6 * dir, T],
      ], this.fmt.length(box[3] - box[1]), true);
    }
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }

  private dimension(
    ctx: CanvasRenderingContext2D,
    pal: Palette,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    ext: number[][],
    label: string,
    vertical: boolean,
  ): void {
    ctx.strokeStyle = pal.accent;
    ctx.fillStyle = pal.accent;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const [a, b, c, e] of ext) {
      ctx.moveTo(vertical ? a : Math.round(a) + 0.5, vertical ? Math.round(b) + 0.5 : b);
      ctx.lineTo(vertical ? c : Math.round(c) + 0.5, vertical ? Math.round(e) + 0.5 : e);
    }
    const len = Math.hypot(x2 - x1, y2 - y1);
    const ux = (x2 - x1) / (len || 1);
    const uy = (y2 - y1) / (len || 1);
    const inside = len >= 2 * ARROW + 6;
    if (inside) {
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
    } else {
      // Too small on screen: arrows outside, pointing in.
      ctx.moveTo(x1 - ux * (ARROW + 10), y1 - uy * (ARROW + 10));
      ctx.lineTo(x2 + ux * (ARROW + 10), y2 + uy * (ARROW + 10));
    }
    ctx.stroke();
    const arrow = (tx: number, ty: number, dx: number, dy: number) => {
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(tx - dx * ARROW - dy * 3, ty - dy * ARROW + dx * 3);
      ctx.lineTo(tx - dx * ARROW + dy * 3, ty - dy * ARROW - dx * 3);
      ctx.closePath();
      ctx.fill();
    };
    const sgn = inside ? 1 : -1;
    arrow(x1, y1, -ux * sgn, -uy * sgn);
    arrow(x2, y2, ux * sgn, uy * sgn);

    // Label pill centred on the visible part of the dimension line.
    const tw = ctx.measureText(label).width;
    const pw = tw + 14;
    const ph = 20;
    let cx = (x1 + x2) / 2;
    let cy = (y1 + y2) / 2;
    if (vertical) cy = Math.min(Math.max(cy, Math.max(Math.min(y1, y2), 0) + pw / 2 + 4), Math.min(Math.max(y1, y2), this.H) - pw / 2 - 4);
    else cx = Math.min(Math.max(cx, Math.max(Math.min(x1, x2), 0) + pw / 2 + 4), Math.min(Math.max(x1, x2), this.W) - pw / 2 - 4);
    if (!inside) {
      if (vertical) cy = Math.min(y1, y2) - pw / 2 - ARROW - 14;
      else cx = Math.max(x1, x2) + pw / 2 + ARROW + 14;
    }
    ctx.save();
    ctx.translate(cx, cy);
    if (vertical) ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = pal.accent;
    ctx.beginPath();
    roundRect(ctx, -pw / 2, -ph / 2, pw, ph, 5);
    ctx.fill();
    ctx.fillStyle = pal.accentText;
    ctx.fillText(label, 0, 0.5);
    ctx.restore();
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Greedy word wrap at `width` (reference-font units). */
function wrapLines(ctx: CanvasRenderingContext2D, paragraphs: string[], width: number): string[] {
  const out: string[] = [];
  for (const p of paragraphs) {
    const words = p.split(/(\s+)/);
    let line = '';
    for (const w of words) {
      const next = line + w;
      if (line.trim() && ctx.measureText(next).width > width) {
        out.push(line.trimEnd());
        line = w.trimStart();
      } else {
        line = next;
      }
    }
    out.push(line);
  }
  return out;
}
