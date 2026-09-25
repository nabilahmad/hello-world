/**
 * Streaming DXF parser: HEADER, TABLES (LAYER, LTYPE), BLOCKS and ENTITIES.
 * Unknown sections, tables and entity types are skipped.
 */
import { createTagReader, type TagReader } from './reader';
import type {
  ArcEntity,
  Block,
  BlockGraphicEntity,
  CircleEntity,
  DxfDocument,
  EllipseEntity,
  Entity,
  EntityBase,
  HatchEdge,
  HatchEntity,
  HatchLoop,
  InsertEntity,
  Layer,
  LeaderEntity,
  LineEntity,
  Linetype,
  LwPolylineEntity,
  MTextEntity,
  PointEntity,
  PolylineEntity,
  PolyVertex,
  RayEntity,
  SolidEntity,
  SplineEntity,
  TextEntity,
  V3,
} from './types';

// Tags of the record currently being decoded (reused to avoid allocations).
const TC: number[] = [];
const TV: string[] = [];
let TN = 0;

/** Reads the tags following a code-0 record start, up to the next code 0. */
function collect(r: TagReader): void {
  TN = 0;
  while (r.next()) {
    if (r.code === 0) return;
    TC[TN] = r.code;
    TV[TN] = r.value;
    TN++;
  }
}

function num(s: string): number {
  const v = Number(s);
  return Number.isFinite(v) ? v : 0;
}

function int(s: string): number {
  const v = parseInt(s, 10);
  return Number.isFinite(v) ? v : 0;
}

const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });
const vertex = (x = 0, y = 0, z = 0): PolyVertex => ({ x, y, z, bulge: 0, flags: 0 });

function base(type: string): EntityBase {
  return {
    type,
    handle: '',
    layer: '0',
    color: 256,
    trueColor: -1,
    linetype: '',
    ltscale: 1,
    invisible: false,
    paperSpace: false,
    extrusion: null,
  };
}

/** Applies a tag shared by all entities. Returns false if the code is not a common one. */
function common(e: EntityBase, code: number, v: string): boolean {
  switch (code) {
    case 5:
      e.handle = v.trim();
      return true;
    case 8:
      e.layer = v.trim() || '0';
      return true;
    case 62:
      e.color = int(v);
      return true;
    case 420:
      e.trueColor = int(v) & 0xffffff;
      return true;
    case 6:
      e.linetype = v.trim();
      return true;
    case 48:
      e.ltscale = num(v) || 1;
      return true;
    case 60:
      e.invisible = int(v) === 1;
      return true;
    case 67:
      e.paperSpace = int(v) === 1;
      return true;
    case 210:
      (e.extrusion ??= v3(0, 0, 1)).x = num(v);
      return true;
    case 220:
      (e.extrusion ??= v3(0, 0, 1)).y = num(v);
      return true;
    case 230:
      (e.extrusion ??= v3(0, 0, 1)).z = num(v);
      return true;
  }
  return false;
}

/** Sets x/y/z of `p` for codes base, base+10, base+20. */
function coord(p: V3, code: number, baseCode: number, v: string): boolean {
  if (code === baseCode) p.x = num(v);
  else if (code === baseCode + 10) p.y = num(v);
  else if (code === baseCode + 20) p.z = num(v);
  else return false;
  return true;
}

function buildLine(): LineEntity {
  const e = { ...base('LINE'), type: 'LINE', p1: v3(), p2: v3() } as LineEntity;
  for (let i = 0; i < TN; i++) {
    const c = TC[i];
    const v = TV[i];
    if (!coord(e.p1, c, 10, v) && !coord(e.p2, c, 11, v)) common(e, c, v);
  }
  return e;
}

function buildPoint(): PointEntity {
  const e = { ...base('POINT'), type: 'POINT', p: v3() } as PointEntity;
  for (let i = 0; i < TN; i++) if (!coord(e.p, TC[i], 10, TV[i])) common(e, TC[i], TV[i]);
  return e;
}

function buildCircle(): CircleEntity {
  const e = { ...base('CIRCLE'), type: 'CIRCLE', c: v3(), r: 0 } as CircleEntity;
  for (let i = 0; i < TN; i++) {
    const c = TC[i];
    const v = TV[i];
    if (coord(e.c, c, 10, v)) continue;
    if (c === 40) e.r = num(v);
    else common(e, c, v);
  }
  return e;
}

