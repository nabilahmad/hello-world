/** NURBS evaluation (de Boor) and curve-through-points fallback, in 2D. */

/**
 * Tessellates a (rational) B-spline given 2D control points. Points are
 * appended to `out` as x, y pairs, starting with the curve's start point.
 * `tol` is the maximum chord deviation in drawing units.
 */
export function tessellateNurbs(
  degree: number,
  knotsIn: number[],
  xs: number[],
  ys: number[],
  weightsIn: number[] | null,
  tol: number,
  out: number[],
): void {
  const n = xs.length;
  if (n === 0) return;
  if (n === 1) {
    out.push(xs[0], ys[0]);
    return;
  }
  const p = Math.max(1, Math.min(degree, n - 1));
  let U = knotsIn;
  if (U.length !== n + p + 1 || U.some((k, i) => i > 0 && k < U[i - 1])) U = clampedKnots(n, p);
  const W = weightsIn && weightsIn.length === n ? weightsIn : null;
  const dx = new Float64Array(p + 1);
  const dy = new Float64Array(p + 1);
  const dw = new Float64Array(p + 1);

  const span = (u: number): number => {
    if (u >= U[n]) {
      let k = n - 1;
      while (k > p && U[k] === U[k + 1]) k--;
      return k;
    }
    let lo = p;
    let hi = n;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (u < U[mid]) hi = mid;
      else lo = mid;
    }
    return lo;
  };

  let ex = 0;
  let ey = 0;
  const evalAt = (u: number): void => {
    const k = span(u);
    for (let j = 0; j <= p; j++) {
      const idx = k - p + j;
      const w = W ? W[idx] : 1;
      dx[j] = xs[idx] * w;
      dy[j] = ys[idx] * w;
      dw[j] = w;
    }
    for (let r = 1; r <= p; r++) {
      for (let j = p; j >= r; j--) {
        const i = k - p + j;
        const den = U[i + p + 1 - r] - U[i];
        const a = den === 0 ? 0 : (u - U[i]) / den;
        dx[j] = (1 - a) * dx[j - 1] + a * dx[j];
        dy[j] = (1 - a) * dy[j - 1] + a * dy[j];
        dw[j] = (1 - a) * dw[j - 1] + a * dw[j];
      }
    }
    const w = dw[p] || 1;
    ex = dx[p] / w;
    ey = dy[p] / w;
  };

  const tol2 = tol * tol;
  const subdivide = (u0: number, x0: number, y0: number, u1: number, x1: number, y1: number, depth: number) => {
    const um = (u0 + u1) / 2;
    evalAt(um);
    const xm = ex;
    const ym = ey;
    if (depth < 2 || (depth < 14 && distToSegment2(xm, ym, x0, y0, x1, y1) > tol2)) {
      subdivide(u0, x0, y0, um, xm, ym, depth + 1);
      subdivide(um, xm, ym, u1, x1, y1, depth + 1);
    } else {
      out.push(x1, y1);
    }
  };

  const u0 = U[p];
  const u1 = U[n];
  evalAt(u0);
  let px = ex;
  let py = ey;
  out.push(px, py);
  for (let i = p; i < n; i++) {
    const a = Math.max(U[i], u0);
    const b = Math.min(U[i + 1], u1);
    if (b <= a) continue;
    evalAt(b);
    const bx = ex;
    const by = ey;
    subdivide(a, px, py, b, bx, by, 0);
    px = bx;
    py = by;
  }
}

function clampedKnots(n: number, p: number): number[] {
  const k: number[] = [];
  const inner = n - p;
  for (let i = 0; i <= p; i++) k.push(0);
  for (let i = 1; i < inner; i++) k.push(i / inner);
  for (let i = 0; i <= p; i++) k.push(1);
  return k;
}

function distToSegment2(x: number, y: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((x - x0) * dx + (y - y0) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ddx = x0 + t * dx - x;
  const ddy = y0 + t * dy - y;
  return ddx * ddx + ddy * ddy;
}

/**
 * Smooth curve through fit points (centripetal Catmull-Rom). Used for SPLINEs
 * that only store fit points; close to, though not identical with, the
 * interpolation AutoCAD performs.
 */
export function curveThroughPoints(xs: number[], ys: number[], closed: boolean, out: number[]): void {
  const n = xs.length;
  if (n === 0) return;
  if (n < 3) {
    for (let i = 0; i < n; i++) out.push(xs[i], ys[i]);
    return;
  }
  const get = (i: number): [number, number] => {
    if (closed) {
      const k = ((i % n) + n) % n;
      return [xs[k], ys[k]];
    }
    if (i < 0) return [2 * xs[0] - xs[1], 2 * ys[0] - ys[1]];
    if (i >= n) return [2 * xs[n - 1] - xs[n - 2], 2 * ys[n - 1] - ys[n - 2]];
    return [xs[i], ys[i]];
  };
  const segs = closed ? n : n - 1;
  out.push(xs[0], ys[0]);
  const STEPS = 16;
  for (let i = 0; i < segs; i++) {
    const p0 = get(i - 1);
    const p1 = get(i);
    const p2 = get(i + 1);
    const p3 = get(i + 2);
    const t1 = Math.sqrt(Math.hypot(p1[0] - p0[0], p1[1] - p0[1])) || 1e-9;
    const t2 = t1 + (Math.sqrt(Math.hypot(p2[0] - p1[0], p2[1] - p1[1])) || 1e-9);
    const t3 = t2 + (Math.sqrt(Math.hypot(p3[0] - p2[0], p3[1] - p2[1])) || 1e-9);
    for (let s = 1; s <= STEPS; s++) {
      const t = t1 + ((t2 - t1) * s) / STEPS;
      const pt = [0, 1].map((c) => {
        const a1 = ((t1 - t) / t1) * p0[c] + (t / t1) * p1[c];
        const a2 = ((t2 - t) / (t2 - t1)) * p1[c] + ((t - t1) / (t2 - t1)) * p2[c];
        const a3 = ((t3 - t) / (t3 - t2)) * p2[c] + ((t - t2) / (t3 - t2)) * p3[c];
        const b1 = ((t2 - t) / t2) * a1 + (t / t2) * a2;
        const b2 = ((t3 - t) / (t3 - t1)) * a2 + ((t - t1) / (t3 - t1)) * a3;
        return ((t2 - t) / (t2 - t1)) * b1 + ((t - t1) / (t2 - t1)) * b2;
      });
      out.push(pt[0], pt[1]);
    }
  }
}
