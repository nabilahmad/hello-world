/** HATCH boundaries (tessellated, in the hatch's OCS) and pattern-line clipping. */
import type { HatchEdge, HatchEntity, PatternLine, PolyVertex } from '../dxf/types';
import { bulgeArc, curveSegments } from './math';
import { curveThroughPoints, tessellateNurbs } from './spline';

const DEG = Math.PI / 180;

function arcPoints(cx: number, cy: number, rx: number, ry: number, rot: number, t0: number, t1: number, out: number[]) {
  const n = curveSegments(t1 - t0, Math.max(rx, ry), Math.max(rx, ry) * 2e-3);
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  for (let i = 0; i <= n; i++) {
    const t = t0 + ((t1 - t0) * i) / n;
    const x = rx * Math.cos(t);
    const y = ry * Math.sin(t);
    out.push(cx + x * c - y * s, cy + x * s + y * c);
  }
}

function polylinePoints(verts: PolyVertex[], closed: boolean): number[] {
  const out: number[] = [];
  const n = verts.length;
  for (let i = 0; i < n; i++) {
    const a = verts[i];
    out.push(a.x, a.y);
    if (!closed && i === n - 1) break;
    const b = verts[(i + 1) % n];
    if (a.bulge !== 0) {
      const arc = bulgeArc(a.x, a.y, b.x, b.y, a.bulge);
      const pts: number[] = [];
      arcPoints(arc.cx, arc.cy, arc.r, arc.r, 0, arc.a0, arc.a0 + arc.sweep, pts);
      for (let k = 2; k < pts.length - 2; k += 2) out.push(pts[k], pts[k + 1]);
    }
  }
  return out;
}

function edgePoints(e: HatchEdge): number[] {
  const out: number[] = [];
  switch (e.t) {
    case 'line':
      out.push(e.x1, e.y1, e.x2, e.y2);
      break;
    case 'arc': {
      let a1 = e.a1;
      while (a1 <= e.a0) a1 += 360;
      if (e.a1 - e.a0 >= 360) a1 = e.a0 + 360;
      arcPoints(e.cx, e.cy, e.r, e.r, 0, e.a0 * DEG, a1 * DEG, out);
      break;
    }
    case 'ellipse': {
      const rx = Math.hypot(e.mx, e.my);
      const ry = rx * e.ratio;
      // Stored angles are geometric angles relative to the major axis → parameters.
      const param = (deg: number) => Math.atan2(Math.sin(deg * DEG) / (e.ratio || 1), Math.cos(deg * DEG));
      let t0 = param(e.a0);
      let t1 = param(e.a1);
      while (t1 <= t0) t1 += Math.PI * 2;
      if (e.a1 - e.a0 >= 360) t1 = t0 + Math.PI * 2;
      arcPoints(e.cx, e.cy, rx, ry, Math.atan2(e.my, e.mx), t0, t1, out);
      break;
    }
    case 'spline': {
      const xs = e.ctrl.map((p) => p.x);
      const ys = e.ctrl.map((p) => p.y);
      let size = 0;
      for (let i = 1; i < xs.length; i++) size += Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
      if (xs.length >= 2) tessellateNurbs(e.degree, e.knots, xs, ys, e.weights.length ? e.weights : null, size * 1e-4 || 1e-6, out);
      else curveThroughPoints(e.fit.map((p) => p.x), e.fit.map((p) => p.y), false, out);
      break;
    }
  }
  if (!('ccw' in e) || e.ccw) return out;
  // Clockwise edge: traverse end → start.
  const rev: number[] = [];
  for (let i = out.length - 2; i >= 0; i -= 2) rev.push(out[i], out[i + 1]);
  return rev;
}

/** Boundary loops as flat [x, y, …] polygons in the hatch's OCS (implicitly closed). */
export function hatchLoops(h: HatchEntity): number[][] {
  const loops: number[][] = [];
  for (const loop of h.loops) {
    let pts: number[];
    if (loop.verts) {
      pts = polylinePoints(loop.verts, true);
    } else {
      pts = [];
      for (const edge of loop.edges ?? []) {
        let ep = edgePoints(edge);
        if (ep.length < 4) continue;
        if (pts.length >= 2) {
          // Chain edges tolerantly: flip an edge whose end meets the current end.
          const lx = pts[pts.length - 2];
          const ly = pts[pts.length - 1];
          const ds = Math.hypot(ep[0] - lx, ep[1] - ly);
          const de = Math.hypot(ep[ep.length - 2] - lx, ep[ep.length - 1] - ly);
          if (de < ds) {
            const rev: number[] = [];
            for (let i = ep.length - 2; i >= 0; i -= 2) rev.push(ep[i], ep[i + 1]);
            ep = rev;
          }
          if (Math.min(ds, de) < 1e-9 * (1 + Math.abs(lx) + Math.abs(ly))) ep = ep.slice(2);
        }
        for (const v of ep) pts.push(v);
      }
    }
    if (pts.length >= 6) loops.push(pts);
  }
  return loops;
}