function buildArc(): ArcEntity {
  const e = { ...base('ARC'), type: 'ARC', c: v3(), r: 0, a0: 0, a1: 360 } as ArcEntity;
  for (let i = 0; i < TN; i++) {
    const c = TC[i];
    const v = TV[i];
    if (coord(e.c, c, 10, v)) continue;
    if (c === 40) e.r = num(v);
    else if (c === 50) e.a0 = num(v);
    else if (c === 51) e.a1 = num(v);
    else common(e, c, v);
  }
  return e;
}

function buildEllipse(): EllipseEntity {
  const e = {
    ...base('ELLIPSE'),
    type: 'ELLIPSE',
    c: v3(),
    major: v3(1, 0, 0),
    ratio: 1,
    t0: 0,
    t1: Math.PI * 2,
  } as EllipseEntity;
  for (let i = 0; i < TN; i++) {
    const c = TC[i];
    const v = TV[i];
    if (coord(e.c, c, 10, v) || coord(e.major, c, 11, v)) continue;
    if (c === 40) e.ratio = num(v);
    else if (c === 41) e.t0 = num(v);
    else if (c === 42) e.t1 = num(v);
    else common(e, c, v);
  }
  return e;
}

function buildLwPolyline(): LwPolylineEntity {
  const e = {
    ...base('LWPOLYLINE'),
    type: 'LWPOLYLINE',
    verts: [],
    closed: false,
    elevation: 0,
    width: 0,
  } as LwPolylineEntity;
  let last: PolyVertex | null = null;
  for (let i = 0; i < TN; i++) {
    const c = TC[i];
    const v = TV[i];
    switch (c) {
      case 10:
        last = vertex(num(v));
        e.verts.push(last);
        break;
      case 20:
        if (last) last.y = num(v);
        break;
      case 42:
        if (last) last.bulge = num(v);
        break;
      case 70:
        e.closed = (int(v) & 1) === 1;
        break;
      case 38:
        e.elevation = num(v);
        break;
      case 43:
        e.width = num(v);
        break;
      case 40:
      case 41:
      case 90:
      case 91:
        break;
      default:
        common(e, c, v);
    }
  }
  for (const vx of e.verts) vx.z = e.elevation;
  return e;
}

function buildPolylineHeader(): { pl: PolylineEntity; elevation: number } {
  const e = {
    ...base('POLYLINE'),
    type: 'POLYLINE',
    verts: [],
    flags: 0,
    meshM: 0,
    meshN: 0,
    faces: [],
    width: 0,
  } as PolylineEntity;
  let w0 = 0;
  let w1 = 0;
  let elevation = 0;
  for (let i = 0; i < TN; i++) {
    const c = TC[i];
    const v = TV[i];
    switch (c) {
      case 70:
        e.flags = int(v);
        break;
      case 71:
        e.meshM = int(v);
        break;
      case 72:
        e.meshN = int(v);
        break;
      case 40:
        w0 = num(v);
        break;
      case 41:
        w1 = num(v);
        break;
      case 30:
        elevation = num(v);
        break;
      case 10:
      case 20:
      case 66:
      case 75:
        break;
      default:
        common(e, c, v);
    }
  }
  if (w0 === w1) e.width = w0;
  return { pl: e, elevation };
}

function readVertexInto(e: PolylineEntity): void {
  const vx = vertex();
  const face: number[] = [];
  for (let i = 0; i < TN; i++) {
    const c = TC[i];
    const v = TV[i];
    switch (c) {
      case 10:
        vx.x = num(v);
        break;
      case 20:
        vx.y = num(v);
        break;
      case 30:
        vx.z = num(v);
        break;
      case 42:
        vx.bulge = num(v);
        break;
      case 70:
        vx.flags = int(v);
        break;
      case 71:
      case 72:
      case 73:
      case 74:
        face[c - 71] = int(v);
        break;
    }
  }
  // Polyface face records carry flag 128 without 64.
  if ((e.flags & 64) !== 0 && (vx.flags & 128) !== 0 && (vx.flags & 64) === 0) {
    e.faces.push(face.filter((n) => n !== 0 && n !== undefined));
  } else {
    e.verts.push(vx);
  }
}

