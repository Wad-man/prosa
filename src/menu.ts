/**
 * Menu bar (#20): Файл · Правка · Параграф · Формат · Вид · Справка — Typora's
 * six sections, sized to what the core actually has (see menu-research.md in
 * prosa-docs). It replaces the three toolbar file buttons; the right side of
 * the toolbar (lang/theme/mode) stays.
 *
 * Sections are supplied as factories evaluated at open time, so labels,
 * checkmarks and enabled state are always fresh (language switch, cursor
 * moves) without any re-mount bookkeeping.
 *
 * Visual language of the dropdowns follows the right-click context panel
 * (panel tokens, hairline separators, right-aligned hotkey captions,
 * checkmarks on current state). Items suppress pointerdown so clicking one
 * never blurs the editor or collapses the selection the command acts on.
 */

export interface MenuEntry {
  label: string;
  hotkey?: string;
  /** executed on click/Enter; absent entries are informational */
  action?: () => void;
  /** checkbox state, rendered as a leading ✓ */
  checked?: () => boolean;
  separator?: true;
}

export interface MenuSection {
  label: string;
  /** physical-key accelerator, e.g. 'F' for Alt+F */
  altKey?: string;
  entries: MenuEntry[];
}

export class MenuBar {
  private host: HTMLElement | null = null;
  private sections: (() => MenuSection)[] = [];
  private buttons: HTMLButtonElement[] = [];
  private dropdown: HTMLElement | null = null;
  private openIndex = -1;

  mount(host: HTMLElement, sections: (() => MenuSection)[]): void {
    this.host = host;
    this.sections = sections;
    this.render();
  }

  /** Rebuild the bar labels (language switch). Closes any open menu. */
  relabel(): void {
    this.close();
    this.render();
  }

  private render(): void {
    if (!this.host) return;
    this.host.replaceChildren();
    this.buttons = [];
    this.sections.forEach((factory, i) => {
      const section = factory();
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'menu-btn';
      btn.textContent = section.label;
      btn.setAttribute('role', 'menuitem');
      btn.setAttribute('aria-haspopup', 'menu');
      btn.setAttribute('aria-expanded', 'false');
      if (section.altKey) {
        btn.title = `Alt+${section.altKey}`;
        btn.setAttribute('aria-keyshortcuts', `Alt+${section.altKey}`);
      }
      btn.addEventListener('pointerdown', (e) => e.preventDefault());
      btn.addEventListener('click', () => {
        if (this.openIndex === i) this.close();
        else this.open(i);
      });
      // hover switches sections while a menu is already open (menubar norm)
      btn.addEventListener('pointerenter', () => {
        if (this.openIndex >= 0 && this.openIndex !== i) this.open(i);
      });
      this.host?.append(btn);
      this.buttons.push(btn);
    });
  }

  isOpen(): boolean {
    return this.openIndex >= 0;
  }

  open(index: number): void {
    if (!this.host) return;
    this.close();
    const section = this.sections[index]?.();
    if (!section) return;
    this.openIndex = index;

    const menu = document.createElement('div');
    menu.className = 'prosa-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', section.label);

    for (const entry of section.entries) {
      if (entry.separator) {
        const sep = document.createElement('div');
        sep.className = 'menu-sep';
        sep.setAttribute('role', 'separator');
        menu.append(sep);
        continue;
      }
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'menu-item';
      const checked = entry.checked?.() === true;
      item.setAttribute('role', entry.checked ? 'menuitemcheckbox' : 'menuitem');
      if (entry.checked) item.setAttribute('aria-checked', String(checked));
      const check = document.createElement('span');
      check.className = 'menu-check';
      check.textContent = checked ? '✓' : '';
      const label = document.createElement('span');
      label.className = 'menu-label';
      label.textContent = entry.label;
      item.append(check, label);
      if (entry.hotkey) {
        const kbd = document.createElement('span');
        kbd.className = 'menu-kbd';
        kbd.textContent = entry.hotkey;
        item.append(kbd);
      }
      // keep editor focus/selection alive through the press (ctx-panel pattern)
      item.addEventListener('pointerdown', (e) => e.preventDefault());
      item.addEventListener('click', () => {
        this.close();
        entry.action?.();
      });
      menu.append(item);
    }

    document.body.append(menu);
    this.dropdown = menu;

    const btn = this.buttons[index];
    btn.setAttribute('aria-expanded', 'true');
    const rect = btn.getBoundingClientRect();
    const width = menu.offsetWidth;
    menu.style.left = `${Math.min(rect.left, window.innerWidth - width - 8)}px`;
    menu.style.top = `${rect.bottom + 4}px`;

    document.addEventListener('pointerdown', this.onOutsidePointerDown, true);
    document.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('blur', this.close);
  }

  close = (): void => {
    if (this.openIndex < 0) return;
    this.buttons[this.openIndex]?.setAttribute('aria-expanded', 'false');
    this.openIndex = -1;
    this.dropdown?.remove();
    this.dropdown = null;
    document.removeEventListener('pointerdown', this.onOutsidePointerDown, true);
    document.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('blur', this.close);
  };

  private onOutsidePointerDown = (e: PointerEvent): void => {
    const target = e.target instanceof Node ? e.target : null;
    if (this.dropdown?.contains(target)) return;
    const btn = target instanceof Element ? target.closest('.menu-btn') : null;
    if (btn && this.buttons.includes(btn as HTMLButtonElement)) return; // its own click toggles
    this.close();
  };

  private items(): HTMLButtonElement[] {
    if (!this.dropdown) return [];
    return Array.from(this.dropdown.querySelectorAll<HTMLButtonElement>('.menu-item'));
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.dropdown) return;
    const items = this.items();
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const current = items.indexOf(active as HTMLButtonElement);

    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      const opened = this.openIndex;
      this.close();
      this.buttons[opened === -1 ? 0 : opened]?.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      if (items.length === 0) return;
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      const next = current === -1 ? (dir === 1 ? 0 : items.length - 1) : (current + dir + items.length) % items.length;
      items[next].focus();
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      e.stopPropagation();
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      const next = (this.openIndex + dir + this.buttons.length) % this.buttons.length;
      this.open(next);
      const fresh = this.items();
      fresh[0]?.focus();
    } else if (e.key === 'Tab') {
      this.close();
    }
  };

  /** Open via Alt accelerator; pressing it for the already-open section
   * closes the menu (native menubar behavior). Returns true when the key
   * matched a section. */
  openByAltKey(code: string): boolean {
    const index = this.sections.findIndex((factory) => factory().altKey === code);
    if (index === -1) return false;
    if (this.openIndex === index) {
      this.close();
      this.buttons[index]?.focus();
      return true;
    }
    this.open(index);
    this.items()[0]?.focus();
    return true;
  }
}
