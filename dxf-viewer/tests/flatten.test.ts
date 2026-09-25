import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ACI } from '../src/dxf/aci';
import { parseDxf } from '../src/dxf/parser';
import { groupVisibility, visibleExtents } from '../src/geom/extents';
import { flatten, toDash } from '../src/geom/flatten';
import { arcShape, transformArc, scale } from '../src/geom/math';
import { HIT_ARC, HIT_LINE, HIT_STRIDE, OP_LINE, OP_MOVE, type RenderModel } from '../src/geom/model';
import { hitDistance } from '../src/geom/measure';

const load = (p: string) => new Uint8Array(readFileSync(new URL(p, import.meta.url)));
const plate = flatten(parseDxf(load('../samples/plate-mm.dxf')));
const layer = (m: RenderModel, name: string) => m.layers.findIndex((l) => l.name === name);
const visible = (m: RenderModel) => groupVisibility(m, m.layers.map((l) => l.visible));

/** Circular hit arcs in world coordinates. */
function arcs(m: RenderModel) {
  const out: Array<{ cx: number; cy: number; r: number; lo: number; hi: number; ent: number }> = [];
  const h = m.hits;
  for (let i = 0; i < h.count; i++) {
    if (h.kind[i] !== HIT_ARC) continue;
    const g = i * HIT_STRIDE;
    out.push({
      cx: h.geom[g] + m.origin[0],
      cy: h.geom[g + 1] + m.origin[1],
      r: h.geom[g + 2],
      lo: h.geom[g + 3],
      hi: h.geom[g + 4],
      ent: h.ent[i],
    });
  }
  return out;
}