function buildText(type: 'TEXT' | 'ATTRIB'): TextEntity {
  const e = {
    ...base(type),
    type,
    p: v3(),
    p2: null,
    h: 1,
    text: '',
    rot: 0,
    widthFactor: 1,
    oblique: 0,
    style: 'STANDARD',
    hAlign: 0,
    vAlign: 0,
    gen: 0,
  } as TextEntity;
  let attFlags = 0;
  for (let i = 0; i < TN; i++) {
    const c = TC[i];
    const v = TV[i];
    if (c === 101) break; // embedded MTEXT data of multi-line attributes
    if (coord(e.p, c, 10, v)) continue;
    if (c === 11 || c === 21 || c === 31) {
      coord((e.p2 ??= v3()), c, 11, v);
      continue;
    }
    switch (c) {
      case 1:
        e.text = v;
        break;
      case 40:
        e.h = num(v);
        break;
      case 50:
        e.rot = num(v);
        break;
      case 41:
        e.widthFactor = num(v) || 1;
        break;
      case 51:
        e.oblique = num(v);
        break;
      case 7:
        e.style = v.trim();
        break;
      case 71:
        e.gen = int(v);
        break;
      case 72:
        e.hAlign = int(v);
        break;
      case 73:
        if (type === 'TEXT') e.vAlign = int(v);
        break;
      case 74:
        if (type === 'ATTRIB') e.vAlign = int(v);
        break;
      case 70:
        if (type === 'ATTRIB') attFlags = int(v);
        break;
      case 2:
      case 3:
      case 100:
        break;
      default:
        common(e, c, v);
    }
  }
  if (attFlags & 1) e.invisible = true;
  return e;
}

function buildMText(): MTextEntity {
  const e = {
    ...base('MTEXT'),
    type: 'MTEXT',
    p: v3(),
    h: 1,
    width: 0,
    attach: 1,
    text: '',
    rot: 0,
    xdir: null,
    lineSpacing: 1,
    style: 'STANDARD',
  } as MTextEntity;
  for (let i = 0; i < TN; i++) {
    const c = TC[i];
    const v = TV[i];
    if (c === 101) break; // column / embedded object data
    if (coord(e.p, c, 10, v)) continue;
    if (c === 11 || c === 21 || c === 31) {
      coord((e.xdir ??= v3()), c, 11, v);
      continue;
    }
    switch (c) {
      case 1:
      case 3:
        e.text += v;
        break;
      case 40:
        e.h = num(v);
        break;
      case 41:
        e.width = num(v);
        break;
      case 71:
        e.attach = int(v) || 1;
        break;
      case 50:
        e.rot = num(v);
        break;
      case 44:
        e.lineSpacing = num(v) || 1;
        break;
      case 7:
        e.style = v.trim();
        break;
      default:
        common(e, c, v);
    }
  }
  return e;
}

function buildInsert(): InsertEntity {
  const e = {
    ...base('INSERT'),
    type: 'INSERT',
    name: '',
    p: v3(),
    sx: 1,
    sy: 1,
    sz: 1,
    rot: 0,
    cols: 1,
    rows: 1,
    colSpacing: 0,
    rowSpacing: 0,
    attribs: [],
  } as InsertEntity;
  for (let i = 0; i < TN; i++) {
    const c = TC[i];
    const v = TV[i];
    if (coord(e.p, c, 10, v)) continue;
    switch (c) {
      case 2:
        e.name = v.trim();
        break;
      case 41:
        e.sx = num(v);
        break;
      case 42:
        e.sy = num(v);
        break;
      case 43:
        e.sz = num(v);
        break;
      case 50:
        e.rot = num(v);
        break;
      case 70:
        e.cols = Math.max(1, int(v));
        break;
      case 71:
        e.rows = Math.max(1, int(v));
        break;
      case 44:
        e.colSpacing = num(v);
        break;
      case 45:
        e.rowSpacing = num(v);
        break;
      case 66:
      case 100:
        break;
      default:
        common(e, c, v);
    }
  }
  return e;
}

