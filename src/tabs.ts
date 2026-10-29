// #11 (этап 2, решение владельца 2026-10-30): полоса открытых вкладок
// окна — второй ряд под тулбаром, ДОПОЛНЕНИЕ к вертикальной колонке
// «Открытые» этапа 1 (#142–146; владелец: сайдбар остаётся без изменений,
// табы добавляются — модель Sublime из заявки #11). Обе поверхности — чистый
// UI над одним состоянием вкладок в main.ts, сюда приходит готовый список.
// Паттерны #109 §6: dirty-точка на месте крестика, крестик по наведению,
// средний клик — закрыть, ПКМ-меню таба и пустой области. 10+ открытых:
// табы сжимаются до минимума, полоса скроллится колесом, активный таб
// автопоказывается, «+» закреплён вне скроллера.

import { t } from './i18n';
import { cssZoom } from './zoom';

export interface TabInfo {
  id: number;
  /** отображаемое имя — базовое, без расширения (#109 §6) */
  name: string;
  /** полный путь файла для подсказки таба; пусто у безымянных */
  title: string;
  dirty: boolean;
  active: boolean;
  /** #145: «Обновить» существует только у вкладки с файлом на диске */
  hasPath: boolean;
}

export interface TabStripHandlers {
  onActivate(id: number): void;
  onClose(id: number): void;
  /** #145: ПКМ по табу — сохранить/обновить идут через активную вкладку */
  onSave(id: number): void;
  onReload(id: number): void;
  /** #145: ПКМ по пустой области полосы */
  onOpen(): void;
  onNew(): void;
  onCloseAll(): void;
}

interface MenuEntry {
  label: string;
  hint?: string;
  separator?: boolean;
  action?: () => void;
}

export class TabStrip {
  private root: HTMLElement | null = null;
  private scroller: HTMLElement | null = null;
  private newBtn: HTMLButtonElement | null = null;
  private handlers: TabStripHandlers | null = null;
  private tabs: TabInfo[] = [];
  private menu: HTMLElement | null = null;
  private lastActiveId: number | null = null;

  mount(root: HTMLElement, handlers: TabStripHandlers): void {
    this.root = root;
    this.handlers = handlers;

    const scroller = document.createElement('div');
    scroller.className = 'ts-scroll';
    // #109 §6 «переполнение»: колесо листает полосу по горизонтали —
    // жест не должен «проваливаться» в документ под полосой
    scroller.addEventListener(
      'wheel',
      (e) => {
        if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
        if (scroller.scrollWidth <= scroller.clientWidth) return;
        e.preventDefault();
        scroller.scrollLeft += e.deltaY;
      },
      { passive: false },
    );
    this.scroller = scroller;

    const newBtn = document.createElement('button');
    newBtn.type = 'button';
    newBtn.className = 'ts-new';
    newBtn.dataset.tipPos = 'end';
    // глиф (Lucide «plus», MIT) — тот же stroke-стиль, что и остальные
    // иконки интерфейса; CSS только размерит кнопку
    newBtn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M5 12h14"/><path d="M12 5v14"/></svg>';
    newBtn.addEventListener('click', () => this.handlers?.onNew());
    this.newBtn = newBtn;

    root.append(scroller, newBtn);
    // список сам решает, чьё меню открыть — таб или пустота
    root.addEventListener('contextmenu', (e) => this.onContextMenu(e));
    // меню закрывается внешним нажатием и Esc (capture — раньше клика по
    // пункту-соседу; полоса живёт всё время приложения, снятия нет)
    document.addEventListener('pointerdown', this.onMenuPointerDown, true);
    document.addEventListener('keydown', this.onMenuKeyDown, true);

    this.relabel();
  }

  /** Полный ререндер — вкладок в окне единицы, стабильность важнее диффа.
   * Позиция скролла переживает ререндер (dirty-точка меняется чаще
   * состава); активный таб подъезжает в зону видимости только при СМЕНЕ
   * активного — правка текста в фоне не дёргает полосу. */
  setTabs(tabs: TabInfo[]): void {
    this.tabs = tabs;
    const scroller = this.scroller;
    const root = this.root;
    if (!scroller || !root) return;
    const keepScroll = scroller.scrollLeft;
    scroller.replaceChildren();
    for (const tab of tabs) scroller.append(this.renderTab(tab));
    scroller.scrollLeft = keepScroll;
    root.hidden = tabs.length === 0;
    const active = tabs.find((tb) => tb.active) ?? null;
    if (active === null) {
      this.lastActiveId = null;
      return;
    }
    if (active.id !== this.lastActiveId) {
      this.lastActiveId = active.id;
      const el = scroller.querySelector<HTMLElement>('.ts-tab.active');
      if (el) this.reveal(el);
    }
  }

  relabel(): void {
    this.root?.setAttribute('aria-label', t('openFilesTitle'));
    if (this.newBtn) {
      const label = `${t('newDoc')} · Ctrl+N`;
      this.newBtn.dataset.tip = label;
      this.newBtn.setAttribute('aria-label', label);
    }
  }

