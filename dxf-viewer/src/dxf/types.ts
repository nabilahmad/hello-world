/** Parsed DXF document model: only what a 2D viewer needs. */

export interface V3 {
  x: number;
  y: number;
  z: number;
}

export interface EntityBase {
  type: string;
  handle: string;
  layer: string;
  /** ACI colour: 0 = BYBLOCK, 256 = BYLAYER (default). */
  color: number;
  /** 24-bit true colour (group 420) or -1. */
  trueColor: number;
  /** Linetype name; '' means BYLAYER. */
  linetype: string;
  ltscale: number;
  invisible: boolean;
  paperSpace: boolean;
  /** Extrusion direction / OCS normal; null means +Z. */
  extrusion: V3 | null;
}

export interface LineEntity extends EntityBase {
  type: 'LINE';
  p1: V3;
  p2: V3;
}

export interface PointEntity extends EntityBase {
  type: 'POINT';
  p: V3;
}

export interface CircleEntity extends EntityBase {
  type: 'CIRCLE';
  c: V3;
  r: number;
}

export interface ArcEntity extends EntityBase {
  type: 'ARC';
  c: V3;
  r: number;
  /** Start/end angle in degrees, counter-clockwise in the OCS. */
  a0: number;
  a1: number;
}

export interface EllipseEntity extends EntityBase {
  type: 'ELLIPSE';
  c: V3;
  /** Major axis end point relative to the centre (WCS). */
  major: V3;
  ratio: number;
  /** Start/end parameter in radians. */
  t0: number;
  t1: number;
}

export interface PolyVertex {
  x: number;
  y: number;
  z: number;
  bulge: number;
  flags: number;
}

export interface LwPolylineEntity extends EntityBase {
  type: 'LWPOLYLINE';
  verts: PolyVertex[];
  closed: boolean;
  elevation: number;
  width: number;
}

export interface PolylineEntity extends EntityBase {
  type: 'POLYLINE';
  verts: PolyVertex[];
  /** 1 closed, 8 3D polyline, 16 polygon mesh, 32 mesh closed in N, 64 polyface mesh. */
  flags: number;
  meshM: number;
  meshN: number;
  /** Polyface faces: 1-based vertex indices, negative = invisible edge. */
  faces: number[][];
  width: number;
}

export interface SplineEntity extends EntityBase {
  type: 'SPLINE';
  degree: number;
  flags: number;
  knots: number[];
  weights: number[];
  ctrl: V3[];
  fit: V3[];
}

export interface TextEntity extends EntityBase {
  type: 'TEXT' | 'ATTRIB';
  p: V3;
  /** Second alignment point (used unless left/baseline aligned). */
  p2: V3 | null;
  h: number;
  text: string;
  /** Rotation in degrees. */
  rot: number;
  widthFactor: number;
  /** Oblique angle in degrees. */
  oblique: number;
  style: string;
  /** 0 left, 1 center, 2 right, 3 aligned, 4 middle, 5 fit. */
  hAlign: number;
  /** 0 baseline, 1 bottom, 2 middle, 3 top. */
  vAlign: number;
  /** Generation flags: 2 mirrored in X, 4 mirrored in Y. */
  gen: number;
}

export interface MTextEntity extends EntityBase {
  type: 'MTEXT';
  p: V3;
  h: number;
  /** Reference rectangle width (0 = no wrapping). */
  width: number;
  /** 1..9: top/middle/bottom × left/center/right. */
  attach: number;
  text: string;
  /** Rotation in degrees (ignored when xdir is set). */
  rot: number;
  xdir: V3 | null;
  lineSpacing: number;
  style: string;
}

export interface InsertEntity extends EntityBase {
  type: 'INSERT';
  name: string;
  p: V3;
  sx: number;
  sy: number;
  sz: number;
  /** Rotation in degrees. */
  rot: number;
  cols: number;
  rows: number;
  colSpacing: number;
  rowSpacing: number;
  attribs: TextEntity[];
}

/** Entities drawn by inserting an anonymous block (DIMENSION, ACAD_TABLE). */
export interface BlockGraphicEntity extends EntityBase {
  type: 'DIMENSION' | 'ACAD_TABLE';
  block: string;
  /** Insertion point (tables); dimensions are drawn at the origin. */
  p: V3;
}

export interface SolidEntity extends EntityBase {
  type: 'SOLID' | 'TRACE' | '3DFACE';
  pts: V3[];
  /** 3DFACE invisible edge flags. */
  edgeFlags: number;
}

export interface LeaderEntity extends EntityBase {
  type: 'LEADER';
  pts: V3[];
  arrow: boolean;
}

export interface RayEntity extends EntityBase {
  type: 'RAY' | 'XLINE';
  p: V3;
  dir: V3;
}

export type HatchEdge =
  | { t: 'line'; x1: number; y1: number; x2: number; y2: number }
  /** Angles in degrees, stored counter-clockwise; ccw=false means traverse end → start. */
  | { t: 'arc'; cx: number; cy: number; r: number; a0: number; a1: number; ccw: boolean }
  | {
      t: 'ellipse';
      cx: number;
      cy: number;
      mx: number;
      my: number;
      ratio: number;
      a0: number;
      a1: number;
      ccw: boolean;
    }
  | {
      t: 'spline';
      degree: number;
      knots: number[];
      ctrl: V3[];
      weights: number[];
      fit: V3[];
    };

export interface HatchLoop {
  flags: number;
  /** Polyline boundary (flag bit 2) … */
  verts?: PolyVertex[];
  closed?: boolean;
  /** … or a chain of edges. */
  edges?: HatchEdge[];
}

export interface PatternLine {
  /** Degrees. */
  angle: number;
  bx: number;
  by: number;
  ox: number;
  oy: number;
  dashes: number[];
}

export interface HatchEntity extends EntityBase {
  type: 'HATCH';
  solid: boolean;
  pattern: string;
  elevation: number;
  loops: HatchLoop[];
  lines: PatternLine[];
}

export type Entity =
  | LineEntity
  | PointEntity
  | CircleEntity
  | ArcEntity
  | EllipseEntity
  | LwPolylineEntity
  | PolylineEntity
  | SplineEntity
  | TextEntity
  | MTextEntity
  | InsertEntity
  | BlockGraphicEntity
  | SolidEntity
  | LeaderEntity
  | RayEntity
  | HatchEntity;

export interface Layer {
  name: string;
  /** Absolute ACI colour (the sign in the file only encodes on/off). */
  color: number;
  trueColor: number;
  linetype: string;
  off: boolean;
  frozen: boolean;
}

export interface Linetype {
  name: string;
  /** Dash lengths: > 0 dash, < 0 gap, 0 dot. */
  pattern: number[];
}

export interface Block {
  name: string;
  base: V3;
  flags: number;
  entities: Entity[];
}

export interface DxfDocument {
  /** Header variables: name → raw [code, value] pairs. */
  header: Map<string, Array<[number, string]>>;
  /** Keyed by upper-case name (DXF names are case-insensitive). */
  layers: Map<string, Layer>;
  linetypes: Map<string, Linetype>;
  blocks: Map<string, Block>;
  /** Model-space entities in file order. */
  entities: Entity[];
  /** Entity types that were skipped (not supported), with counts. */
  unsupported: Record<string, number>;
  encoding: string;
  binary: boolean;
}
