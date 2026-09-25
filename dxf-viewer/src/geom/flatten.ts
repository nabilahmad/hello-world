/**
 * Flattens a parsed DXF document into the viewer's render model: resolves
 * blocks, OCS, layers, colours and linetypes, builds path batches, text items,
 * a spatial index of measurable primitives and per-entity measurements.
 */
import Flatbush from 'flatbush';
import { ACI } from '../dxf/aci';
import { headerNumber, headerValue } from '../dxf/parser';
import { mtextParagraphs, plainText } from '../dxf/text';
import type {
  DxfDocument,
  Entity,
  EntityBase,
  HatchEntity,
  InsertEntity,
  PolyVertex,
  TextEntity,
  V3,
} from '../dxf/types';
import { hatchLoops, patternSegments } from './hatch';
import {
  type Arc2,
  type Mat,
  TAU,
  arcExtents,
  arcLength,
  arcShape,
  arcX,
  arcY,
  bulgeArc,
  curveSegments,
  det2,
  identity,
  mul,
  normalOf,
  normAngle,
  px,
  py,
  rotateZ,
  scale,
  transformArc,
  translate,
  withOcs,
} from './math';
import {
  type Batch,
  type EntityInfo,
  type LayerInfo,
  type RenderModel,
  type TextItem,
  FG,
  HIT_ARC,
  HIT_CURVE,
  HIT_LINE,
  HIT_STRIDE,
  OP_ARC,
  OP_CLOSE,
  OP_ELLIPSE,
  OP_LINE,
  OP_MOVE,
  boxAdd,
  boxUnion,
  boxValid,
  emptyBox,
} from './model';
import { curveThroughPoints, tessellateNurbs } from './spline';

const DEG = Math.PI / 180;

/** Growable Float64Array: avoids boxed JS arrays when emitting millions of numbers. */
class F64 {
  a = new Float64Array(256);
  n = 0;
  push(v: number): void {
    if (this.n === this.a.length) this.grow();
    this.a[this.n++] = v;
  }
  push3(a: number, b: number, c: number): void {
    if (this.n + 3 > this.a.length) this.grow();
    const x = this.a;
    x[this.n] = a;
    x[this.n + 1] = b;
    x[this.n + 2] = c;
    this.n += 3;
  }
  pushAll(v: ArrayLike<number>): void {
    for (let i = 0; i < v.length; i++) this.push(v[i]);
  }
  private grow(): void {
    const b = new Float64Array(this.a.length * 2);
    b.set(this.a);
    this.a = b;
  }
  out(): Float64Array {
    return this.a.slice(0, this.n);
  }
}
/** Upper bound for generated hatch pattern segments (whole drawing). */
const HATCH_BUDGET = 1_500_000;
const HATCH_BUDGET_EACH = 60_000;
const MAX_DEPTH = 24;

interface Ctx {
  m: Mat;
  /** Layer used by entities on layer "0" (inherited from the enclosing INSERT); -1 at top level. */
  layer0: number;
  /** Effective layers of the enclosing INSERTs; all must be visible. */
  outer: number[];
  byBlockColor: number;
  byBlockLinetype: string;
  annotation: boolean;
  /** Top-level block name, for tooltips. */
  block: string | undefined;
  depth: number;
  stack: string[];
  /** Style cache for entities resolved in this context. */
  styles: Map<string, Style>;
}

class BatchBuilder {
  readonly cmds = new F64();
  readonly points = new F64();
  bbox = emptyBox();
  constructor(
    readonly group: number,
    readonly color: number,
    readonly dash: number[] | null,
    readonly width: number,
    readonly fill: boolean,
    readonly annotation: boolean,
    readonly alpha: number,
    readonly roundCap: boolean,
    readonly infinite: boolean,
  ) {}

  move(x: number, y: number): void {
    this.cmds.push3(OP_MOVE, x, y);
    boxAdd(this.bbox, x, y);
  }

  line(x: number, y: number): void {
    this.cmds.push3(OP_LINE, x, y);
    boxAdd(this.bbox, x, y);
  }

  close(): void {
    this.cmds.push(OP_CLOSE);
  }
}

interface Style {
  layer: number;
  group: number;
  color: number;
  linetype: string;
  dash: number[] | null;
  /** Cached plain stroke batches: [geometry, annotation]. */
  stroke: [BatchBuilder | null, BatchBuilder | null];
}

interface ArcResult {
  length: number;
  /** Circular arcs: hit geometry; otherwise null and `pts` holds a tessellation. */
  circle: { cx: number; cy: number; r: number; lo: number; hi: number } | null;
  pts: number[] | null;
  rx: number;
  ry: number;
}

/** DXF linetype pattern → canvas dash array (dash, gap, …) in drawing units. */
export function toDash(pattern: number[], s: number): number[] | null {
  if (pattern.length < 2 || !pattern.some((v) => v < 0) || !(s > 0)) return null;
  const items = pattern.map((v) => ({ dash: v >= 0, len: Math.abs(v) * s }));
  // Start with a dash.
  const first = items.findIndex((i) => i.dash);
  if (first < 0) return null;
  const rot = items.slice(first).concat(items.slice(0, first));
  const out: number[] = [];
  let wantDash = true;
  for (const it of rot) {
    if (it.dash === wantDash) {
      out.push(it.len);
      wantDash = !wantDash;
    } else if (!it.dash) {
      out[out.length - 1] += it.len; // gap after gap
    } else {
      out.push(0, it.len); // dash after dash
    }
  }
  if (out.length % 2 === 1) out.push(0);
  let total = 0;
  for (const v of out) total += v;
  return total > 0 ? out : null;
}