  private renderTab(tab: TabInfo): HTMLElement {
    const el = document.createElement('div');
    el.className = 'ts-tab' + (tab.active ? ' active' : '') + (tab.dirty ? ' dirty' : '');
    el.setAttribute('role', 'tab');
    el.setAttribute('aria-selected', String(tab.active));
    el.tabIndex = 0;
    el.dataset.id = String(tab.id);
    if (tab.title !== '') el.title = tab.title;
    // клик по любой точке таба активирует (кроме ×) — мишень не должна
    // сжиматься вместе с табом (Фиттс, #109 §2.3)
    el.addEventListener('click', () => {
      if (!tab.active) this.handlers?.onActivate(tab.id);
    });
    // средний клик — закрыть (канон Sublime/Блокнота)
    el.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        this.handlers?.onClose(tab.id);
      }
    });
    // минимальная клавиатура таба: Enter/Space активирует, стрелки ходят
    // по вкладкам (roving tabindex — кандидат v2)
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        if (!tab.active) {
          e.preventDefault();
          this.handlers?.onActivate(tab.id);
        }
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        this.focusNeighbour(el, e.key === 'ArrowRight' ? 1 : -1);
      }
    });
    const name = document.createElement('span');
    name.className = 'ts-name';
    name.textContent = tab.name;
    const dot = document.createElement('span');
    dot.className = 'ts-dot';
    dot.setAttribute('aria-hidden', 'true');
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'ts-x';
    close.setAttribute('aria-label', `${t('closeTab')} ${tab.name}`);
    // #143: глиф (Lucide «x», MIT) — тот же stroke-стиль, что и тулбар
    close.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      this.handlers?.onClose(tab.id);
    });
    el.append(name, dot, close);
    return el;
  }

  private focusNeighbour(el: HTMLElement, dir: 1 | -1): void {
    const tabs = Array.from(this.scroller?.querySelectorAll<HTMLElement>('.ts-tab') ?? []);
    const next = tabs[tabs.indexOf(el) + dir];
    if (next) {
      next.focus();
      this.reveal(next);
    }
  }

  /** Довести таб до зоны видимости полосы — переключение и так мгновенное,
   * анимация прокрутки только добавила бы лаг. Позиция считается
   * rect-дельтой: offsetLeft привязан к offsetParent, и сайдбар слева
   * (владелец 2026-10-30: полоса сдвигается колонкой) сдвигал бы
   * арифметику на ширину колонки. */
  private reveal(el: HTMLElement): void {
    const scroller = this.scroller;
    if (!scroller) return;
    const left =
      el.getBoundingClientRect().left - scroller.getBoundingClientRect().left + scroller.scrollLeft;
    const right = left + el.offsetWidth;
    if (left < scroller.scrollLeft) scroller.scrollLeft = left;
    else if (right > scroller.scrollLeft + scroller.clientWidth)
      scroller.scrollLeft = right - scroller.clientWidth;
  }

  // ---------- #145: контекстные меню (наследники панели «Открытые») ----------

  private onContextMenu(e: MouseEvent): void {
    // #142: нативное меню WebView не появляется нигде в приложении —
    // даже там, где своего меню пока нет
    e.preventDefault();
    const target = e.target instanceof Element ? e.target : null;
    const item = target?.closest('.ts-tab') ?? null;
    const id = item ? Number((item as HTMLElement).dataset.id) : NaN;
    if (item !== null && !Number.isNaN(id)) {
      const tab = this.tabs.find((tb) => tb.id === id);
      if (!tab) return;
      const entries: MenuEntry[] = [
        { label: t('save'), hint: 'Ctrl+S', action: () => this.handlers?.onSave(id) },
        ...(tab.hasPath
          ? [{ label: t('reload'), action: () => this.handlers?.onReload(id) }]
          : []),
        { label: '', separator: true },
        { label: t('closeTab'), action: () => this.handlers?.onClose(id) },
      ];
      this.showMenu(e, entries);
      return;
    }
    // пустая область полосы — оконные действия
    this.showMenu(e, [
      { label: t('open'), hint: 'Ctrl+O', action: () => this.handlers?.onOpen() },
      { label: t('newDoc'), hint: 'Ctrl+N', action: () => this.handlers?.onNew() },
      { label: '', separator: true },
      { label: t('closeAll'), action: () => this.handlers?.onCloseAll() },
    ]);
  }

  /** Меню в стиле ПКМ-панели редактора (.prosa-ctx-panel): тот же вид,
   * строки-пункты вместо иконок. Закрывается внешним кликом и Esc. */
  private showMenu(e: MouseEvent, entries: MenuEntry[]): void {
    this.closeMenu();
    const menu = document.createElement('div');
    menu.className = 'prosa-ctx-panel ts-menu';
    menu.setAttribute('role', 'menu');
    for (const entry of entries) {
      if (entry.separator) {
        const s = document.createElement('div');
        s.className = 'ctx-sep';
        menu.append(s);
        continue;
      }
      const row = document.createElement('div');
      row.className = 'ctx-item';
      row.setAttribute('role', 'menuitem');
      row.innerHTML =
        `<span>${entry.label}</span>` +
        (entry.hint ? `<span class="ctx-kbd">${entry.hint}</span>` : '');
      row.addEventListener('click', () => {
        this.closeMenu();
        entry.action?.();
      });
      menu.append(row);
    }
    document.body.append(menu);
    this.menu = menu;
    const r = menu.getBoundingClientRect();
    // e.clientX/Y — визуальные пиксели, а потомок <html> ждёт CSS-px (#25)
    const z = cssZoom();
    menu.style.left = `${Math.min(Math.max(8, e.clientX), innerWidth - r.width - 8) / z}px`;
    menu.style.top = `${Math.min(Math.max(8, e.clientY + 4), innerHeight - r.height - 8) / z}px`;
  }

  closeMenu(): void {
    this.menu?.remove();
    this.menu = null;
  }

  private onMenuPointerDown = (e: PointerEvent): void => {
    if (!this.menu) return;
    const node = e.target instanceof Node ? e.target : null;
    if (this.menu.contains(node)) return;
    this.closeMenu();
  };

  private onMenuKeyDown = (e: KeyboardEvent): void => {
    if (this.menu && e.key === 'Escape') this.closeMenu();
  };
}
