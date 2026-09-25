/** Measurement text for the hovered primitive. */
import { formatAngle, type Formatter } from '../geom/measure';
import { HIT_ARC, HIT_LINE, HIT_STRIDE, type RenderModel } from '../geom/model';

export interface Description {
  title: string;
  subtitle: string;
  rows: Array<[string, string]>;
}

const TAU = Math.PI * 2;

const TITLES: Record<string, string> = {
  '3D POLYLINE': '3D polyline',
  'ELLIPTICAL ARC': 'Elliptical arc',
};

function title(type: string): string {
  return TITLES[type] ?? type.charAt(0) + type.slice(1).toLowerCase();
}

export function describeHit(model: RenderModel, i: number, fmt: Formatter, anglePrecision = 2): Description {
  const h = model.hits;
  const g = i * HIT_STRIDE;
  const G = h.geom;
  const info = model.entities[h.ent[i]];
  const seg = h.seg[i];
  const layer = model.layers[info.layer]?.name ?? '?';
  const subtitle = `Layer ${layer}${info.block ? ` · Block ${info.block}` : ''}`;
  const rows: Array<[string, string]> = [];
  const [ox, oy] = model.origin;
  const isPolySegment = seg >= 0;
  let head = title(info.type);

  if (h.kind[i] === HIT_LINE) {
    const dx = G[g + 2] - G[g];
    const dy = G[g + 3] - G[g + 1];
    let a = Math.atan2(dy, dx);
    if (a < 0) a += TAU;
    rows.push(['Length', fmt.length(Math.hypot(dx, dy))]);
    rows.push(['Angle', formatAngle(a, anglePrecision)]);
    rows.push(['ΔX', fmt.length(Math.abs(dx))]);
    rows.push(['ΔY', fmt.length(Math.abs(dy))]);
    if (isPolySegment) head = `${title(info.type)} · line ${seg + 1} of ${info.segs}`;
  } else if (h.kind[i] === HIT_ARC) {
    const r = G[g + 2];
    const sweep = G[g + 4] - G[g + 3];
    const full = sweep >= TAU - 1e-9;
    rows.push(['Radius', fmt.length(r)]);
    rows.push(['Diameter', fmt.length(2 * r)]);
    if (full) {
      rows.push(['Circumference', fmt.length(TAU * r)]);
      rows.push(['Area', fmt.area(Math.PI * r * r)]);
    } else {
      rows.push(['Arc length', fmt.length(r * sweep)]);
      rows.push(['Included angle', formatAngle(sweep, anglePrecision)]);
      rows.push(['Chord', fmt.length(2 * r * Math.sin(sweep / 2))]);
    }
    rows.push(['Center', `${fmt.coord(G[g] + ox)}, ${fmt.coord(G[g + 1] + oy)}`]);
    if (isPolySegment) head = `${title(info.type)} · arc ${seg + 1} of ${info.segs}`;
  } else {
    // Tessellated curve: spline, ellipse, or an arc distorted by non-uniform block scaling.
    if (info.type === 'ELLIPSE' || info.type === 'ELLIPTICAL ARC') {
      rows.push(['Major axis', fmt.length(2 * (info.rx ?? 0))]);
      rows.push(['Minor axis', fmt.length(2 * (info.ry ?? 0))]);
      rows.push([info.closed ? 'Perimeter' : 'Arc length', fmt.length(info.length)]);
      if (info.closed && info.area !== undefined) rows.push(['Area', fmt.area(info.area)]);
    } else if (isPolySegment) {
      const off = G[g];
      const n = G[g + 1];
      let len = 0;
      for (let k = 1; k < n; k++) {
        const p = off + 2 * k;
        len += Math.hypot(h.pts[p] - h.pts[p - 2], h.pts[p + 1] - h.pts[p - 1]);
      }
      rows.push(['Segment length', fmt.length(len)]);
      head = `${title(info.type)} · segment ${seg + 1} of ${info.segs}`;
    } else {
      rows.push(['Length', fmt.length(info.length)]);
      if (info.closed && info.area !== undefined) rows.push(['Area', fmt.area(info.area)]);
    }
  }

  if (isPolySegment) {
    rows.push([info.closed ? 'Perimeter' : 'Total length', fmt.length(info.length)]);
    if (info.closed && info.area !== undefined) rows.push(['Area', fmt.area(info.area)]);
  }
  return { title: head, subtitle, rows };
}