function polyArea(verts: PolyVertex[]): number {
  let a = 0;
  const n = verts.length;
  for (let i = 0; i < n; i++) {
    const p = verts[i];
    const q = verts[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
    if (p.bulge !== 0) {
      const theta = 4 * Math.atan(p.bulge);
      const chord = Math.hypot(q.x - p.x, q.y - p.y);
      const s = Math.sin(theta / 2);
      if (s !== 0) {
        const r = chord / (2 * s);
        a += r * r * (theta - Math.sin(theta));
      }
    }
  }
  return Math.abs(a / 2);
}

function polylineLength(pts: number[]): number {
  let l = 0;
  for (let i = 2; i < pts.length; i += 2) l += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
  return l;
}

class Flattener {
  readonly layers: LayerInfo[] = [];
  private readonly layerIndex = new Map<string, number>();
  private readonly layerLinetype: string[] = [];
  readonly groups: number[][] = [];
  private readonly groupIndex = new Map<string, number>();
  private readonly batches = new Map<string, BatchBuilder>();
  private readonly dashCache = new Map<string, number[] | null>();
  readonly texts: TextItem[] = [];
  readonly entities: EntityInfo[] = [];
  private readonly rays: Array<{ style: Style; x: number; y: number; dx: number; dy: number; both: boolean }> = [];
  private hatchBudget = HATCH_BUDGET;
  primitives = 0;

  // Hit-test primitives.
  private hitKind = new F64();
  private hitGeom = new F64();
  private hitPts = new F64();
  private hitEnt = new F64();
  private hitSeg = new F64();
  private hitGroup = new F64();

  private readonly ltscale: number;
  private readonly arrowSize: number;

  constructor(private readonly doc: DxfDocument) {
    this.ltscale = headerNumber(doc, '$LTSCALE', 1) || 1;
    const metric = headerNumber(doc, '$MEASUREMENT', 0) === 1;
    this.arrowSize = (headerNumber(doc, '$DIMASZ', metric ? 2.5 : 0.18) || 0.18) * (headerNumber(doc, '$DIMSCALE', 1) || 1);
    for (const layer of doc.layers.values()) this.addLayer(layer.name, layer.color, layer.trueColor, layer.linetype, !(layer.off || layer.frozen));
  }

  private addLayer(name: string, aci: number, trueColor: number, linetype: string, visible: boolean): number {
    const idx = this.layers.length;
    const color = trueColor >= 0 ? trueColor : aci === 7 || aci <= 0 || aci > 255 ? FG : ACI[aci];
    this.layers.push({ name, color, visible, count: 0 });
    this.layerLinetype.push((linetype || 'CONTINUOUS').toUpperCase());
    this.layerIndex.set(name.toUpperCase(), idx);
    return idx;
  }

  private layerIdx(name: string): number {
    return this.layerIndex.get(name.toUpperCase()) ?? this.addLayer(name, 7, -1, 'CONTINUOUS', true);
  }

  private effLayer(name: string, ctx: Ctx): number {
    if (ctx.layer0 >= 0 && (name === '0' || name === '')) return ctx.layer0;
    return this.layerIdx(name);
  }

  private group(layer: number, outer: number[]): number {
    let ids = outer.includes(layer) ? outer : [...outer, layer];
    if (ids.length > 1) ids = [...new Set(ids)].sort((a, b) => a - b);
    const key = ids.join(',');
    let g = this.groupIndex.get(key);
    if (g === undefined) {
      g = this.groups.length;
      this.groups.push(ids);
      this.groupIndex.set(key, g);
    }
    return g;
  }

  private dash(name: string, entScale: number): number[] | null {
    if (!name || name === 'CONTINUOUS') return null;
    const key = name + '|' + entScale;
    if (this.dashCache.has(key)) return this.dashCache.get(key)!;
    const lt = this.doc.linetypes.get(name);
    const d = lt ? toDash(lt.pattern, this.ltscale * entScale) : null;
    this.dashCache.set(key, d);
    return d;
  }

  private style(e: EntityBase, ctx: Ctx): Style {
    const key = e.layer + '\u0001' + e.color + '\u0001' + e.trueColor + '\u0001' + e.linetype + '\u0001' + e.ltscale;
    let st = ctx.styles.get(key);
    if (!st) {
      st = this.resolveStyle(e, ctx);
      ctx.styles.set(key, st);
    }
    return st;
  }

  private resolveStyle(e: EntityBase, ctx: Ctx): Style {
    const layer = this.effLayer(e.layer, ctx);
    let color: number;
    if (e.trueColor >= 0) color = e.trueColor;
    else if (e.color === 0) color = ctx.byBlockColor;
    else if (e.color === 7) color = FG;
    else if (e.color > 0 && e.color < 256) color = ACI[e.color];
    else color = this.layers[layer].color;
    let linetype = e.linetype.toUpperCase();
    if (!linetype || linetype === 'BYLAYER') linetype = this.layerLinetype[layer];
    else if (linetype === 'BYBLOCK') linetype = ctx.byBlockLinetype;
    return {
      layer,
      group: this.group(layer, ctx.outer),
      color,
      linetype,
      dash: this.dash(linetype, e.ltscale),
      stroke: [null, null],
    };
  }

  private batch(
    s: Style,
    ctx: Ctx,
    opts: { fill?: boolean; width?: number; alpha?: number; roundCap?: boolean; solid?: boolean; infinite?: boolean } = {},
  ): BatchBuilder {
    this.layers[s.layer].count++;
    this.primitives++;
    const plain = opts.fill === undefined && opts.width === undefined && opts.alpha === undefined && !opts.roundCap && !opts.solid && !opts.infinite;
    if (plain) {
      const cached = s.stroke[ctx.annotation ? 1 : 0];
      if (cached) return cached;
    }
    const fill = !!opts.fill;
    const dash = fill || opts.solid ? null : s.dash;
    const width = opts.width ?? 0;
    const alpha = opts.alpha ?? 1;
    const roundCap = !!opts.roundCap;
    const infinite = !!opts.infinite;
    const key = `${s.group}|${s.color}|${dash ? dash.join(',') : ''}|${width}|${fill}|${ctx.annotation}|${alpha}|${roundCap}|${infinite}`;
    let b = this.batches.get(key);
    if (!b) {
      b = new BatchBuilder(s.group, s.color, dash, width, fill, ctx.annotation, alpha, roundCap, infinite);
      this.batches.set(key, b);
    }
    if (plain) s.stroke[ctx.annotation ? 1 : 0] = b;
    return b;
  }

  private info(type: string, s: Style, ctx: Ctx, extra: Partial<EntityInfo>): number {
    this.entities.push({
      type,
      layer: s.layer,
      block: ctx.block,
      length: extra.length ?? 0,
      area: extra.area,
      closed: extra.closed,
      segs: extra.segs,
      rx: extra.rx,
      ry: extra.ry,
    });
    return this.entities.length - 1;
  }

  private hitLine(x1: number, y1: number, x2: number, y2: number, ent: number, seg: number, group: number): void {
    if (x1 === x2 && y1 === y2) return;
    this.hitKind.push(HIT_LINE);
    this.hitGeom.push3(x1, y1, x2);
    this.hitGeom.push(y2);
    this.hitGeom.push(0);
    this.hitEnt.push(ent);
    this.hitSeg.push(seg);
    this.hitGroup.push(group);
  }

  private hitArc(a: ArcResult, ent: number, seg: number, group: number): void {
    if (a.circle) {
      const c = a.circle;
      this.hitKind.push(HIT_ARC);
      this.hitGeom.pushAll([c.cx, c.cy, c.r, c.lo, c.hi]);
    } else if (a.pts && a.pts.length >= 4) {
      this.hitKind.push(HIT_CURVE);
      this.hitGeom.pushAll([this.hitPts.n, a.pts.length / 2, 0, 0, 0]);
      this.hitPts.pushAll(a.pts);
    } else return;
    this.hitEnt.push(ent);
    this.hitSeg.push(seg);
    this.hitGroup.push(group);
  }

  private hitCurve(pts: number[], ent: number, seg: number, group: number): void {
    if (pts.length < 4) return;
    this.hitArc({ length: 0, circle: null, pts, rx: 0, ry: 0 }, ent, seg, group);
  }

  /** Appends an affine arc to the batch path and returns its measurements. */
  private arcPath(b: BatchBuilder, a: Arc2, newSubpath: boolean): ArcResult {
    const shape = arcShape(a);
    arcExtents(a, b.bbox);
    const sx = arcX(a, a.t0);
    const sy = arcY(a, a.t0);
    if (newSubpath) b.cmds.push3(OP_MOVE, sx, sy);
    if (shape.kind === 'circle') {
      b.cmds.pushAll([OP_ARC, shape.cx, shape.cy, shape.r, shape.start, shape.end, shape.acw ? 1 : 0]);
      const lo0 = shape.acw ? shape.end : shape.start;
      const sweep = Math.abs(shape.end - shape.start);
      const lo = normAngle(lo0);
      return {
        length: shape.r * sweep,
        circle: { cx: shape.cx, cy: shape.cy, r: shape.r, lo, hi: lo + sweep },
        pts: null,
        rx: shape.r,
        ry: shape.r,
      };
    }
    const rmax = Math.max(Math.hypot(a.ux, a.uy), Math.hypot(a.vx, a.vy));
    const n = curveSegments(a.t1 - a.t0, rmax, rmax * 1e-4);
    const pts: number[] = [];
    for (let i = 0; i <= n; i++) {
      const t = a.t0 + ((a.t1 - a.t0) * i) / n;
      pts.push(arcX(a, t), arcY(a, t));
    }
    if (shape.kind === 'ellipse') {
      b.cmds.pushAll([OP_ELLIPSE, shape.cx, shape.cy, shape.rx, shape.ry, shape.rot, shape.start, shape.end, shape.acw ? 1 : 0]);
    } else {
      for (let i = 2; i < pts.length; i += 2) b.cmds.push3(OP_LINE, pts[i], pts[i + 1]);
    }
    return {
      length: arcLength(a),
      circle: null,
      pts,
      rx: shape.kind === 'ellipse' ? shape.rx : 0,
      ry: shape.kind === 'ellipse' ? shape.ry : 0,
    };
  }

  private curvePath(b: BatchBuilder, pts: number[]): void {
    for (let i = 0; i < pts.length; i += 2) {
      if (i === 0) b.move(pts[0], pts[1]);
      else b.line(pts[i], pts[i + 1]);
    }
  }

  entity(e: Entity, ctx: Ctx): void {
    if (e.invisible) return;
    switch (e.type) {
      case 'LINE': {
        const s = this.style(e, ctx);
        const b = this.batch(s, ctx);
        const m = ctx.m;
        const x1 = px(m, e.p1.x, e.p1.y, e.p1.z);
        const y1 = py(m, e.p1.x, e.p1.y, e.p1.z);
        const x2 = px(m, e.p2.x, e.p2.y, e.p2.z);
        const y2 = py(m, e.p2.x, e.p2.y, e.p2.z);
        b.move(x1, y1);
        b.line(x2, y2);
        if (!ctx.annotation) {
          const ent = this.info('LINE', s, ctx, { length: Math.hypot(x2 - x1, y2 - y1) });
          this.hitLine(x1, y1, x2, y2, ent, -1, s.group);
        }
        return;
      }
      case 'CIRCLE':
      case 'ARC': {
        if (!(e.r > 0)) return;
        const s = this.style(e, ctx);
        const b = this.batch(s, ctx);
        let t0 = 0;
        let t1 = TAU;
        if (e.type === 'ARC') {
          t0 = e.a0 * DEG;
          t1 = e.a1 * DEG;
          while (t1 <= t0) t1 += TAU;
          if (t1 - t0 > TAU) t1 -= TAU;
        }
        const W = withOcs(ctx.m, e.extrusion);
        const arc = transformArc(W, e.c, [e.r, 0, 0], [0, e.r, 0], t0, t1);
        const res = this.arcPath(b, arc, true);
        if (ctx.annotation) return;
        const full = e.type === 'CIRCLE';
        const round = res.circle !== null;
        const type = full ? (round ? 'CIRCLE' : 'ELLIPSE') : round ? 'ARC' : 'ELLIPTICAL ARC';
        const ent = this.info(type, s, ctx, {
          length: res.length,
          area: full ? Math.PI * (round ? res.rx * res.rx : res.rx * res.ry) : undefined,
          closed: full,
          rx: res.rx,
          ry: res.ry,
        });
        this.hitArc(res, ent, -1, s.group);
        return;
      }
      case 'ELLIPSE': {
        const len = Math.hypot(e.major.x, e.major.y, e.major.z);
        if (!(len > 0) || !(e.ratio > 0)) return;
        const s = this.style(e, ctx);
        const b = this.batch(s, ctx);
        const n = normalOf(e.extrusion);
        const minor: [number, number, number] = [
          e.ratio * (n.y * e.major.z - n.z * e.major.y),
          e.ratio * (n.z * e.major.x - n.x * e.major.z),
          e.ratio * (n.x * e.major.y - n.y * e.major.x),
        ];
        let t0 = e.t0;
        let t1 = e.t1;
        while (t1 <= t0) t1 += TAU;
        if (t1 - t0 > TAU + 1e-9) t1 -= TAU;
        const full = Math.abs(t1 - t0 - TAU) < 1e-9;
        const arc = transformArc(ctx.m, e.c, [e.major.x, e.major.y, e.major.z], minor, t0, t1);
        const res = this.arcPath(b, arc, true);
        if (ctx.annotation) return;
        const rx = res.circle ? res.circle.r : res.rx;
        const ry = res.circle ? res.circle.r : res.ry;
        const ent = this.info(full ? 'ELLIPSE' : 'ELLIPTICAL ARC', s, ctx, {
          length: res.length,
          area: full ? Math.PI * rx * ry : undefined,
          closed: full,
          rx: Math.max(rx, ry),
          ry: Math.min(rx, ry),
        });
        this.hitArc(res, ent, -1, s.group);
        return;
      }
      case 'LWPOLYLINE': {
        const W = withOcs(ctx.m, e.extrusion);
        this.polyline(e, e.verts, e.closed, W, ctx, 'POLYLINE', e.width);
        return;
      }
      case 'POLYLINE':
        this.polylineEntity(e, ctx);
        return;
      case 'SPLINE': {
        const m = ctx.m;
        const s = this.style(e, ctx);
        const b = this.batch(s, ctx);
        const pts: number[] = [];
        if (e.ctrl.length >= 2) {
          const xs = e.ctrl.map((p) => px(m, p.x, p.y, p.z));
          const ys = e.ctrl.map((p) => py(m, p.x, p.y, p.z));
          const bb = emptyBox();
          for (let i = 0; i < xs.length; i++) boxAdd(bb, xs[i], ys[i]);
          const tol = Math.hypot(bb[2] - bb[0], bb[3] - bb[1]) * 1e-4 || 1e-9;
          tessellateNurbs(e.degree, e.knots, xs, ys, e.weights.length ? e.weights : null, tol, pts);
        } else if (e.fit.length >= 2) {
          const xs = e.fit.map((p) => px(m, p.x, p.y, p.z));
          const ys = e.fit.map((p) => py(m, p.x, p.y, p.z));
          curveThroughPoints(xs, ys, (e.flags & 1) === 1, pts);
        }
        if (pts.length < 4) return;
        this.curvePath(b, pts);
        if (ctx.annotation) return;
        const closed = (e.flags & 1) === 1;
        const ent = this.info('SPLINE', s, ctx, { length: polylineLength(pts), closed });
        this.hitCurve(pts, ent, -1, s.group);
        return;
      }
      case 'POINT': {
        const s = this.style(e, ctx);
        const b = this.batch(s, ctx);
        const x = px(ctx.m, e.p.x, e.p.y, e.p.z);
        const y = py(ctx.m, e.p.x, e.p.y, e.p.z);
        b.points.push(x);
        b.points.push(y);
        boxAdd(b.bbox, x, y);
        return;
      }
      case 'TEXT':
      case 'ATTRIB':
        this.text(e, ctx);
        return;
      case 'MTEXT': {
        const lines = mtextParagraphs(e.text);
        if (lines.every((l) => l.trim() === '')) return;
        const s = this.style(e, ctx);
        let dx: number;
        let dy: number;
        let dz: number;
        if (e.xdir && Math.hypot(e.xdir.x, e.xdir.y, e.xdir.z) > 1e-12) {
          ({ x: dx, y: dy, z: dz } = e.xdir);
        } else {
          const o = withOcs(identity(), e.extrusion);
          const c = Math.cos(e.rot * DEG);
          const sn = Math.sin(e.rot * DEG);
          dx = o[0] * c + o[1] * sn;
          dy = o[3] * c + o[4] * sn;
          dz = o[6] * c + o[7] * sn;
        }
        const l = Math.hypot(dx, dy, dz);
        const m = ctx.m;
        const wx = (m[0] * dx + m[1] * dy + m[2] * dz) / l;
        const wy = (m[3] * dx + m[4] * dy + m[5] * dz) / l;
        const k = Math.hypot(wx, wy) || 1;
        const h = e.h * k;
        const attach = Math.min(9, Math.max(1, e.attach));
        this.addText(s, {
          x: px(m, e.p.x, e.p.y, e.p.z),
          y: py(m, e.p.x, e.p.y, e.p.z),
          rot: Math.atan2(wy, wx),
          h,
          widthFactor: 1,
          lines,
          hAlign: (attach - 1) % 3,
          vAlign: 3 - Math.floor((attach - 1) / 3),
          mtext: true,
          lineStep: h * (5 / 3) * e.lineSpacing,
          wrap: e.width * k,
          fitWidth: 0,
        });
        return;
      }
      case 'INSERT':
        this.insert(e, ctx);
        return;
      case 'DIMENSION':
      case 'ACAD_TABLE': {
        const blk = this.doc.blocks.get(e.block.toUpperCase());
        if (!blk) return;
        const s = this.style(e, ctx);
        const m = mul(withOcs(ctx.m, e.extrusion), translate(e.p.x, e.p.y, e.p.z));
        this.blockContent(blk.name, blk.entities, s, ctx, m, true);
        return;
      }
      case 'SOLID':
      case 'TRACE': {
        const s = this.style(e, ctx);
        const b = this.batch(s, ctx, { fill: true });
        const W = withOcs(ctx.m, e.extrusion);
        const [a, bb, c, d] = e.pts;
        [a, bb, d, c].forEach((p, i) => {
          const x = px(W, p.x, p.y, p.z);
          const y = py(W, p.x, p.y, p.z);
          if (i === 0) b.move(x, y);
          else b.line(x, y);
        });
        b.close();
        return;
      }
      case '3DFACE': {
        const s = this.style(e, ctx);
        const b = this.batch(s, ctx);
        const m = ctx.m;
        for (let i = 0; i < 4; i++) {
          if (e.edgeFlags & (1 << i)) continue;
          const p = e.pts[i];
          const q = e.pts[(i + 1) % 4];
          if (p.x === q.x && p.y === q.y && p.z === q.z) continue;
          b.move(px(m, p.x, p.y, p.z), py(m, p.x, p.y, p.z));
          b.line(px(m, q.x, q.y, q.z), py(m, q.x, q.y, q.z));
        }
        return;
      }
      case 'LEADER': {
        if (e.pts.length < 2) return;
        const s = this.style(e, ctx);
        const ann = { ...ctx, annotation: true };
        const b = this.batch(s, ann);
        const m = ctx.m;
        const xs = e.pts.map((p) => px(m, p.x, p.y, p.z));
        const ys = e.pts.map((p) => py(m, p.x, p.y, p.z));
        xs.forEach((x, i) => (i === 0 ? b.move(x, ys[i]) : b.line(x, ys[i])));
        if (e.arrow) {
          const dx = xs[0] - xs[1];
          const dy = ys[0] - ys[1];
          const l = Math.hypot(dx, dy);
          if (l > 0) {
            const size = this.arrowSize * Math.sqrt(Math.abs(det2(m))) || this.arrowSize;
            const ux = dx / l;
            const uy = dy / l;
            const f = this.batch(s, ann, { fill: true });
            f.move(xs[0], ys[0]);
            f.line(xs[0] - ux * size - uy * size / 6, ys[0] - uy * size + ux * size / 6);
            f.line(xs[0] - ux * size + uy * size / 6, ys[0] - uy * size - ux * size / 6);
            f.close();
          }
        }
        return;
      }
      case 'RAY':
      case 'XLINE': {
        const s = this.style(e, ctx);
        const m = ctx.m;
        const x = px(m, e.p.x, e.p.y, e.p.z);
        const y = py(m, e.p.x, e.p.y, e.p.z);
        const dx = m[0] * e.dir.x + m[1] * e.dir.y + m[2] * e.dir.z;
        const dy = m[3] * e.dir.x + m[4] * e.dir.y + m[5] * e.dir.z;
        const l = Math.hypot(dx, dy);
        if (l > 0) this.rays.push({ style: s, x, y, dx: dx / l, dy: dy / l, both: e.type === 'XLINE' });
        return;
      }
      case 'HATCH':
        this.hatch(e, ctx);
        return;
    }
  }

  private polyline(
    e: EntityBase,
    verts: PolyVertex[],
    closed: boolean,
    W: Mat,
    ctx: Ctx,
    type: string,
    width: number,
  ): void {
    const n = verts.length;
    if (n < 2) return;
    const s = this.style(e, ctx);
    const worldWidth = width > 0 ? width * Math.sqrt(Math.abs(det2(W))) : 0;
    const b = this.batch(s, ctx, { width: worldWidth });
    const segs = closed ? n : n - 1;
    const ent = ctx.annotation ? -1 : this.info(type, s, ctx, { closed, segs });
    let x1 = px(W, verts[0].x, verts[0].y, verts[0].z);
    let y1 = py(W, verts[0].x, verts[0].y, verts[0].z);
    b.move(x1, y1);
    let length = 0;
    for (let i = 0; i < segs; i++) {
      const a = verts[i];
      const c = verts[(i + 1) % n];
      const x2 = px(W, c.x, c.y, c.z);
      const y2 = py(W, c.x, c.y, c.z);
      if (Math.abs(a.bulge) < 1e-12 || (a.x === c.x && a.y === c.y)) {
        b.line(x2, y2);
        length += Math.hypot(x2 - x1, y2 - y1);
        if (ent >= 0) this.hitLine(x1, y1, x2, y2, ent, i, s.group);
      } else {
        const ba = bulgeArc(a.x, a.y, c.x, c.y, a.bulge);
        const arc = transformArc(W, { x: ba.cx, y: ba.cy, z: a.z }, [ba.r, 0, 0], [0, ba.r, 0], ba.a0, ba.a0 + ba.sweep);
        const res = this.arcPath(b, arc, false);
        length += res.length;
        if (ent >= 0) this.hitArc(res, ent, i, s.group);
      }
      x1 = x2;
      y1 = y2;
    }
    if (closed) b.close();
    if (ent >= 0) {
      const info = this.entities[ent];
      info.length = length;
      if (closed) info.area = polyArea(verts) * Math.abs(det2(W));
    }
  }

  private polylineEntity(e: Extract<Entity, { type: 'POLYLINE' }>, ctx: Ctx): void {
    const verts = e.verts.filter((v) => (v.flags & 16) === 0); // skip spline frame control points
    const closed = (e.flags & 1) === 1;
    if (e.flags & 64) {
      // Polyface mesh: draw visible face edges.
      const s = this.style(e, ctx);
      const b = this.batch(s, ctx);
      const m = ctx.m;
      for (const face of e.faces) {
        for (let k = 0; k < face.length; k++) {
          const a = face[k];
          const c = Math.abs(face[(k + 1) % face.length]);
          if (a <= 0) continue;
          const p = e.verts[a - 1];
          const q = e.verts[c - 1];
          if (!p || !q) continue;
          b.move(px(m, p.x, p.y, p.z), py(m, p.x, p.y, p.z));
          b.line(px(m, q.x, q.y, q.z), py(m, q.x, q.y, q.z));
        }
      }
      return;
    }
    if (e.flags & 16) {
      // Polygon mesh M × N.
      const M = e.meshM;
      const N = e.meshN;
      if (M * N > verts.length || M < 1 || N < 1) return;
      const row = (i: number) => verts.slice(i * N, i * N + N);
      for (let i = 0; i < M; i++) this.polyline(e, row(i), (e.flags & 32) !== 0, ctx.m, ctx, 'MESH', 0);
      for (let j = 0; j < N; j++) {
        const col = [];
        for (let i = 0; i < M; i++) col.push(verts[i * N + j]);
        this.polyline(e, col, closed, ctx.m, ctx, 'MESH', 0);
      }
      return;
    }
    if (e.flags & 8) {
      // 3D polyline: WCS, straight segments.
      this.polyline(e, verts.map((v) => ({ ...v, bulge: 0 })), closed, ctx.m, ctx, '3D POLYLINE', 0);
      return;
    }
    this.polyline(e, verts, closed, withOcs(ctx.m, e.extrusion), ctx, 'POLYLINE', e.width);
  }

  private text(e: TextEntity, ctx: Ctx): void {
    const str = plainText(e.text);
    if (!str.trim() || !(e.h > 0)) return;
    const s = this.style(e, ctx);
    const W = withOcs(ctx.m, e.extrusion);
    let rot = e.rot * DEG;
    let anchor: V3 = e.p;
    let hAlign = 0;
    let vAlign = 0;
    let fitLocal = 0;
    if ((e.hAlign === 3 || e.hAlign === 5) && e.p2) {
      const dx = e.p2.x - e.p.x;
      const dy = e.p2.y - e.p.y;
      fitLocal = Math.hypot(dx, dy);
      if (fitLocal > 0) rot = Math.atan2(dy, dx);
    } else if ((e.hAlign !== 0 || e.vAlign !== 0) && e.p2) {
      anchor = e.p2;
      hAlign = e.hAlign === 4 ? 1 : Math.min(2, e.hAlign);
      vAlign = e.hAlign === 4 ? 2 : e.vAlign;
    }
    const c = Math.cos(rot);
    const sn = Math.sin(rot);
    const xx = W[0] * c + W[1] * sn;
    const xy = W[3] * c + W[4] * sn;
    const yx = -W[0] * sn + W[1] * c;
    const yy = -W[3] * sn + W[4] * c;
    const kx = Math.hypot(xx, xy) || 1;
    const ky = Math.hypot(yx, yy) || kx;
    const h = e.h * ky;
    this.addText(s, {
      x: px(W, anchor.x, anchor.y, anchor.z),
      y: py(W, anchor.x, anchor.y, anchor.z),
      rot: Math.atan2(xy, xx),
      h,
      widthFactor: (e.widthFactor || 1) * (kx / ky),
      lines: [str],
      hAlign,
      vAlign,
      mtext: false,
      lineStep: h * (5 / 3),
      wrap: 0,
      fitWidth: fitLocal * kx,
    });
  }

  private addText(s: Style, t: Omit<TextItem, 'group' | 'color' | 'bbox'>): void {
    // Rough extents: average glyph advance ~0.6 × height for sans-serif fonts.
    let chars = 0;
    for (const l of t.lines) chars = Math.max(chars, l.length);
    let w = t.fitWidth > 0 ? t.fitWidth : chars * t.h * 0.6 * t.widthFactor;
    let lines = t.lines.length;
    if (t.wrap > 0 && w > t.wrap) {
      lines += Math.ceil(w / t.wrap) - 1;
      w = t.wrap;
    }
    const height = t.h + (lines - 1) * t.lineStep;
    const x0 = t.hAlign === 0 ? 0 : t.hAlign === 1 ? -w / 2 : -w;
    let y0: number;
    let boxH = height;
    if (t.mtext) y0 = t.vAlign === 3 ? -height : t.vAlign === 2 ? -height / 2 : 0;
    else {
      // Single line: baseline / bottom (descender) / middle / top alignment.
      boxH = 1.2 * t.h;
      y0 = t.vAlign === 3 ? -boxH : t.vAlign === 2 ? -boxH / 2 : t.vAlign === 1 ? 0 : -0.2 * t.h;
    }
    const bbox = emptyBox();
    const c = Math.cos(t.rot);
    const sn = Math.sin(t.rot);
    for (const [lx, ly] of [
      [x0, y0],
      [x0 + w, y0],
      [x0, y0 + boxH],
      [x0 + w, y0 + boxH],
    ]) {
      boxAdd(bbox, t.x + lx * c - ly * sn, t.y + lx * sn + ly * c);
    }
    this.texts.push({ ...t, group: s.group, color: s.color, bbox });
    this.layers[s.layer].count++;
    this.primitives++;
  }

  private insert(e: InsertEntity, ctx: Ctx): void {
    const blk = this.doc.blocks.get(e.name.toUpperCase());
    const s = this.style(e, ctx);
    if (blk && blk.entities.length > 0) {
      const W = withOcs(ctx.m, e.extrusion);
      const base = mul(mul(W, translate(e.p.x, e.p.y, e.p.z)), rotateZ(e.rot * DEG));
      const tail = mul(scale(e.sx, e.sy, e.sz), translate(-blk.base.x, -blk.base.y, -blk.base.z));
      const rows = Math.min(e.rows, 10000);
      const cols = Math.min(e.cols, 10000);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const cell = r === 0 && c === 0 ? base : mul(base, translate(c * e.colSpacing, r * e.rowSpacing, 0));
          this.blockContent(blk.name, blk.entities, s, ctx, mul(cell, tail), ctx.annotation);
        }
      }
    }
    if (e.attribs.length > 0) {
      const child = this.childCtx(s, ctx, ctx.m, ctx.annotation, blk?.name ?? e.name);
      for (const a of e.attribs) this.entity(a, child);
    }
  }

  private childCtx(s: Style, ctx: Ctx, m: Mat, annotation: boolean, name: string): Ctx {
    return {
      m,
      layer0: s.layer,
      outer: ctx.outer.includes(s.layer) ? ctx.outer : [...ctx.outer, s.layer],
      byBlockColor: s.color,
      byBlockLinetype: s.linetype,
      annotation,
      block: ctx.block ?? name,
      depth: ctx.depth + 1,
      stack: [...ctx.stack, name.toUpperCase()],
      styles: new Map(),
    };
  }

  private blockContent(name: string, entities: Entity[], s: Style, ctx: Ctx, m: Mat, annotation: boolean): void {
    if (ctx.depth >= MAX_DEPTH || ctx.stack.includes(name.toUpperCase())) return;
    const child = this.childCtx(s, ctx, m, annotation, name);
    for (const ent of entities) this.entity(ent, child);
  }

  private hatch(e: HatchEntity, ctx: Ctx): void {
    const loops = hatchLoops(e);
    if (loops.length === 0) return;
    const s = this.style(e, ctx);
    const W = mul(withOcs(ctx.m, e.extrusion), translate(0, 0, e.elevation));
    const fillLoops = (b: BatchBuilder) => {
      for (const l of loops) {
        for (let i = 0; i < l.length; i += 2) {
          const x = px(W, l[i], l[i + 1], 0);
          const y = py(W, l[i], l[i + 1], 0);
          if (i === 0) b.move(x, y);
          else b.line(x, y);
        }
        b.close();
      }
    };
    if (e.solid || e.lines.length === 0) {
      fillLoops(this.batch(s, ctx, { fill: true, alpha: e.solid ? 1 : 0.25 }));
      return;
    }
    const segs = patternSegments(loops, e.lines, Math.min(HATCH_BUDGET_EACH, this.hatchBudget));
    if (!segs) {
      fillLoops(this.batch(s, ctx, { fill: true, alpha: 0.25 }));
      return;
    }
    this.hatchBudget -= segs.length / 4;
    const b = this.batch(s, ctx, { roundCap: true, solid: true });
    for (let i = 0; i < segs.length; i += 4) {
      b.move(px(W, segs[i], segs[i + 1], 0), py(W, segs[i], segs[i + 1], 0));
      b.line(px(W, segs[i + 2], segs[i + 3], 0), py(W, segs[i + 2], segs[i + 3], 0));
    }
  }

  finish(doc: DxfDocument, bytes: number, origin: [number, number]): RenderModel {
    // Rays and construction lines extend well past the drawing without affecting extents.
    if (this.rays.length) {
      const all = emptyBox();
      for (const b of this.batches.values()) boxUnion(all, b.bbox);
      const span = boxValid(all) ? Math.hypot(all[2] - all[0], all[3] - all[1]) : 1000;
      const cx = boxValid(all) ? (all[0] + all[2]) / 2 : 0;
      const cy = boxValid(all) ? (all[1] + all[3]) / 2 : 0;
      const ctx = this.topCtx();
      for (const r of this.rays) {
        const L = span * 8 + Math.hypot(r.x - cx, r.y - cy);
        const b = this.batch(r.style, ctx, { infinite: true });
        b.cmds.push3(OP_MOVE, r.both ? r.x - r.dx * L : r.x, r.both ? r.y - r.dy * L : r.y);
        b.cmds.push3(OP_LINE, r.x + r.dx * L, r.y + r.dy * L);
      }
    }

    const batches: Batch[] = [];
    for (const b of this.batches.values()) {
      batches.push({
        group: b.group,
        color: b.color,
        dash: b.dash,
        width: b.width,
        fill: b.fill,
        annotation: b.annotation,
        alpha: b.alpha,
        roundCap: b.roundCap,
        infinite: b.infinite,
        cmds: b.cmds.out(),
        points: b.points.n ? b.points.out() : null,
        bbox: b.infinite ? [-Infinity, -Infinity, Infinity, Infinity] : [...b.bbox],
      });
    }
    // Fills first so strokes stay visible on top of solid areas.
    const split = batches.flatMap(splitBatch);
    split.sort((a, b) => Number(b.fill) - Number(a.fill));

    // Spatial index of the hit primitives.
    const count = this.hitKind.n;
    const geom = this.hitGeom.out();
    const pts = this.hitPts.out();
    let index: ArrayBuffer | null = null;
    if (count > 0) {
      const fb = new Flatbush(count);
      const bb = emptyBox();
      for (let i = 0; i < count; i++) {
        const g = i * HIT_STRIDE;
        const kind = this.hitKind.a[i];
        bb[0] = bb[1] = Infinity;
        bb[2] = bb[3] = -Infinity;
        if (kind === HIT_LINE) {
          boxAdd(bb, geom[g], geom[g + 1]);
          boxAdd(bb, geom[g + 2], geom[g + 3]);
        } else if (kind === HIT_ARC) {
          const r = geom[g + 2];
          arcExtents({ cx: geom[g], cy: geom[g + 1], ux: r, uy: 0, vx: 0, vy: r, t0: geom[g + 3], t1: geom[g + 4] }, bb);
        } else {
          const off = geom[g];
          const n = geom[g + 1];
          for (let k = 0; k < n; k++) boxAdd(bb, pts[off + 2 * k], pts[off + 2 * k + 1]);
        }
        fb.add(bb[0], bb[1], bb[2], bb[3]);
      }
      fb.finish();
      index = fb.data as ArrayBuffer;
    }

    return {
      origin,
      layers: this.layers,
      groups: this.groups,
      batches: split,
      texts: this.texts,
      hits: {
        count,
        kind: Uint8Array.from(this.hitKind.a.subarray(0, count)),
        geom,
        pts,
        ent: Int32Array.from(this.hitEnt.a.subarray(0, count)),
        seg: Int32Array.from(this.hitSeg.a.subarray(0, count)),
        group: Int32Array.from(this.hitGroup.a.subarray(0, count)),
        index,
      },
      entities: this.entities,
      info: {
        version: (headerValue(doc, '$ACADVER') ?? '').trim(),
        insunits: Number(headerValue(doc, '$INSUNITS') ?? 0) || 0,
        measurement: headerValue(doc, '$MEASUREMENT') !== undefined ? headerNumber(doc, '$MEASUREMENT', -1) : -1,
        precision: headerValue(doc, '$LUPREC') !== undefined ? headerNumber(doc, '$LUPREC', -1) : -1,
        encoding: doc.encoding,
        binary: doc.binary,
        entityCount: doc.entities.length,
        primitiveCount: this.primitives,
        bytes,
        parseMs: 0,
        flattenMs: 0,
        skipped: doc.unsupported,
      },
    };
  }

  topCtx(ox = 0, oy = 0): Ctx {
    return {
      m: translate(-ox, -oy, 0),
      layer0: -1,
      outer: [],
      byBlockColor: FG,
      byBlockLinetype: 'CONTINUOUS',
      annotation: false,
      block: undefined,
      depth: 0,
      stack: [],
      styles: new Map(),
    };
  }
}

