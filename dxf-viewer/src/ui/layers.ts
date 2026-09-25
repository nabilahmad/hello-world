/** Layers panel: toggle layer visibility. */
import type { DocView, Theme } from '../view/viewer';
import { displayColor } from '../view/viewer';

export class LayersPanel {
  private doc: DocView | null = null;
  private theme: Theme = 'dark';
  private filter = '';
  private readonly list: HTMLElement;
  private readonly search: HTMLInputElement;

  constructor(
    readonly el: HTMLElement,
    private readonly onChange: (visible: boolean[]) => void,
  ) {
    el.innerHTML =
      '<div class="panel-head"><span>Layers</span><span class="panel-actions">' +
      '<button data-all="1" title="Show all layers">All</button><button data-all="0" title="Hide all layers">None</button>' +
      '</span></div><input class="panel-search" type="search" placeholder="Filter layers" spellcheck="false">' +
      '<div class="layer-list" role="list"></div>';
    this.list = el.querySelector('.layer-list')!;
    this.search = el.querySelector('.panel-search')!;
    this.search.addEventListener('input', () => {
      this.filter = this.search.value.trim().toLowerCase();
      this.renderList();
    });
    el.querySelectorAll<HTMLButtonElement>('[data-all]').forEach((b) =>
      b.addEventListener('click', () => {
        if (!this.doc) return;
        const on = b.dataset.all === '1';
        const names = this.visibleNames();
        this.onChange(this.doc.layerVisible.map((v, i) => (names.has(i) ? on : v)));
      }),
    );
    this.list.addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement;
      if (!this.doc || input.type !== 'checkbox') return;
      const i = Number(input.dataset.layer);
      const vis = [...this.doc.layerVisible];
      vis[i] = input.checked;
      this.onChange(vis);
    });
  }

  private visibleNames(): Set<number> {
    const out = new Set<number>();
    this.doc?.model.layers.forEach((l, i) => {
      if (!this.filter || l.name.toLowerCase().includes(this.filter)) out.add(i);
    });
    return out;
  }

  render(doc: DocView | null, theme: Theme): void {
    this.doc = doc;
    this.theme = theme;
    this.search.hidden = !doc || doc.model.layers.length < 10;
    this.renderList();
  }

  private renderList(): void {
    const doc = this.doc;
    if (!doc) {
      this.list.innerHTML = '<div class="panel-empty">No drawing</div>';
      return;
    }
    const shown = this.visibleNames();
    const rows = doc.model.layers
      .map((l, i) => ({ l, i }))
      .filter(({ l, i }) => shown.has(i) && (l.count > 0 || !doc.layerVisible[i]))
      .sort((a, b) => a.l.name.localeCompare(b.l.name, undefined, { numeric: true }));
    this.list.innerHTML = '';
    for (const { l, i } of rows) {
      const row = document.createElement('label');
      row.className = 'layer-row';
      row.setAttribute('role', 'listitem');
      row.innerHTML = '<input type="checkbox"><span class="swatch"></span><span class="layer-name"></span><span class="layer-count"></span>';
      const box = row.querySelector('input')!;
      box.checked = doc.layerVisible[i];
      box.dataset.layer = String(i);
      (row.querySelector('.swatch') as HTMLElement).style.background = displayColor(l.color, this.theme);
      row.querySelector('.layer-name')!.textContent = l.name;
      row.querySelector('.layer-count')!.textContent = l.count ? l.count.toLocaleString() : '';
      this.list.append(row);
    }
    if (!rows.length) this.list.innerHTML = '<div class="panel-empty">No layers</div>';
  }
}