function buildBlockGraphic(type: 'DIMENSION' | 'ACAD_TABLE'): BlockGraphicEntity {
  const e = { ...base(type), type, block: '', p: v3() } as BlockGraphicEntity;
  for (let i = 0; i < TN; i++) {
    const c = TC[i];
    const v = TV[i];
    if (c === 100 && v.trim() === 'AcDbTable') break;
    if (c === 2) e.block = v.trim();
    else if (type === 'DIMENSION' ? coord(e.p, c, 12, v) : coord(e.p, c, 10, v)) continue;
    else common(e, c, v);
  }
  return e;
}

function buildSolid(type: 'SOLID' | 'TRACE' | '3DFACE'): SolidEntity {
  const pts = [v3(), v3(), v3(), v3()];
  const e = { ...base(type), type, pts, edgeFlags: 0 } as SolidEntity;
  let has4 = false;
  for (let i = 0; i < TN; i++) {
    const c = TC[i];
    const v = TV[i];
    if (c >= 10 && c <= 33 && c % 10 <= 3) {
      const k = c % 10;
      const axis = Math.floor(c / 10);
      const p = pts[k];
      if (axis === 1) p.x = num(v);
      else if (axis === 2) p.y = num(v);
      else p.z = num(v);
      if (k === 3) has4 = true;
    } else if (c === 70) e.edgeFlags = int(v);
    else common(e, c, v);
  }
  if (!has4) pts[3] = { ...pts[2] };
  return e;
}

function buildLeader(): LeaderEntity {
  const e = { ...base('LEADER'), type: 'LEADER', pts: [], arrow: true } as LeaderEntity;
  let last: V3 | null = null;
  for (let i = 0; i < TN; i++) {
    const c = TC[i];
    const v = TV[i];
    if (c === 10) {
      last = v3(num(v));
      e.pts.push(last);
    } else if (c === 20) {
      if (last) last.y = num(v);
    } else if (c === 30) {
      if (last) last.z = num(v);
    } else if (c === 71) e.arrow = int(v) !== 0;
    else common(e, c, v);
  }
  return e;
}

function buildRay(type: 'RAY' | 'XLINE'): RayEntity {
  const e = { ...base(type), type, p: v3(), dir: v3(1, 0, 0) } as RayEntity;
  for (let i = 0; i < TN; i++) {
    const c = TC[i];
    const v = TV[i];
    if (!coord(e.p, c, 10, v) && !coord(e.dir, c, 11, v)) common(e, c, v);
  }
  return e;
}

function buildSpline(): SplineEntity {
  const e = {
    ...base('SPLINE'),
    type: 'SPLINE',
    degree: 3,
    flags: 0,
    knots: [],
    weights: [],
    ctrl: [],
    fit: [],
  } as SplineEntity;
  let cp: V3 | null = null;
  let fp: V3 | null = null;
  for (let i = 0; i < TN; i++) {
    const c = TC[i];
    const v = TV[i];
    switch (c) {
      case 10:
        cp = v3(num(v));
        e.ctrl.push(cp);
        break;
      case 20:
        if (cp) cp.y = num(v);
        break;
      case 30:
        if (cp) cp.z = num(v);
        break;
      case 11:
        fp = v3(num(v));
        e.fit.push(fp);
        break;
      case 21:
        if (fp) fp.y = num(v);
        break;
      case 31:
        if (fp) fp.z = num(v);
        break;
      case 40:
        e.knots.push(num(v));
        break;
      case 41:
        e.weights.push(num(v));
        break;
      case 70:
        e.flags = int(v);
        break;
      case 71:
        e.degree = int(v) || 3;
        break;
      // The SPLINE normal (210) is not an OCS: control points are WCS.
      case 210:
      case 220:
      case 230:
        break;
      default:
        common(e, c, v);
    }
  }
  return e;
}

