/**
 * Tab strip with drag to reorder. Dragging a tab out of the strip (or the only
 * tab of a window) hands the drag to the host, which moves it as a native window.
 */

export interface TabInfo {
  id: string;
  name: string;
  title: string;
  status: 'loading' | 'ready' | 'error';
}

export interface TabStripEvents {
  activate(id: string): void;
  close(id: string): void;
  reorder(ids: string[]): void;
  /** Tab dragged out; resolves true when the host continues it as a window drag. */
  dragOut(id: string, grabX: number, grabY: number, detach: boolean): Promise<boolean>;
  dragMove(): void;
  dragEnd(): void;
  dragCancel(): void;
  contextMenu(id: string, x: number, y: number): void;
  openFile(): void;
}

const DRAG_THRESHOLD = 5;
/** How far (px) beyond the strip a tab must be pulled before it detaches. */
const DETACH_DISTANCE = 32;

interface DragState {
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  /** Pointer offset inside the tab element. */
  offX: number;
  offY: number;
  mode: 'pending' | 'reorder' | 'window' | 'waiting';
  el: HTMLElement;
  originalOrder: string[];
}

export class TabStrip {
  private tabs: TabInfo[] = [];
  private drag: DragState | null = null;
  private readonly marker: HTMLElement;
  private readonly ghost: HTMLElement;
  multiWindow = false;

