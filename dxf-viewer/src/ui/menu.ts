/** Minimal context menu. */
export interface MenuItem {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  action: () => void;
}

let open: HTMLElement | null = null;

export function closeMenu(): void {
  open?.remove();
  open = null;
}

export function showMenu(x: number, y: number, items: Array<MenuItem | '-'>): void {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.setAttribute('role', 'menu');
  for (const item of items) {
    if (item === '-') {
      menu.append(Object.assign(document.createElement('div'), { className: 'menu-sep' }));
      continue;
    }
    const b = document.createElement('button');
    b.className = 'menu-item';
    b.setAttribute('role', 'menuitem');
    b.disabled = !!item.disabled;
    b.innerHTML = `<span></span><kbd></kbd>`;
    b.firstElementChild!.textContent = item.label;
    b.lastElementChild!.textContent = item.shortcut ?? '';
    b.addEventListener('click', () => {
      closeMenu();
      item.action();
    });
    menu.append(b);
  }
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - r.width - 4)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - r.height - 4)}px`;
  open = menu;
  (menu.querySelector('button:not(:disabled)') as HTMLElement | null)?.focus();
}

window.addEventListener('pointerdown', (e) => {
  if (open && !open.contains(e.target as Node)) closeMenu();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenu();
});
window.addEventListener('blur', closeMenu);