/** Stroke batches above this many path numbers are split into spatial tiles. */
const SPLIT_THRESHOLD = 120_000;
const GRID = 8;

/** Length of the path command starting at i. */
function opLength(op: number): number {
  return op === OP_ARC ? 7 : op === OP_ELLIPSE ? 9 : op === OP_CLOSE ? 1 : 3;
}

/**
 * Splits a large batch into up to GRID × GRID tiles by the start point of each
 * subpath, so zoomed-in views only stroke nearby geometry.
 */
function splitBatch(b: Batch): Batch[] {
  const c = b.cmds;
  if (c.length < SPLIT_THRESHOLD || b.infinite || !boxValid(b.bbox)) return [b];
  const [x0, y0, x1, y1] = b.bbox;
  const cw = (x1 - x0) / GRID || 1;
  const ch = (y1 - y0) / GRID || 1;
  const cells: F64[] = [];
  const boxes: number[][] = [];
  let cell: F64 | null = null;
  let box: number[] | null = null;
  let i = 0;
  while (i < c.length) {
    const op = c[i];
    const n = opLength(op);
    if (op === OP_MOVE) {
      const gx = Math.min(GRID - 1, Math.max(0, Math.floor((c[i + 1] - x0) / cw)));
      const gy = Math.min(GRID - 1, Math.max(0, Math.floor((c[i + 2] - y0) / ch)));
      const k = gy * GRID + gx;
      cell = cells[k] ??= new F64();
      box = boxes[k] ??= emptyBox();
    }
    if (!cell || !box) {
      cell = cells[0] ??= new F64();
      box = boxes[0] ??= emptyBox();
    }
    for (let j = 0; j < n; j++) cell.push(c[i + j]);
    if (op === OP_MOVE || op === OP_LINE) boxAdd(box, c[i + 1], c[i + 2]);
    else if (op === OP_ARC || op === OP_ELLIPSE) {
      const r = op === OP_ARC ? c[i + 3] : Math.max(c[i + 3], c[i + 4]);
      boxAdd(box, c[i + 1] - r, c[i + 2] - r);
      boxAdd(box, c[i + 1] + r, c[i + 2] + r);
    }
    i += n;
  }
  const out: Batch[] = [];
  cells.forEach((cellBuf, k) => {
    if (!cellBuf) return;
    const bb = boxes[k];
    // Keep tiles within the parent box (arcs were bounded conservatively).
    const tile = [Math.max(bb[0], x0), Math.max(bb[1], y0), Math.min(bb[2], x1), Math.min(bb[3], y1)];
    out.push({ ...b, cmds: cellBuf.out(), points: out.length === 0 ? b.points : null, bbox: tile });
  });
  return out;
}

