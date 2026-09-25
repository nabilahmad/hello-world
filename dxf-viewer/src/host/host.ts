/**
 * The window-management side of the app. The desktop build (Tauri) gives each
 * file its own native window and lets tabs move between windows; the browser
 * build keeps everything as tabs in one page.
 */

/** View state that travels with a document between windows. */
export interface ViewState {
  cx: number;
  cy: number;
  scale: number;
}

export interface DocRef {
  id: string;
  name: string;
  path?: string;
  view?: ViewState;
}

export interface HostEvents {
  /** Documents to add to this window (opened here or dropped here from another window). */
  adopt(docs: DocRef[], at: { x?: number; index?: number } | null): void;
  /** Another window is dragging a tab over this window's tab strip (x in CSS px), or left (null). */
  dropHover(x: number | null, name: string): void;
  /** Files are being dragged over the window from the OS. */
  fileDrag(active: boolean): void;
}

export interface DragStart {
  doc: DocRef;
  /** Pointer position inside the tab strip's tab, CSS px from the window's top-left. */
  grabX: number;
  grabY: number;
  /** True when the tab leaves a multi-tab window and needs a window of its own. */
  detach: boolean;
}

export interface Host {
  readonly kind: 'web' | 'tauri';
  /** Whether tabs can be torn off into separate native windows. */
  readonly multiWindow: boolean;
  /** Registers event callbacks and returns the documents this window starts with. */
  init(events: HostEvents): Promise<DocRef[]>;
  read(doc: DocRef): Promise<ArrayBuffer>;
  /** Shows the open-file dialog; results arrive through `adopt` or as new windows. */
  openDialog(): Promise<void>;
  /** Handles files dropped onto the page (browser build). */
  dropFiles?(files: File[]): void;
  /** The tab was closed. */
  closeDoc(id: string): void;
  setTitle(title: string): void;
  /** Tab strip rectangle in CSS px (for cross-window drop targeting). */
  reportLayout(strip: DOMRect): void;
  reorder(ids: string[]): void;

  /** Starts dragging a tab as a window. Returns false when not possible. */
  dragBegin(d: DragStart): Promise<boolean>;
  dragMove(): Promise<void>;
  dragEnd(): Promise<void>;
  dragCancel(): Promise<void>;
  /** Moves a tab into a new window (context menu / shortcut). */
  moveToNewWindow(doc: DocRef): Promise<void>;
  /** Moves all tabs from other windows into this one. */
  mergeAllWindows(): Promise<void>;
}