/** HATCH: boundary loops and pattern lines are positional, so walk the tags in order. */
function buildHatch(version: string): HatchEntity {
  const e = {
    ...base('HATCH'),
    type: 'HATCH',
    solid: false,
    pattern: '',
    elevation: 0,
    loops: [],
    lines: [],
  } as HatchEntity;
  let i = 0;
  let nLoops = 0;
  for (; i < TN; i++) {
    const c = TC[i];
    const v = TV[i];
    if (c === 91) {
      nLoops = int(v);
      i++;
      break;
    }
    if (c === 30) e.elevation = num(v);
    else if (c === 2) e.pattern = v.trim();
    else if (c === 70) e.solid = int(v) === 1;
    else common(e, c, v);
  }
  const at = (code: number): boolean => i < TN && TC[i] === code;
  const take = (code: number, fallback = 0): number => (at(code) ? num(TV[i++]) : fallback);
  const r2010 = version >= 'AC1024';

  for (let L = 0; L < nLoops && i < TN; L++) {
    while (i < TN && TC[i] !== 92) i++;
    if (i >= TN) break;
    const loop: HatchLoop = { flags: int(TV[i++]) };
    if (loop.flags & 2) {
      let hasBulge = false;
      let closed = true;
      let n = 0;
      while (i < TN && TC[i] !== 10) {
        if (TC[i] === 72) hasBulge = int(TV[i]) !== 0;
        else if (TC[i] === 73) closed = int(TV[i]) !== 0;
        else if (TC[i] === 93) n = int(TV[i]);
        else if (TC[i] === 92 || TC[i] === 97) break;
        i++;
      }
      const verts: PolyVertex[] = [];
      for (let k = 0; k < n && at(10); k++) {
        const vx = vertex(take(10), take(20));
        if (hasBulge) vx.bulge = take(42);
        verts.push(vx);
      }
      loop.verts = verts;
      loop.closed = closed;
    } else {
      while (i < TN && TC[i] !== 93 && TC[i] !== 92) i++;
      const nEdges = at(93) ? int(TV[i++]) : 0;
      const edges: HatchEdge[] = [];
      for (let k = 0; k < nEdges && at(72); k++) {
        const type = int(TV[i++]);
        if (type === 1) {
          edges.push({ t: 'line', x1: take(10), y1: take(20), x2: take(11), y2: take(21) });
        } else if (type === 2) {
          const cx = take(10);
          const cy = take(20);
          const r = take(40);
          const s = take(50);
          const en = take(51);
          const ccw = take(73, 1) !== 0;
          // Clockwise edges store complementary angles (360 - a); normalise to CCW.
          edges.push(
            ccw
              ? { t: 'arc', cx, cy, r, a0: s, a1: en, ccw }
              : { t: 'arc', cx, cy, r, a0: 360 - en, a1: 360 - s, ccw },
          );
        } else if (type === 3) {
          const cx = take(10);
          const cy = take(20);
          const mx = take(11);
          const my = take(21);
          const ratio = take(40, 1);
          const s = take(50);
          const en = take(51);
          const ccw = take(73, 1) !== 0;
          edges.push(
            ccw
              ? { t: 'ellipse', cx, cy, mx, my, ratio, a0: s, a1: en, ccw }
              : { t: 'ellipse', cx, cy, mx, my, ratio, a0: 360 - en, a1: 360 - s, ccw },
          );
        } else if (type === 4) {
          const degree = take(94, 3);
          const rational = take(73) !== 0;
          take(74);
          const nKnots = take(95);
          const nCtrl = take(96);
          const knots: number[] = [];
          for (let q = 0; q < nKnots && at(40); q++) knots.push(take(40));
          const ctrl: V3[] = [];
          const weights: number[] = [];
          for (let q = 0; q < nCtrl && at(10); q++) {
            ctrl.push(v3(take(10), take(20)));
            if (rational || at(42)) weights.push(take(42, 1));
          }
          const fit: V3[] = [];
          if (r2010 && at(97)) {
            const nFit = take(97);
            for (let q = 0; q < nFit && at(11); q++) fit.push(v3(take(11), take(21)));
            // Start/end tangents are not needed to draw the interpolated curve.
            while (at(12) || at(22) || at(13) || at(23)) i++;
          }
          edges.push({ t: 'spline', degree, knots, ctrl, weights, fit });
        } else {
          break;
        }
      }
      loop.edges = edges;
    }
    if (at(97)) {
      const nSrc = take(97);
      for (let q = 0; q < nSrc && at(330); q++) i++;
    }
    e.loops.push(loop);
  }

  for (; i < TN; i++) {
    const c = TC[i];
    if (c === 98) break; // seed points
    if (c === 78) {
      const n = int(TV[i++]);
      for (let k = 0; k < n && at(53); k++) {
        const line = {
          angle: take(53),
          bx: take(43),
          by: take(44),
          ox: take(45),
          oy: take(46),
          dashes: [] as number[],
        };
        const nd = take(79);
        for (let q = 0; q < nd && at(49); q++) line.dashes.push(take(49));
        e.lines.push(line);
      }
      i--;
      continue;
    }
    common(e, c, TV[i]);
  }
  return e;
}