/**
 * Picks the local-coordinate origin: somewhere inside the drawing, so that
 * survey-scale coordinates (e.g. UTM) keep full precision in float32 paths.
 */
function guessOrigin(doc: DxfDocument): [number, number] {
  const pt = (name: string) => {
    const tags = doc.header.get(name);
    const x = Number(tags?.find((t) => t[0] === 10)?.[1]);
    const y = Number(tags?.find((t) => t[0] === 20)?.[1]);
    return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) < 1e15 && Math.abs(y) < 1e15 ? { x, y } : null;
  };
  const lo = pt('$EXTMIN');
  const hi = pt('$EXTMAX');
  if (lo && hi && hi.x >= lo.x && hi.y >= lo.y) return [(lo.x + hi.x) / 2, (lo.y + hi.y) / 2];
  for (const e of doc.entities) {
    if (e.extrusion && !(e.extrusion.z > 0 && Math.abs(e.extrusion.x) < 1e-9 && Math.abs(e.extrusion.y) < 1e-9)) continue;
    const p: V3 | undefined =
      e.type === 'LINE'
        ? e.p1
        : e.type === 'CIRCLE' || e.type === 'ARC'
          ? e.c
          : e.type === 'LWPOLYLINE' || e.type === 'POLYLINE'
            ? e.verts[0]
            : e.type === 'POINT' || e.type === 'INSERT' || e.type === 'TEXT' || e.type === 'MTEXT'
              ? e.p
              : undefined;
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return [p.x, p.y];
  }
  return [0, 0];
}

export function flatten(doc: DxfDocument, bytes = 0): RenderModel {
  const f = new Flattener(doc);
  const origin = guessOrigin(doc);
  const ctx = f.topCtx(origin[0], origin[1]);
  const ann = { ...ctx, annotation: true };
  for (const e of doc.entities) {
    const annotation = e.type === 'TEXT' || e.type === 'MTEXT' || e.type === 'DIMENSION' || e.type === 'LEADER' || e.type === 'ACAD_TABLE';
    f.entity(e, annotation ? ann : ctx);
  }
  return f.finish(doc, bytes, origin);
}

/** Transferable buffers of a model (for postMessage). */
export function transferables(m: RenderModel): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const b of m.batches) {
    out.push(b.cmds.buffer as ArrayBuffer);
    if (b.points) out.push(b.points.buffer as ArrayBuffer);
  }
  const h = m.hits;
  for (const a of [h.kind, h.geom, h.pts, h.ent, h.seg, h.group]) out.push(a.buffer as ArrayBuffer);
  if (h.index) out.push(h.index);
  return out;
}