describe('flatten', () => {
  it('computes the cardinal bounding box of the geometry', () => {
    const box = visibleExtents(plate, visible(plate), false)!;
    const [ox, oy] = plate.origin;
    expect(box[0] + ox).toBeCloseTo(0, 9);
    expect(box[1] + oy).toBeCloseTo(0, 9);
    expect(box[2] + ox).toBeCloseTo(200, 9);
    expect(box[3] + oy).toBeCloseTo(120, 9);
  });

  it('includes annotations only on request', () => {
    const box = visibleExtents(plate, visible(plate), true)!;
    expect(box[3] + plate.origin[1]).toBeGreaterThan(130); // title text above the part
    expect(box[1] + plate.origin[1]).toBeLessThan(-15); // dimension below the part
  });

  it('measures polylines with bulges', () => {
    const outline = plate.entities.find((e) => e.type === 'POLYLINE' && e.layer === layer(plate, 'OUTLINE'))!;
    expect(outline.closed).toBe(true);
    expect(outline.segs).toBe(8);
    expect(outline.length).toBeCloseTo(560 + 20 * Math.PI, 9);
    expect(outline.area).toBeCloseTo(24000 - (4 - Math.PI) * 100, 9);
    const slot = plate.entities.find((e) => e.type === 'POLYLINE' && e.layer === layer(plate, 'FEATURES') && e.segs === 4)!;
    expect(slot.length).toBeCloseTo(40 + 10 * Math.PI, 9);
    expect(slot.area).toBeCloseTo(200 + 25 * Math.PI, 9);
  });

  it('places an arc with a -Z extrusion mirrored', () => {
    const a = arcs(plate).find((x) => Math.abs(x.r - 8) < 1e-9)!;
    expect(a.cx).toBeCloseTo(70, 9);
    expect(a.cy).toBeCloseTo(30, 9);
    expect(a.lo).toBeCloseTo(Math.PI / 2, 9);
    expect(a.hi).toBeCloseTo(Math.PI, 9);
  });

  it('expands blocks: arrays, scaling, rotation and mirroring', () => {
    const vents = arcs(plate).filter((x) => Math.abs(x.r - 1.5) < 1e-9);
    expect(vents.map((v) => [v.cx, v.cy]).sort()).toEqual(
      [[160, 85], [166, 85], [172, 85], [160, 91], [166, 91], [172, 91]].sort(),
    );
    const scaled = arcs(plate).filter((x) => Math.abs(x.r - 4.8) < 1e-9);
    expect(scaled).toHaveLength(1);
    expect([scaled[0].cx, scaled[0].cy]).toEqual([40, 100]);
    // BOSS inserted with xscale = -1 at (40, 25): its tab (6,0)→(10,0)→(10,4) is mirrored.
    const h = plate.hits;
    const segs: number[][] = [];
    for (let i = 0; i < h.count; i++) {
      if (h.kind[i] !== HIT_LINE) continue;
      const g = i * HIT_STRIDE;
      segs.push([0, 1, 2, 3].map((k) => Math.round((h.geom[g + k] + plate.origin[k % 2]) * 1e6) / 1e6));
    }
    expect(segs).toContainEqual([34, 25, 30, 25]);
    expect(segs).toContainEqual([30, 25, 30, 29]);
  });

  it('inherits layer and BYBLOCK colour from inserts', () => {
    const features = layer(plate, 'FEATURES');
    const boss = plate.entities.filter((e) => e.block === 'BOSS');
    expect(boss.length).toBe(12);
    expect(boss.every((e) => e.layer === features)).toBe(true);
    const colors = new Set(plate.batches.filter((b) => plate.groups[b.group].includes(features)).map((b) => b.color));
    expect(colors.has(ACI[6])).toBe(true); // insert with colour 6
    expect(colors.has(ACI[5])).toBe(true); // BYLAYER insert → FEATURES is blue
  });

  it('measures ellipses and splines', () => {
    const el = plate.entities.find((e) => e.type === 'ELLIPSE')!;
    expect(el.rx).toBeCloseTo(12, 9);
    expect(el.ry).toBeCloseTo(6, 9);
    expect(el.area).toBeCloseTo(Math.PI * 72, 9);
    // Ramanujan's second approximation (relative error ~1e-9 at this eccentricity).
    const a = 12;
    const b = 6;
    const h = ((a - b) / (a + b)) ** 2;
    expect(el.length).toBeCloseTo(Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h))), 6);
    const splines = plate.entities.filter((e) => e.type === 'SPLINE');
    expect(splines).toHaveLength(2);
    for (const s of splines) expect(s.length).toBeGreaterThan(20);
  });

  it('keeps layers that are off in the file hidden', () => {
    expect(plate.layers[layer(plate, 'CONSTRUCTION')].visible).toBe(false);
    expect(plate.layers[layer(plate, 'OUTLINE')].visible).toBe(true);
  });

  it('clips hatch pattern lines to the boundary', () => {
    const hatchLayer = layer(plate, 'HATCH');
    const b = plate.batches.find((x) => plate.groups[x.group].includes(hatchLayer) && !x.fill)!;
    expect(b.cmds.length).toBeGreaterThan(40);
    const [ox, oy] = plate.origin;
    for (let i = 0; i < b.cmds.length; i += 3) {
      expect([OP_MOVE, OP_LINE]).toContain(b.cmds[i]);
      const x = b.cmds[i + 1] + ox;
      const y = b.cmds[i + 2] + oy;
      expect(x).toBeGreaterThanOrEqual(120 - 1e-9);
      expect(x).toBeLessThanOrEqual(150 + 1e-9);
      expect(y).toBeGreaterThanOrEqual(30 - 1e-9);
      expect(y).toBeLessThanOrEqual(45 + 1e-9);
    }
  });

  it('finds the nearest primitive for hover', () => {
    const h = plate.hits;
    // Point just above the bottom edge (y = 0) of the plate, away from other features.
    const x = 100 - plate.origin[0];
    const y = 0.05 - plate.origin[1];
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < h.count; i++) {
      const d = hitDistance(h, i, x, y);
      if (d < bestD) [best, bestD] = [i, d];
    }
    expect(bestD).toBeCloseTo(0.05, 9);
    expect(h.kind[best]).toBe(HIT_LINE);
    const info = plate.entities[h.ent[best]];
    expect(info.type).toBe('POLYLINE');
    expect(h.seg[best]).toBe(0);
  });

  it('parses the R12 sample', () => {
    const m = flatten(parseDxf(load('../samples/bracket-r12.dxf')));
    const pl = m.entities.find((e) => e.type === 'POLYLINE')!;
    // L-bracket (area 6) whose inside corner is filled by an R 0.5 fillet.
    expect(pl.area).toBeCloseTo(6 + 0.25 * (1 - Math.PI / 4), 9);
    const box = visibleExtents(m, visible(m), false)!;
    expect(box[2] - box[0]).toBeCloseTo(4, 9);
    expect(box[3] - box[1]).toBeCloseTo(3, 9);
  });
});

describe('geometry helpers', () => {
  it('converts linetype patterns to canvas dashes', () => {
    expect(toDash([0.5, -0.25, 0, -0.25], 2)).toEqual([1, 0.5, 0, 0.5]);
    expect(toDash([-0.2, 1], 1)).toEqual([1, 0.2]);
    expect(toDash([1, 1], 1)).toBeNull();
    expect(toDash([1, -0.5, 1], 1)).toEqual([1, 0.5, 1, 0]);
  });

  it('keeps circles circular under mirroring and detects ellipses', () => {
    const c = { x: 0, y: 0, z: 0 };
    const mirrored = arcShape(transformArc(scale(-1, 1, 1), c, [1, 0, 0], [0, 1, 0], 0, Math.PI / 2));
    expect(mirrored.kind).toBe('circle');
    if (mirrored.kind === 'circle') {
      // Quarter arc from angle π going clockwise to π/2.
      expect(mirrored.start).toBeCloseTo(Math.PI, 12);
      expect(mirrored.end).toBeCloseTo(Math.PI / 2, 12);
      expect(mirrored.acw).toBe(true);
    }
    const squashed = arcShape(transformArc(scale(2, 1, 1), c, [1, 0, 0], [0, 1, 0], 0, Math.PI));
    expect(squashed.kind).toBe('ellipse');
    if (squashed.kind === 'ellipse') {
      expect(squashed.rx).toBeCloseTo(2, 12);
      expect(squashed.ry).toBeCloseTo(1, 12);
    }
  });
});