  constructor(
    readonly el: HTMLElement,
    private readonly events: TabStripEvents,
  ) {
    this.marker = document.createElement('div');
    this.marker.className = 'drop-marker';
    this.marker.hidden = true;
    this.ghost = document.createElement('div');
    this.ghost.className = 'tab ghost';
    this.ghost.hidden = true;
    el.parentElement!.append(this.marker, this.ghost);

    el.addEventListener('pointerdown', (e) => this.onDown(e));
    el.addEventListener('pointermove', (e) => this.onMove(e));
    el.addEventListener('pointerup', (e) => this.onUp(e));
    el.addEventListener('pointercancel', () => this.cancel());
    el.addEventListener('lostpointercapture', () => {
      if (this.drag && this.drag.mode !== 'pending') this.finish();
    });
    el.addEventListener('auxclick', (e) => {
      const tab = (e.target as HTMLElement).closest<HTMLElement>('.tab');
      if (e.button === 1 && tab?.dataset.id) this.events.close(tab.dataset.id);
    });
    el.addEventListener('contextmenu', (e) => {
      const tab = (e.target as HTMLElement).closest<HTMLElement>('.tab');
      e.preventDefault();
      if (!tab?.dataset.id) return;
      // The native path tooltip would pop up over the menu; restore it once the pointer leaves.
      const title = tab.title;
      tab.removeAttribute('title');
      tab.addEventListener('pointerleave', () => (tab.title ||= title), { once: true });
      this.events.contextMenu(tab.dataset.id, e.clientX, e.clientY);
    });
    el.addEventListener('dblclick', (e) => {
      if (!(e.target as HTMLElement).closest('.tab')) this.events.openFile();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.drag && this.drag.mode !== 'pending') {
        e.preventDefault();
        this.cancel();
      }
    });
  }

  get dragging(): boolean {
    return !!this.drag && this.drag.mode !== 'pending';
  }

  render(tabs: TabInfo[], active: string | null): void {
    this.tabs = tabs;
    if (this.drag?.mode === 'reorder') return; // keep the dragged element alive
    const existing = new Map<string, HTMLElement>();
    for (const c of [...this.el.children] as HTMLElement[]) if (c.dataset.id) existing.set(c.dataset.id, c);
    const frag = document.createDocumentFragment();
    for (const t of tabs) {
      let el = existing.get(t.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'tab';
        el.dataset.id = t.id;
        el.setAttribute('role', 'tab');
        el.innerHTML =
          '<span class="tab-status"></span><span class="tab-name"></span>' +
          '<button class="tab-close" tabindex="-1" aria-label="Close tab">' +
          '<svg viewBox="0 0 16 16" width="12" height="12"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>' +
          '</button>';
        el.querySelector('.tab-close')!.addEventListener('click', (e) => {
          e.stopPropagation();
          this.events.close(t.id);
        });
      }
      existing.delete(t.id);
      el.querySelector('.tab-name')!.textContent = t.name;
      el.title = t.title;
      el.classList.toggle('active', t.id === active);
      el.setAttribute('aria-selected', String(t.id === active));
      el.dataset.status = t.status;
      frag.append(el);
    }
    for (const stale of existing.values()) stale.remove();
    this.el.append(frag);
  }

  /** Shows where a tab dragged from another window would land (x in CSS px), or hides it. */
  showDropMarker(x: number | null, name = ''): void {
    const strip = this.el.getBoundingClientRect();
    if (x === null) {
      this.marker.hidden = true;
      this.ghost.hidden = true;
      this.el.parentElement!.classList.remove('drop-target');
      return;
    }
    const { left } = this.insertionPoint(x);
    this.el.parentElement!.classList.add('drop-target');
    this.marker.hidden = false;
    this.marker.style.transform = `translateX(${left - 1}px)`;
    this.ghost.hidden = false;
    this.ghost.textContent = name;
    const gx = Math.min(Math.max(x - 60, strip.left), window.innerWidth - 170);
    this.ghost.style.transform = `translateX(${gx}px)`;
  }

  /** Tab index for a drop at x (CSS px), and the x of the gap. */
  insertionPoint(x: number): { index: number; left: number } {
    const els = [...this.el.querySelectorAll<HTMLElement>('.tab')];
    for (let i = 0; i < els.length; i++) {
      const r = els[i].getBoundingClientRect();
      if (x < r.left + r.width / 2) return { index: i, left: r.left };
    }
    const last = els[els.length - 1]?.getBoundingClientRect();
    return { index: els.length, left: last ? last.right : this.el.getBoundingClientRect().left + 4 };
  }

  private onDown(e: PointerEvent): void {
    if (e.button !== 0 || this.drag) return;
    const target = e.target as HTMLElement;
    if (target.closest('.tab-close')) return;
    const tab = target.closest<HTMLElement>('.tab');
    if (!tab?.dataset.id) return;
    const r = tab.getBoundingClientRect();
    // Capture on the strip, not the tab: the tab element may leave the DOM mid-drag.
    this.el.setPointerCapture(e.pointerId);
    this.drag = {
      id: tab.dataset.id,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      offX: e.clientX - r.left,
      offY: e.clientY - r.top,
      mode: 'pending',
      el: tab,
      originalOrder: this.tabs.map((t) => t.id),
    };
  }

  private onMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    if (d.mode === 'pending') {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < DRAG_THRESHOLD) return;
      if (this.multiWindow && this.tabs.length === 1) {
        this.toWindow(e, false);
        return;
      }
      d.mode = 'reorder';
      d.el.classList.add('dragging');
      this.el.classList.add('reordering');
    }
    if (d.mode === 'reorder') {
      const strip = this.el.getBoundingClientRect();
      if (this.multiWindow && Math.abs(e.clientY - (strip.top + strip.height / 2)) > strip.height / 2 + DETACH_DISTANCE) {
        d.el.classList.remove('dragging');
        d.el.style.transform = '';
        this.el.classList.remove('reordering');
        this.toWindow(e, true);
        return;
      }
      this.reorderMove(e);
      return;
    }
    if (d.mode === 'window') this.events.dragMove();
  }

  private toWindow(e: PointerEvent, detach: boolean): void {
    const d = this.drag!;
    d.mode = 'waiting';
    // Grab point relative to the window: in a new window the tab is the first one,
    // so it lands under the cursor at the same offset.
    const first = this.el.querySelector<HTMLElement>('.tab')?.getBoundingClientRect();
    const grabX = detach ? d.offX + (first?.left ?? 0) : e.clientX;
    const grabY = detach ? d.offY + (first?.top ?? 0) : e.clientY;
    this.events.dragOut(d.id, grabX, grabY, detach).then((ok) => {
      if (this.drag !== d) return;
      if (ok) {
        d.mode = 'window';
        this.events.dragMove();
      } else {
        d.mode = 'reorder';
      }
    });
  }

  private reorderMove(e: PointerEvent): void {
    const d = this.drag!;
    const left = e.clientX - d.offX;
    const width = d.el.getBoundingClientRect().width;
    // Swap with neighbours while the dragged tab is past their midpoints.
    for (let guard = 0; guard < this.tabs.length; guard++) {
      const prev = d.el.previousElementSibling as HTMLElement | null;
      const next = d.el.nextElementSibling as HTMLElement | null;
      if (prev && left < prev.getBoundingClientRect().left + prev.offsetWidth / 2) {
        this.el.insertBefore(d.el, prev);
      } else if (next && left + width > next.getBoundingClientRect().left + next.offsetWidth / 2) {
        this.el.insertBefore(next, d.el);
      } else {
        break;
      }
    }
    const nr = d.el.getBoundingClientRect();
    const newBase = nr.left - (parseFloat(d.el.dataset.dx || '0') || 0);
    let dx = left - newBase;
    const strip = this.el.getBoundingClientRect();
    dx = Math.max(strip.left - newBase, Math.min(strip.right - newBase - nr.width, dx));
    d.el.dataset.dx = String(dx);
    d.el.style.transform = `translateX(${dx}px)`;
  }

  private onUp(e: PointerEvent): void {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    if (d.mode === 'pending') {
      this.drag = null;
      this.events.activate(d.id);
      return;
    }
    this.finish();
  }

  private finish(): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    try {
      this.el.releasePointerCapture(d.pointerId);
    } catch {
      /* already released */
    }
    if (d.mode === 'reorder') {
      this.endReorderVisuals(d);
      const ids = [...this.el.querySelectorAll<HTMLElement>('.tab')].map((t) => t.dataset.id!);
      this.events.reorder(ids);
      this.events.activate(d.id);
    } else if (d.mode === 'window' || d.mode === 'waiting') {
      this.events.dragEnd();
    }
  }

  private cancel(): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    try {
      this.el.releasePointerCapture(d.pointerId);
    } catch {
      /* already released */
    }
    if (d.mode === 'reorder') {
      this.endReorderVisuals(d);
      this.events.reorder(d.originalOrder);
    } else if (d.mode === 'window' || d.mode === 'waiting') {
      this.events.dragCancel();
    }
  }

  private endReorderVisuals(d: DragState): void {
    d.el.classList.remove('dragging');
    d.el.style.transform = '';
    delete d.el.dataset.dx;
    this.el.classList.remove('reordering');
  }
}
