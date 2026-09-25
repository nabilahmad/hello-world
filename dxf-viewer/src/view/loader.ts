/** Runs the parse worker and turns its output into drawable Path2D batches. */
import { OP_ARC, OP_CLOSE, OP_ELLIPSE, OP_LINE, OP_MOVE, type Batch, type RenderModel } from '../geom/model';
import type { ParseRequest, ParseResponse } from '../worker/parse.worker';
import ParseWorker from '../worker/parse.worker?worker';

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (m: RenderModel) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new ParseWorker();
  worker.onmessage = (ev: MessageEvent<ParseResponse>) => {
    const p = pending.get(ev.data.id);
    if (!p) return;
    pending.delete(ev.data.id);
    if ('model' in ev.data) p.resolve(ev.data.model);
    else p.reject(new Error(ev.data.error));
  };
  worker.onerror = (ev) => {
    for (const p of pending.values()) p.reject(new Error(ev.message || 'Parser crashed'));
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

/** Starts the worker early so the first file does not pay for its start-up. */
export function warmUp(): void {
  getWorker();
}

export function parseInWorker(bytes: ArrayBuffer): Promise<RenderModel> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, bytes } satisfies ParseRequest, [bytes]);
  });
}

export function buildPath(b: Batch): Path2D {
  const p = new Path2D();
  const c = b.cmds;
  let i = 0;
  while (i < c.length) {
    switch (c[i]) {
      case OP_MOVE:
        p.moveTo(c[i + 1], c[i + 2]);
        i += 3;
        break;
      case OP_LINE:
        p.lineTo(c[i + 1], c[i + 2]);
        i += 3;
        break;
      case OP_ARC:
        p.arc(c[i + 1], c[i + 2], c[i + 3], c[i + 4], c[i + 5], c[i + 6] === 1);
        i += 7;
        break;
      case OP_ELLIPSE:
        p.ellipse(c[i + 1], c[i + 2], c[i + 3], c[i + 4], c[i + 5], c[i + 6], c[i + 7], c[i + 8] === 1);
        i += 9;
        break;
      case OP_CLOSE:
        p.closePath();
        i += 1;
        break;
      default:
        throw new Error(`Bad path opcode ${c[i]} at ${i}`);
    }
  }
  return p;
}
