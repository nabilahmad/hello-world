/**
 * Render model produced by the parse worker and consumed by the viewer.
 * Everything is flattened to 2D "local" coordinates: world XY minus `origin`
 * (keeps numbers small so float32 paths stay precise for survey-scale drawings).
 * Large arrays are typed so they can be transferred between threads for free.
 */

/** Colour value meaning "theme foreground" (ACI 7: white on dark, black on light). */
export const FG = -1;

/** Path opcodes in Batch.cmds. */
export const OP_MOVE = 1; // x y
export const OP_LINE = 2; // x y
export const OP_ARC = 3; // cx cy r a0 a1 anticlockwise   (canvas arc() semantics, Y up)
export const OP_ELLIPSE = 4; // cx cy rx ry rot s0 s1 anticlockwise
export const OP_CLOSE = 5;

/** Hit-test primitive kinds. */
export const HIT_LINE = 1; // geom: x1 y1 x2 y2
export const HIT_ARC = 2; // geom: cx cy r a0 a1  (counter-clockwise a0 → a1, a1 > a0)
export const HIT_CURVE = 3; // geom: offset count  (points in HitItems.pts)
export const HIT_STRIDE = 5;

export interface LayerInfo {
  name: string;
  /** 0xRRGGBB or FG. */
  color: number;
  /** Initial visibility (layer on and thawed in the file). */
  visible: boolean;
  /** Number of primitives drawn on the layer. */
  count: number;
}

export interface Batch {
  /** Index into RenderModel.groups: the layers that must be visible. */
  group: number;
  color: number;
  /** Dash pattern in drawing units (dash, gap, …); 0 = dot. null = continuous. */
  dash: number[] | null;
  /** Stroke width in drawing units; 0 = hairline. */
  width: number;
  fill: boolean;
  /** Dimension/text graphics: excluded from the part's bounding box. */
  annotation: boolean;
  alpha: number;
  roundCap: boolean;
  /** Rays/construction lines: always drawn, never part of any extents. */
  infinite: boolean;
  cmds: Float64Array;
  /** POINT entity markers as x, y pairs. */
  points: Float64Array | null;
  /** minX, minY, maxX, maxY (local); empty batches have minX > maxX. */
  bbox: number[];
}

export interface TextItem {
  group: number;
  color: number;
  x: number;
  y: number;
  /** Rotation of the text baseline, radians counter-clockwise. */
  rot: number;
  /** Character height in drawing units. */
  h: number;
  widthFactor: number;
  /** Paragraphs (MTEXT) or the single line (TEXT). */
  lines: string[];
  /** 0 left, 1 center, 2 right. */
  hAlign: number;
  /** 0 baseline, 1 bottom, 2 middle, 3 top (MTEXT uses 1..3 for the whole block). */
  vAlign: number;
  mtext: boolean;
  /** Distance between baselines (MTEXT). */
  lineStep: number;
  /** MTEXT wrapping width (0 = none). */
  wrap: number;
  /** Aligned/fit TEXT: the text is stretched to this width. */
  fitWidth: number;
  bbox: number[];
}

export interface HitItems {
  count: number;
  kind: Uint8Array;
  geom: Float64Array;
  pts: Float64Array;
  /** Index into RenderModel.entities. */
  ent: Int32Array;
  /** Segment number within a polyline, else -1. */
  seg: Int32Array;
  group: Int32Array;
  /** Flatbush index data (see Flatbush.from). */
  index: ArrayBuffer | null;
}

export interface EntityInfo {
  type: string;
  layer: number;
  /** Name of the top-level block when the entity comes from an INSERT. */
  block?: string;
  length: number;
  area?: number;
  closed?: boolean;
  segs?: number;
  rx?: number;
  ry?: number;
}

export interface DrawingInfo {
  version: string;
  /** $INSUNITS code (0 = unitless). */
  insunits: number;
  /** $MEASUREMENT: 0 imperial, 1 metric (-1 unknown). */
  measurement: number;
  /** $LUPREC (-1 unknown). */
  precision: number;
  encoding: string;
  binary: boolean;
  entityCount: number;
  primitiveCount: number;
  bytes: number;
  parseMs: number;
  flattenMs: number;
  /** Entity types that are not drawn, with counts. */
  skipped: Record<string, number>;
}

export interface RenderModel {
  origin: [number, number];
  layers: LayerInfo[];
  groups: number[][];
  batches: Batch[];
  texts: TextItem[];
  hits: HitItems;
  entities: EntityInfo[];
  info: DrawingInfo;
}

export type BBox = [number, number, number, number];

export const emptyBox = (): BBox => [Infinity, Infinity, -Infinity, -Infinity];

export function boxValid(b: ArrayLike<number>): boolean {
  return b[0] <= b[2] && b[1] <= b[3];
}

export function boxAdd(b: number[], x: number, y: number): void {
  if (x < b[0]) b[0] = x;
  if (y < b[1]) b[1] = y;
  if (x > b[2]) b[2] = x;
  if (y > b[3]) b[3] = y;
}

export function boxUnion(b: number[], o: ArrayLike<number>): void {
  if (!boxValid(o)) return;
  if (o[0] < b[0]) b[0] = o[0];
  if (o[1] < b[1]) b[1] = o[1];
  if (o[2] > b[2]) b[2] = o[2];
  if (o[3] > b[3]) b[3] = o[3];
}
