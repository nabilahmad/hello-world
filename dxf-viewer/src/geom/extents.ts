/** Visibility and bounding-box queries over a render model. */
import { type BBox, type RenderModel, boxUnion, boxValid, emptyBox } from './model';

/** Per visibility group: visible when all of its layers are visible. */
export function groupVisibility(model: RenderModel, layerVisible: boolean[]): boolean[] {
  return model.groups.map((g) => g.every((l) => layerVisible[l]));
}

/**
 * Axis-aligned ("cardinal") bounding box of the visible drawing in local
 * coordinates. Geometry only by default: text, dimensions and leaders are
 * annotations that would otherwise inflate the part size. Falls back to
 * everything when a drawing contains nothing but annotations.
 */
export function visibleExtents(model: RenderModel, groupVisible: boolean[], includeAnnotation: boolean): BBox | null {
  const box = emptyBox();
  for (const b of model.batches) {
    if (b.infinite || !groupVisible[b.group]) continue;
    if (b.annotation && !includeAnnotation) continue;
    boxUnion(box, b.bbox);
  }
  if (includeAnnotation) for (const t of model.texts) if (groupVisible[t.group]) boxUnion(box, t.bbox);
  if (boxValid(box)) return box;
  return includeAnnotation ? null : visibleExtents(model, groupVisible, true);
}
