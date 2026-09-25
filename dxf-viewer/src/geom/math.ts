/** 3D affine matrices, OCS, and arcs under affine transforms, projected to the XY plane. */
import type { V3 } from '../dxf/types';

/**
 * Affine 3D transform, row-major linear part + translation:
 *   x' = m[0] x + m[1] y + m[2] z + m[9]
 *   y' = m[3] x + m[4] y + m[5] z + m[10]
 *   z' = m[6] x + m[7] y + m[8] z + m[11]
 */
export type Mat = number[];

export const TAU = Math.PI * 2;

export const identity = (): Mat => [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

/** a ∘ b (apply b first). */
export function mul(a: Mat, b: Mat): Mat {
  return [
    a[0] * b[0] + a[1] * b[3] + a[2] * b[6],
    a[0] * b[1] + a[1] * b[4] + a[2] * b[7],
    a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
    a[3] * b[0] + a[4] * b[3] + a[5] * b[6],
    a[3] * b[1] + a[4] * b[4] + a[5] * b[7],
    a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
    a[6] * b[0] + a[7] * b[3] + a[8] * b[6],
    a[6] * b[1] + a[7] * b[4] + a[8] * b[7],
    a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
    a[0] * b[9] + a[1] * b[10] + a[2] * b[11] + a[9],
    a[3] * b[9] + a[4] * b[10] + a[5] * b[11] + a[10],
    a[6] * b[9] + a[7] * b[10] + a[8] * b[11] + a[11],
  ];
}

export const translate = (x: number, y: number, z: number): Mat => [1, 0, 0, 0, 1, 0, 0, 0, 1, x, y, z];
export const scale = (x: number, y: number, z: number): Mat => [x, 0, 0, 0, y, 0, 0, 0, z, 0, 0, 0];

export function rotateZ(rad: number): Mat {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [c, -s, 0, s, c, 0, 0, 0, 1, 0, 0, 0];
}

function norm(v: V3): V3 | null {
  const l = Math.hypot(v.x, v.y, v.z);
  return l > 1e-12 ? { x: v.x / l, y: v.y / l, z: v.z / l } : null;
}

const cross = (a: V3, b: V3): V3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

/** Unit normal of an extrusion vector (default +Z). */
export function normalOf(ext: V3 | null): V3 {
  return (ext && norm(ext)) || { x: 0, y: 0, z: 1 };
}

/**
 * Object Coordinate System → WCS via the DXF "arbitrary axis algorithm".
 * Returns null for the default +Z extrusion (identity).
 */
export function ocs(ext: V3 | null): Mat | null {
  if (!ext) return null;
  const n = norm(ext);
  if (!n || (Math.abs(n.x) < 1e-12 && Math.abs(n.y) < 1e-12 && n.z > 0)) return null;
  const ax = norm(
    Math.abs(n.x) < 1 / 64 && Math.abs(n.y) < 1 / 64 ? cross({ x: 0, y: 1, z: 0 }, n) : cross({ x: 0, y: 0, z: 1 }, n),
  )!;
  const ay = norm(cross(n, ax))!;
  return [ax.x, ay.x, n.x, ax.y, ay.y, n.y, ax.z, ay.z, n.z, 0, 0, 0];
}

export function withOcs(m: Mat, ext: V3 | null): Mat {
  const o = ocs(ext);
  return o ? mul(m, o) : m;
}

export const px = (m: Mat, x: number, y: number, z: number): number => m[0] * x + m[1] * y + m[2] * z + m[9];
export const py = (m: Mat, x: number, y: number, z: number): number => m[3] * x + m[4] * y + m[5] * z + m[10];

/** Determinant of the XY-projected linear part (area scale factor, sign = handedness). */
export const det2 = (m: Mat): number => m[0] * m[4] - m[1] * m[3];

/**
 * An arc P(t) = C + U cos t + V sin t for t from t0 to t1 (either direction),
 * i.e. any circle/ellipse arc after an affine transform, in 2D.
 */
export interface Arc2 {
  cx: number;
  cy: number;
  ux: number;
  uy: number;
  vx: number;
  vy: number;
  t0: number;
  t1: number;
}

export function transformArc(
  m: Mat,
  c: V3,
  u: [number, number, number],
  v: [number, number, number],
  t0: number,
  t1: number,
): Arc2 {
  return {
    cx: px(m, c.x, c.y, c.z),
    cy: py(m, c.x, c.y, c.z),
    ux: m[0] * u[0] + m[1] * u[1] + m[2] * u[2],
    uy: m[3] * u[0] + m[4] * u[1] + m[5] * u[2],
    vx: m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    vy: m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    t0,
    t1,
  };
}

export const arcX = (a: Arc2, t: number): number => a.cx + a.ux * Math.cos(t) + a.vx * Math.sin(t);
export const arcY = (a: Arc2, t: number): number => a.cy + a.uy * Math.cos(t) + a.vy * Math.sin(t);

export type ArcShape =
  /** Circular: canvas arc(cx, cy, r, start, end, anticlockwise). */
  | { kind: 'circle'; cx: number; cy: number; r: number; start: number; end: number; acw: boolean }
  /** Elliptical: canvas ellipse(cx, cy, rx, ry, rot, start, end, anticlockwise). */
  | {
      kind: 'ellipse';
      cx: number;
      cy: number;
      rx: number;
      ry: number;
      rot: number;
      start: number;
      end: number;
      acw: boolean;
    }
  /** Projected edge-on: draw as a polyline. */
  | { kind: 'flat' };

/** Classifies an affine arc and converts it to canvas arc()/ellipse() parameters. */
export function arcShape(a: Arc2): ArcShape {
  const lu = Math.hypot(a.ux, a.uy);
  const lv = Math.hypot(a.vx, a.vy);
  const dot = a.ux * a.vx + a.uy * a.vy;
  const cr = a.ux * a.vy - a.uy * a.vx;
  const big = Math.max(lu, lv);
  if (big === 0 || Math.abs(cr) <= 1e-12 * big * big) return { kind: 'flat' };
  const sgn = cr > 0 ? 1 : -1;
  if (Math.abs(lu - lv) <= 1e-9 * big && Math.abs(dot) <= 1e-9 * lu * lv) {
    const phi = Math.atan2(a.uy, a.ux);
    const start = phi + sgn * a.t0;
    const end = phi + sgn * a.t1;
    return { kind: 'circle', cx: a.cx, cy: a.cy, r: (lu + lv) / 2, start, end, acw: end < start };
  }
  // Principal axes of the conjugate diameters U, V.
  const ts = 0.5 * Math.atan2(2 * dot, lu * lu - lv * lv);
  const cs = Math.cos(ts);
  const sn = Math.sin(ts);
  const Ax = a.ux * cs + a.vx * sn;
  const Ay = a.uy * cs + a.vy * sn;
  const Bx = -a.ux * sn + a.vx * cs;
  const By = -a.uy * sn + a.vy * cs;
  const start = sgn * (a.t0 - ts);
  const end = sgn * (a.t1 - ts);
  return {
    kind: 'ellipse',
    cx: a.cx,
    cy: a.cy,
    rx: Math.hypot(Ax, Ay),
    ry: Math.hypot(Bx, By),
    rot: Math.atan2(Ay, Ax),
    start,
    end,
    acw: end < start,
  };
}

/** Adds the exact extents of an affine arc to bbox b. */
export function arcExtents(a: Arc2, b: number[]): void {
  const lo = Math.min(a.t0, a.t1);
  const hi = Math.max(a.t0, a.t1);
  const add = (t: number) => {
    const x = arcX(a, t);
    const y = arcY(a, t);
    if (x < b[0]) b[0] = x;
    if (y < b[1]) b[1] = y;
    if (x > b[2]) b[2] = x;
    if (y > b[3]) b[3] = y;
  };
  add(a.t0);
  add(a.t1);
  const tx = Math.atan2(a.vx, a.ux);
  const ty = Math.atan2(a.vy, a.uy);
  for (const t of [tx, tx + Math.PI, ty, ty + Math.PI]) {
    let k = t + Math.ceil((lo - t) / TAU) * TAU;
    if (k < lo) k += TAU;
    if (k <= hi) add(k);
  }
}

const GL_X = [0.1834346424956498, 0.525532409916329, 0.7966664774136267, 0.9602898564975363];
const GL_W = [0.362683783378362, 0.3137066458778873, 0.2223810344533745, 0.1012285362903763];

/** Length of an affine arc by composite 8-point Gauss–Legendre quadrature. */
export function arcLength(a: Arc2): number {
  const lo = Math.min(a.t0, a.t1);
  const hi = Math.max(a.t0, a.t1);
  const panels = Math.max(4, Math.ceil((hi - lo) / (Math.PI / 16)));
  const h = (hi - lo) / panels;
  const speed = (t: number) => {
    const c = Math.cos(t);
    const s = Math.sin(t);
    return Math.hypot(-a.ux * s + a.vx * c, -a.uy * s + a.vy * c);
  };
  let sum = 0;
  for (let p = 0; p < panels; p++) {
    const mid = lo + (p + 0.5) * h;
    for (let k = 0; k < 4; k++) {
      const d = (GL_X[k] * h) / 2;
      sum += GL_W[k] * (speed(mid - d) + speed(mid + d));
    }
  }
  return (sum * h) / 2;
}

/** Number of polyline segments for a curve of the given sweep and size. */
export function curveSegments(sweep: number, maxRadius: number, tolerance: number): number {
  const s = Math.abs(sweep);
  if (!(maxRadius > 0) || !(tolerance > 0) || tolerance >= maxRadius) return Math.max(2, Math.ceil(s / (Math.PI / 8)));
  const step = 2 * Math.acos(1 - tolerance / maxRadius);
  return Math.min(1024, Math.max(Math.ceil(s / (Math.PI / 8)), Math.ceil(s / step)));
}

/** Appends points of an affine arc (excluding the start point unless includeStart). */
export function tessellateArc(a: Arc2, n: number, out: number[], includeStart: boolean): void {
  for (let i = includeStart ? 0 : 1; i <= n; i++) {
    const t = a.t0 + ((a.t1 - a.t0) * i) / n;
    out.push(arcX(a, t), arcY(a, t));
  }
}

/** Bulge → arc in the polyline's plane: centre, radius and start/end angle (signed sweep). */
export function bulgeArc(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  bulge: number,
): { cx: number; cy: number; r: number; a0: number; sweep: number } {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const k = (1 - bulge * bulge) / (4 * bulge);
  const cx = (x1 + x2) / 2 - dy * k;
  const cy = (y1 + y2) / 2 + dx * k;
  const r = Math.hypot(x1 - cx, y1 - cy);
  return { cx, cy, r, a0: Math.atan2(y1 - cy, x1 - cx), sweep: 4 * Math.atan(bulge) };
}

/** Normalises an angle to [0, 2π). */
export function normAngle(a: number): number {
  a %= TAU;
  return a < 0 ? a + TAU : a;
}