function buildEntity(type: string, version: string): Entity | null {
  switch (type) {
    case 'LINE':
      return buildLine();
    case 'POINT':
      return buildPoint();
    case 'CIRCLE':
      return buildCircle();
    case 'ARC':
      return buildArc();
    case 'ELLIPSE':
      return buildEllipse();
    case 'LWPOLYLINE':
      return buildLwPolyline();
    case 'SPLINE':
      return buildSpline();
    case 'TEXT':
      return buildText('TEXT');
    case 'MTEXT':
      return buildMText();
    case 'INSERT':
      return buildInsert();
    case 'DIMENSION':
    case 'ACAD_TABLE':
      return buildBlockGraphic(type);
    case 'SOLID':
    case 'TRACE':
    case '3DFACE':
      return buildSolid(type);
    case 'LEADER':
      return buildLeader();
    case 'RAY':
    case 'XLINE':
      return buildRay(type);
    case 'HATCH':
      return buildHatch(version);
  }
  return null;
}

/** True when the INSERT tags announce trailing ATTRIB entities (66 = 1). */
function hasAttribs(): boolean {
  for (let i = 0; i < TN; i++) if (TC[i] === 66) return int(TV[i]) === 1;
  return false;
}

/**
 * Reads entities until a code-0 record whose type is in `stop` (left as the
 * reader's current tag). Expects the reader to be positioned on a code-0 tag.
 */
function readEntities(r: TagReader, stop: Set<string>, version: string, unsupported: Record<string, number>): Entity[] {
  const out: Entity[] = [];
  while (r.code >= 0) {
    if (r.code !== 0) {
      if (!r.next()) break;
      continue;
    }
    const type = r.value.trim();
    if (stop.has(type)) break;
    collect(r);
    if (type === 'POLYLINE') {
      // 2D polylines keep their elevation in the header's dummy point.
      const { pl, elevation } = buildPolylineHeader();
      while (r.code === 0 && r.value.trim() === 'VERTEX') {
        collect(r);
        readVertexInto(pl);
      }
      if (r.code === 0 && r.value.trim() === 'SEQEND') collect(r);
      if ((pl.flags & (8 | 16 | 64)) === 0) for (const vx of pl.verts) vx.z = elevation;
      out.push(pl);
      continue;
    }
    const e = buildEntity(type, version);
    if (e && e.type === 'INSERT' && hasAttribs()) {
      while (r.code === 0 && r.value.trim() === 'ATTRIB') {
        collect(r);
        e.attribs.push(buildText('ATTRIB'));
      }
      if (r.code === 0 && r.value.trim() === 'SEQEND') collect(r);
    }
    if (e) out.push(e);
    else if (type !== 'SEQEND' && type !== 'VERTEX' && type !== 'ATTRIB' && type !== 'ATTDEF')
      unsupported[type] = (unsupported[type] ?? 0) + 1;
  }
  return out;
}

function readHeader(r: TagReader, doc: DxfDocument): void {
  let current: Array<[number, string]> | null = null;
  while (r.next()) {
    if (r.code === 0) return; // ENDSEC
    if (r.code === 9) {
      current = [];
      doc.header.set(r.value.trim(), current);
    } else if (current) {
      current.push([r.code, r.value]);
    }
  }
}

