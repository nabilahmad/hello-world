/** Hover picking and measurement helpers for flattened primitives. */
import { HIT_ARC, HIT_LINE, HIT_STRIDE, type HitItems } from './model';

const TAU = Math.PI * 2;

export function distToSegment(x: number, y: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((x - x1) * dx + (y - y1) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(x1 + t * dx - x, y1 + t * dy - y);
}

/** True when angle a lies on the counter-clockwise sweep lo → hi (hi > lo). */
export function angleInSweep(a: number, lo: number, hi: number): boolean {
  if (hi - lo >= TAU - 1e-12) return true;
  let d = (a - lo) % TAU;
  if (d < 0) d += TAU;
  return d <= hi - lo + 1e-12;
}

export function distToArc(x: number, y: number, cx: number, cy: number, r: number, lo: number, hi: number): number {
  const a = Math.atan2(y - cy, x - cx);
  if (angleInSweep(a, lo, hi)) return Math.abs(Math.hypot(x - cx, y - cy) - r);
  const d0 = Math.hypot(cx + r * Math.cos(lo) - x, cy + r * Math.sin(lo) - y);
  const d1 = Math.hypot(cx + r * Math.cos(hi) - x, cy + r * Math.sin(hi) - y);
  return Math.min(d0, d1);
}

export function distToCurve(x: number, y: number, pts: Float64Array, off: number, n: number): number {
  let best = Infinity;
  for (let k = 1; k < n; k++) {
    const i = off + 2 * k;
    const d = distToSegment(x, y, pts[i - 2], pts[i - 1], pts[i], pts[i + 1]);
    if (d < best) best = d;
  }
  return best;
}

export function hitDistance(h: HitItems, i: number, x: number, y: number): number {
  const g = i * HIT_STRIDE;
  const G = h.geom;
  switch (h.kind[i]) {
    case HIT_LINE:
      return distToSegment(x, y, G[g], G[g + 1], G[g + 2], G[g + 3]);
    case HIT_ARC:
      return distToArc(x, y, G[g], G[g + 1], G[g + 2], G[g + 3], G[g + 4]);
    default:
      return distToCurve(x, y, h.pts, G[g], G[g + 1]);
  }
}

export interface UnitDef {
  label: string;
  abbr: string;
  /** Size of one unit in metres. */
  meters: number;
}

/** $INSUNITS codes. */
export const INSUNITS: Record<number, UnitDef> = {
  1: { label: 'Inches', abbr: 'in', meters: 0.0254 },
  2: { label: 'Feet', abbr: 'ft', meters: 0.3048 },
  3: { label: 'Miles', abbr: 'mi', meters: 1609.344 },
  4: { label: 'Millimeters', abbr: 'mm', meters: 0.001 },
  5: { label: 'Centimeters', abbr: 'cm', meters: 0.01 },
  6: { label: 'Meters', abbr: 'm', meters: 1 },
  7: { label: 'Kilometers', abbr: 'km', meters: 1000 },
  8: { label: 'Microinches', abbr: 'µin', meters: 2.54e-8 },
  9: { label: 'Mils', abbr: 'mil', meters: 2.54e-5 },
  10: { label: 'Yards', abbr: 'yd', meters: 0.9144 },
  11: { label: 'Angstroms', abbr: 'Å', meters: 1e-10 },
  12: { label: 'Nanometers', abbr: 'nm', meters: 1e-9 },
  13: { label: 'Microns', abbr: 'µm', meters: 1e-6 },
  14: { label: 'Decimeters', abbr: 'dm', meters: 0.1 },
  15: { label: 'Decameters', abbr: 'dam', meters: 10 },
  16: { label: 'Hectometers', abbr: 'hm', meters: 100 },
  17: { label: 'Gigameters', abbr: 'Gm', meters: 1e9 },
  18: { label: 'Astronomical units', abbr: 'AU', meters: 1.495978707e11 },
  19: { label: 'Light years', abbr: 'ly', meters: 9.4607304725808e15 },
  20: { label: 'Parsecs', abbr: 'pc', meters: 3.0856775814914e16 },
  21: { label: 'US survey feet', abbr: 'ft', meters: 1200 / 3937 },
  22: { label: 'US survey inches', abbr: 'in', meters: 100 / 3937 },
  23: { label: 'US survey yards', abbr: 'yd', meters: 3600 / 3937 },
  24: { label: 'US survey miles', abbr: 'mi', meters: 6336000 / 3937 },
};

/** Display units offered in the UI (codes match $INSUNITS). */
export const DISPLAY_UNITS = [4, 5, 6, 1, 2] as const;

export interface UnitSettings {
  /** $INSUNITS of the drawing (0 = unitless). */
  drawing: number;
  /** Selected display unit, or 0 = same as the drawing. */
  display: number;
  /** Maximum decimals; trailing zeros are trimmed. */
  precision: number;
}

/** Factor converting drawing units → display units, and the suffix to show. */
export function unitConversion(u: UnitSettings): { factor: number; abbr: string } {
  const from = INSUNITS[u.drawing];
  const to = INSUNITS[u.display];
  if (!to) return { factor: 1, abbr: from?.abbr ?? '' };
  if (!from) return { factor: 1, abbr: to.abbr }; // unitless drawing: assume the chosen unit
  return { factor: from.meters / to.meters, abbr: to.abbr };
}

export function formatNumber(v: number, precision: number): string {
  if (!Number.isFinite(v)) return '–';
  const p = Math.max(0, Math.min(8, precision));
  let s = v.toFixed(p);
  if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
  if (s === '-0') s = '0';
  // Thousands separators for the integer part.
  const [int, frac] = s.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return frac ? `${grouped}.${frac}` : grouped;
}

export class Formatter {
  readonly factor: number;
  readonly abbr: string;
  constructor(readonly settings: UnitSettings) {
    const c = unitConversion(settings);
    this.factor = c.factor;
    this.abbr = c.abbr;
  }

  /** Converts a drawing-unit length to display units, without formatting. */
  value(v: number): number {
    return v * this.factor;
  }

  length(v: number): string {
    const s = formatNumber(v * this.factor, this.settings.precision);
    return this.abbr ? `${s} ${this.abbr}` : s;
  }

  area(v: number): string {
    const s = formatNumber(v * this.factor * this.factor, this.settings.precision);
    return this.abbr ? `${s} ${this.abbr}²` : s;
  }

  coord(v: number): string {
    return formatNumber(v * this.factor, this.settings.precision);
  }
}

export function formatAngle(rad: number, precision = 2): string {
  return `${formatNumber((rad * 180) / Math.PI, Math.min(precision, 3))}°`;
}
