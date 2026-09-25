/// <reference lib="webworker" />
/** Parses and flattens DXF files off the UI thread. */
import { parseDxf } from '../dxf/parser';
import { flatten, transferables } from '../geom/flatten';
import type { RenderModel } from '../geom/model';

export interface ParseRequest {
  id: number;
  bytes: ArrayBuffer;
}

export type ParseResponse = { id: number; model: RenderModel } | { id: number; error: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (ev: MessageEvent<ParseRequest>) => {
  const { id, bytes } = ev.data;
  try {
    const t0 = performance.now();
    const doc = parseDxf(new Uint8Array(bytes));
    const t1 = performance.now();
    const model = flatten(doc, bytes.byteLength);
    model.info.parseMs = t1 - t0;
    model.info.flattenMs = performance.now() - t1;
    scope.postMessage({ id, model } satisfies ParseResponse, transferables(model));
  } catch (err) {
    scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) } satisfies ParseResponse);
  }
};