function readTables(r: TagReader, doc: DxfDocument): void {
  r.next();
  while (r.code >= 0) {
    if (r.code !== 0) {
      if (!r.next()) return;
      continue;
    }
    const type = r.value.trim();
    if (type === 'ENDSEC') return;
    collect(r);
    if (type === 'LAYER') {
      const layer: Layer = {
        name: '0',
        color: 7,
        trueColor: -1,
        linetype: 'CONTINUOUS',
        off: false,
        frozen: false,
      };
      for (let i = 0; i < TN; i++) {
        const c = TC[i];
        const v = TV[i];
        if (c === 2) layer.name = v.trim();
        else if (c === 62) {
          const color = int(v);
          layer.off = color < 0;
          layer.color = Math.abs(color) || 7;
        } else if (c === 420) layer.trueColor = int(v) & 0xffffff;
        else if (c === 6) layer.linetype = v.trim();
        else if (c === 70) layer.frozen = (int(v) & 1) === 1;
      }
      doc.layers.set(layer.name.toUpperCase(), layer);
    } else if (type === 'LTYPE') {
      const lt: Linetype = { name: '', pattern: [] };
      for (let i = 0; i < TN; i++) {
        if (TC[i] === 2) lt.name = TV[i].trim();
        else if (TC[i] === 49) lt.pattern.push(num(TV[i]));
      }
      if (lt.name) doc.linetypes.set(lt.name.toUpperCase(), lt);
    }
  }
}

function readBlocks(r: TagReader, doc: DxfDocument, version: string): void {
  r.next();
  const stop = new Set(['ENDBLK', 'ENDSEC']);
  while (r.code >= 0) {
    if (r.code !== 0) {
      if (!r.next()) return;
      continue;
    }
    const type = r.value.trim();
    if (type === 'ENDSEC') return;
    collect(r);
    if (type !== 'BLOCK') continue;
    const block: Block = { name: '', base: v3(), flags: 0, entities: [] };
    for (let i = 0; i < TN; i++) {
      const c = TC[i];
      const v = TV[i];
      if (c === 2) block.name = v.trim();
      else if (c === 3 && !block.name) block.name = v.trim();
      else if (c === 70) block.flags = int(v);
      else coord(block.base, c, 10, v);
    }
    block.entities = readEntities(r, stop, version, doc.unsupported);
    if (r.code === 0 && r.value.trim() === 'ENDBLK') collect(r);
    doc.blocks.set(block.name.toUpperCase(), block);
  }
}

function skipSection(r: TagReader): void {
  while (r.next()) if (r.code === 0 && r.value.trim() === 'ENDSEC') return;
}

export function headerValue(doc: DxfDocument, name: string, code?: number): string | undefined {
  const tags = doc.header.get(name);
  if (!tags || tags.length === 0) return undefined;
  if (code === undefined) return tags[0][1];
  return tags.find((t) => t[0] === code)?.[1];
}

export function headerNumber(doc: DxfDocument, name: string, fallback: number): number {
  const v = headerValue(doc, name);
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function parseDxf(bytes: Uint8Array): DxfDocument {
  const { reader: r, encoding, binary } = createTagReader(bytes);
  const doc: DxfDocument = {
    header: new Map(),
    layers: new Map(),
    linetypes: new Map(),
    blocks: new Map(),
    entities: [],
    unsupported: {},
    encoding,
    binary,
  };
  let version = '';
  let sawEntities = false;
  while (r.next()) {
    if (r.code !== 0) continue;
    const v = r.value.trim();
    if (v === 'EOF') break;
    if (v !== 'SECTION') continue;
    if (!r.next()) break;
    const name = r.value.trim().toUpperCase();
    if (name === 'HEADER') {
      readHeader(r, doc);
      version = (headerValue(doc, '$ACADVER') ?? '').trim();
    } else if (name === 'TABLES') {
      readTables(r, doc);
    } else if (name === 'BLOCKS') {
      readBlocks(r, doc, version);
    } else if (name === 'ENTITIES') {
      sawEntities = true;
      r.next();
      for (const e of readEntities(r, new Set(['ENDSEC']), version, doc.unsupported)) {
        if (!e.paperSpace) doc.entities.push(e);
      }
    } else {
      skipSection(r);
    }
  }
  // Some writers keep model space only in the *Model_Space block.
  if (doc.entities.length === 0) {
    const ms = doc.blocks.get('*MODEL_SPACE');
    if (ms && (ms.entities.length > 0 || !sawEntities)) doc.entities = ms.entities.filter((e) => !e.paperSpace);
  }
  return doc;
}
