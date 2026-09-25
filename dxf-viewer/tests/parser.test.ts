import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { headerValue, parseDxf } from '../src/dxf/parser';
import type { Entity } from '../src/dxf/types';

const load = (p: string) => new Uint8Array(readFileSync(new URL(p, import.meta.url)));
const count = (es: Entity[]) =>
  es.reduce<Record<string, number>>((m, e) => ((m[e.type] = (m[e.type] ?? 0) + 1), m), {});

describe('parseDxf', () => {
  const plate = parseDxf(load('../samples/plate-mm.dxf'));

  it('reads header variables and tables', () => {
    expect(headerValue(plate, '$ACADVER')?.trim()).toBe('AC1024');
    expect(Number(headerValue(plate, '$INSUNITS'))).toBe(4);
    expect(plate.encoding).toBe('utf-8'); // R2007+ files are UTF-8
    const layers = [...plate.layers.values()].map((l) => l.name);
    expect(layers).toEqual(expect.arrayContaining(['0', 'OUTLINE', 'HOLES', 'CENTER', 'CONSTRUCTION']));
    expect(plate.layers.get('CONSTRUCTION')?.off).toBe(true);
    expect(plate.layers.get('HOLES')?.color).toBe(1);
    expect(plate.layers.get('CENTER')?.linetype).toBe('CENTER');
    expect(plate.linetypes.get('CENTER')?.pattern.length).toBeGreaterThan(2);
  });

  it('reads model-space entities', () => {
    expect(count(plate.entities)).toMatchObject({
      LWPOLYLINE: 3,
      CIRCLE: 5,
      ARC: 2,
      ELLIPSE: 1,
      SPLINE: 2,
      INSERT: 4,
      HATCH: 2,
      TEXT: 1,
      MTEXT: 1,
      DIMENSION: 1,
    });
    const outline = plate.entities.find((e) => e.type === 'LWPOLYLINE' && e.layer === 'OUTLINE');
    expect(outline?.type === 'LWPOLYLINE' && outline.closed).toBe(true);
    if (outline?.type === 'LWPOLYLINE') {
      expect(outline.verts).toHaveLength(8);
      expect(outline.verts[1].bulge).toBeCloseTo(Math.tan(Math.PI / 8), 9);
    }
    const mirrored = plate.entities.find((e) => e.type === 'ARC' && e.extrusion?.z === -1);
    expect(mirrored).toBeDefined();
    const vent = plate.entities.find((e) => e.type === 'INSERT' && e.name === 'VENT');
    expect(vent?.type === 'INSERT' && [vent.cols, vent.rows, vent.colSpacing]).toEqual([3, 2, 6]);
  });

  it('reads blocks, dimensions and hatches', () => {
    expect(plate.blocks.get('BOSS')?.entities.map((e) => e.type)).toEqual([
      'CIRCLE',
      'CIRCLE',
      'LWPOLYLINE',
      'ARC',
    ]);
    const dim = plate.entities.find((e) => e.type === 'DIMENSION');
    expect(dim?.type === 'DIMENSION' && plate.blocks.has(dim.block.toUpperCase())).toBe(true);
    const hatch = plate.entities.find((e) => e.type === 'HATCH' && !e.solid);
    if (hatch?.type !== 'HATCH') throw new Error('pattern hatch missing');
    expect(hatch.pattern).toBe('ANSI31');
    expect(hatch.loops).toHaveLength(1);
    expect(hatch.loops[0].verts).toHaveLength(4);
    expect(hatch.lines.length).toBeGreaterThan(0);
    expect(hatch.lines[0].angle).toBeCloseTo(45);
  });

  it('parses binary DXF identically to ASCII', () => {
    const bin = parseDxf(load('fixtures/plate-bin.dxf'));
    expect(bin.binary).toBe(true);
    expect(count(bin.entities)).toEqual(count(plate.entities));
    const a = plate.entities.find((e) => e.type === 'ELLIPSE');
    const b = bin.entities.find((e) => e.type === 'ELLIPSE');
    expect(b).toEqual(a);
  });

  it('decodes $DWGCODEPAGE text', () => {
    const doc = parseDxf(load('fixtures/cp1251.dxf'));
    expect(doc.encoding).toBe('windows-1251');
    const text = doc.entities.find((e) => e.type === 'TEXT');
    expect(text?.type === 'TEXT' && text.text).toBe('Привет');
  });

  it('reads R12 POLYLINE/VERTEX with bulges', () => {
    const doc = parseDxf(load('../samples/bracket-r12.dxf'));
    const pl = doc.entities.find((e) => e.type === 'POLYLINE');
    if (pl?.type !== 'POLYLINE') throw new Error('polyline missing');
    expect(pl.flags & 1).toBe(1);
    expect(pl.verts).toHaveLength(7);
    expect(pl.verts[3].bulge).toBeCloseTo(-Math.tan(Math.PI / 8), 9);
  });

  it('accepts minimal files without HEADER and with CRLF line endings', () => {
    const text = ['0', 'SECTION', '2', 'ENTITIES', '0', 'LINE', '8', 'A', '10', '1', '20', '2', '11', '3', '21', '4', '0', 'ENDSEC', '0', 'EOF', ''].join('\r\n');
    const doc = parseDxf(new TextEncoder().encode(text));
    expect(doc.entities).toHaveLength(1);
    const line = doc.entities[0];
    expect(line.type === 'LINE' && [line.p1.x, line.p1.y, line.p2.x, line.p2.y]).toEqual([1, 2, 3, 4]);
    expect(line.layer).toBe('A');
  });
});