/**
 * Clips the hatch pattern lines to the loops (even-odd rule) and returns line
 * segments [x1, y1, x2, y2, …] in the hatch's OCS, or null when the pattern
 * would need more than `budget` segments (the caller falls back to a tone fill).
 */
export function patternSegments(loops: number[][], lines: PatternLine[], budget: number): number[] | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const l of loops) {
    for (let i = 0; i < l.length; i += 2) {
      minX = Math.min(minX, l[i]);
      maxX = Math.max(maxX, l[i]);
      minY = Math.min(minY, l[i + 1]);
      maxY = Math.max(maxY, l[i + 1]);
    }
  }
  if (!(minX <= maxX)) return [];
  const out: number[] = [];
  const ts: number[] = [];
  for (const pl of lines) {
    const dx = Math.cos(pl.angle * DEG);
    const dy = Math.sin(pl.angle * DEG);
    const nx = -dy;
    const ny = dx;
    const spacing = pl.ox * nx + pl.oy * ny;
    if (Math.abs(spacing) < 1e-12) continue;
    let sMin = Infinity;
    let sMax = -Infinity;
    for (const [x, y] of [
      [minX, minY],
      [maxX, minY],
      [minX, maxY],
      [maxX, maxY],
    ]) {
      const s = (x - pl.bx) * nx + (y - pl.by) * ny;
      sMin = Math.min(sMin, s);
      sMax = Math.max(sMax, s);
    }
    let k0 = Math.ceil(sMin / spacing);
    let k1 = Math.floor(sMax / spacing);
    if (k0 > k1) [k0, k1] = [Math.ceil(sMax / spacing), Math.floor(sMin / spacing)];
    if (k1 - k0 + 1 > budget) return null;
    const dashes = pl.dashes;
    let period = 0;
    for (const d of dashes) period += Math.abs(d);
    const dashed = dashes.length > 0 && period > 0 && dashes.some((d) => d < 0);
    for (let k = k0; k <= k1; k++) {
      const ox = pl.bx + k * pl.ox;
      const oy = pl.by + k * pl.oy;
      ts.length = 0;
      for (const l of loops) {
        const n = l.length;
        for (let i = 0; i < n; i += 2) {
          const ax = l[i];
          const ay = l[i + 1];
          const j = i + 2 < n ? i + 2 : 0;
          const bx = l[j];
          const by = l[j + 1];
          const sa = (ax - ox) * nx + (ay - oy) * ny;
          const sb = (bx - ox) * nx + (by - oy) * ny;
          if ((sa > 0) === (sb > 0)) continue;
          const u = sa / (sa - sb);
          ts.push((ax + u * (bx - ax) - ox) * dx + (ay + u * (by - ay) - oy) * dy);
        }
      }
      if (ts.length < 2) continue;
      ts.sort((a, b) => a - b);
      for (let i = 0; i + 1 < ts.length; i += 2) {
        const ta = ts[i];
        const tb = ts[i + 1];
        if (!dashed) {
          out.push(ox + ta * dx, oy + ta * dy, ox + tb * dx, oy + tb * dy);
        } else {
          // Dashes start at each line's own origin (base + k * offset).
          let pos = Math.floor(ta / period) * period;
          while (pos <= tb) {
            for (const d of dashes) {
              const len = Math.abs(d);
              if (d >= 0) {
                const s = Math.max(pos, ta);
                const e = Math.min(pos + len, tb);
                if (e >= s && (len > 0 || (pos >= ta && pos <= tb))) {
                  out.push(ox + s * dx, oy + s * dy, ox + e * dx, oy + e * dy);
                }
              }
              pos += len;
              if (pos > tb) break;
            }
          }
        }
        if (out.length > budget * 4) return null;
      }
    }
  }
  return out;
}
