/**
 * Desktop build: talks to the Rust side, which owns windows and knows which
 * documents live in which window. Each opened file gets its own window; tabs
 * are dragged between windows by moving native windows around (see src-tauri).
 */
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { DocRef, DragStart, Host, HostEvents, ViewState } from './host';

interface DocPayload {
  id: number;
  name: string;
  path: string;
  view: ViewState | null;
}

const toRef = (d: DocPayload): DocRef => ({ id: String(d.id), name: d.name, path: d.path, view: d.view ?? undefined });
const toPayload = (d: DocRef): DocPayload => ({ id: Number(d.id), name: d.name, path: d.path ?? '', view: d.view ?? null });

export class TauriHost implements Host {
  readonly kind = 'tauri';
  readonly multiWindow = true;
  /** Serialises drag commands so moves never overtake the begin/end calls. */
  private queue: Promise<unknown> = Promise.resolve();
  private moveInFlight = false;

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => undefined);
    return p;
  }

  private readonly win = getCurrentWebviewWindow();

  async init(events: HostEvents): Promise<DocRef[]> {
    // Listen on this window only: events are addressed to window labels.
    const w = this.win;
    await w.listen<{ docs: DocPayload[]; x: number | null; index: number | null }>('docs-adopt', (e) => {
      const { docs, x, index } = e.payload;
      events.adopt(docs.map(toRef), x === null && index === null ? null : { x: x ?? undefined, index: index ?? undefined });
    });
    await w.listen<{ x: number; name: string }>('drop-hover', (e) => events.dropHover(e.payload.x, e.payload.name));
    await w.listen('drop-leave', () => events.dropHover(null, ''));
    await w.listen<{ active: boolean }>('file-drag', (e) => events.fileDrag(e.payload.active));
    const docs = await invoke<DocPayload[]>('window_init');
    return docs.map(toRef);
  }

  async read(doc: DocRef): Promise<ArrayBuffer> {
    return invoke<ArrayBuffer>('read_doc', { id: Number(doc.id) });
  }

  async openDialog(): Promise<void> {
    await invoke('open_dialog');
  }

  closeDoc(id: string): void {
    void invoke('close_doc', { id: Number(id) });
  }

  setTitle(title: string): void {
    void this.win.setTitle(title);
  }

  reportLayout(strip: DOMRect): void {
    void invoke('report_layout', { strip: { x: strip.x, y: strip.y, width: strip.width, height: strip.height } });
  }

  reorder(ids: string[]): void {
    void invoke('reorder_docs', { ids: ids.map(Number) });
  }

  dragBegin(d: DragStart): Promise<boolean> {
    return this.enqueue(() =>
      invoke<boolean>('drag_begin', { doc: toPayload(d.doc), grabX: d.grabX, grabY: d.grabY, detach: d.detach }),
    );
  }

  dragMove(): Promise<void> {
    // Coalesce: at most one move in flight; the next pointer event sends a fresh one.
    if (this.moveInFlight) return Promise.resolve();
    this.moveInFlight = true;
    return this.enqueue(() => invoke<void>('drag_move')).finally(() => {
      this.moveInFlight = false;
    });
  }

  dragEnd(): Promise<void> {
    return this.enqueue(() => invoke<void>('drag_end'));
  }

  dragCancel(): Promise<void> {
    return this.enqueue(() => invoke<void>('drag_cancel'));
  }

  async moveToNewWindow(doc: DocRef): Promise<void> {
    await invoke('move_to_new_window', { doc: toPayload(doc) });
  }

  async mergeAllWindows(): Promise<void> {
    await invoke('merge_all_windows');
  }
}
