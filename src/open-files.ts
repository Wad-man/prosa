// #11 (этап 1): панель «Открытые» — вертикальный список документов окна.
// Дизайн-канон — гейт ★2 по итогам #109 (RESEARCH-OPEN-FILES-UX):
// список в левой колонке, без полосы табов; скрыта при одном документе;
// dirty-точка у строки; средний клик и × закрывают. Этап 1.5/2:
// #144 — кнопка-переключатель слева + перетаскивание ширины; #145 —
// ПКМ-меню строки файла и пустой области. Панель — чистый UI: состояние
// вкладок живёт в main.ts, сюда приходит готовый список.

import { t } from './i18n';
import { storageGet, storageSet } from './storage';
import { cssZoom } from './zoom';

export interface OpenTabInfo {
  id: number;
  name: string;
  dirty: boolean;
  active: boolean;
  /** #145: «Обновить» существует только у вкладки с файлом на диске */
  hasPath: boolean;
}

export interface OpenFilesHandlers {
  onActivate(id: number): void;
  onClose(id: number): void;
  /** #145: ПКМ по строке файла */
  onSave(id: number): void;
  onReload(id: number): void;
  /** #145: ПКМ по пустой области списка */
  onEmptyOpen(): void;
  onEmptyNew(): void;
  onEmptyCloseAll(): void;
}

/** #144: пользовательские настройки панели — переопределение видимости
 * (null = правило #109: колонка прячется при единственном документе) и
 * ширина (старт 240, границы 180–420 по канону #109). */
const OF_PREFS_KEY = 'prosa.openFiles';
const WIDTH_MIN = 180;
const WIDTH_MAX = 420;
const WIDTH_DEFAULT = 240;
/** владелец 2026-10-30: появление/скрытие колонки анимируется (ширина,
 * содержимое не сжимается — дети держат --of-w); совпадает с т-кой токена */
const OF_ANIM_MS = 200;

interface MenuEntry {
  label: string;
  hint?: string;
  separator?: boolean;
  action?: () => void;
}

export class OpenFilesPanel {
  private host: HTMLElement | null = null;
  private list: HTMLElement | null = null;
  private handlers: OpenFilesHandlers | null = null;
  private tabs: OpenTabInfo[] = [];
  private width = WIDTH_DEFAULT;
  private userShow: boolean | null = null;
  private shown = false;
  private menu: HTMLElement | null = null;
  private hideTimer = 0;

  mount(host: HTMLElement, handlers: OpenFilesHandlers): void {
    this.host = host;
    this.handlers = handlers;
    this.readPrefs();

    const panel = document.createElement('aside');
    panel.id = 'open-files';
    panel.hidden = true;
    panel.setAttribute('aria-label', t('openFilesTitle'));

    const cap = document.createElement('div');
    cap.className = 'of-cap';
    cap.textContent = t('openFilesTitle');

    this.list = document.createElement('ul');
    this.list.className = 'of-list';

    // #145: список сам решает, чьё меню открыть — строка или пустота
    panel.addEventListener('contextmenu', (e) => this.onContextMenu(e));
    // #144: перетаскивание правой границы
    const grip = document.createElement('div');
    grip.className = 'of-resize';
    grip.addEventListener('pointerdown', (e) => this.onResizeStart(e, grip));

    panel.append(cap, this.list, grip);
    host.prepend(panel);
    this.applyWidth();
    // меню закрывается внешним нажатием и Esc (capture — раньше клика по
    // пункту-соседу; панель живёт всё время приложения, снятия нет)
    document.addEventListener('pointerdown', this.onMenuPointerDown, true);
    document.addEventListener('keydown', this.onMenuKeyDown, true);
  }

  /** Полный ререндер — вкладок в окне единицы, стабильность важнее диффа. */
  setTabs(tabs: OpenTabInfo[]): void {
    this.tabs = tabs;
    const list = this.list;
    if (!list) return;
    list.replaceChildren();
    if (tabs.length === 0) {
      // #157: a forced-open panel (#144) over hidden empty drafts shows
      // why it is empty instead of bare space
      const empty = document.createElement('li');
      empty.className = 'of-empty';
      empty.textContent = t('openFilesEmpty');
      list.append(empty);
      return;
    }
    for (const tab of tabs) {
      const li = document.createElement('li');
      li.className = 'of-item' + (tab.active ? ' active' : '');
      li.dataset.id = String(tab.id);
      // средний клик — закрыть (канон Sublime/Блокнота)
      li.addEventListener('auxclick', (e) => {
        if (e.button === 1) {
          e.preventDefault();
          this.handlers?.onClose(tab.id);
        }
      });
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'of-btn';
      btn.title = tab.name;
      btn.addEventListener('click', () => {
        if (!tab.active) this.handlers?.onActivate(tab.id);
      });
      const dot = document.createElement('span');
      dot.className = 'of-dot' + (tab.dirty ? ' dirty' : '');
      dot.setAttribute('aria-hidden', 'true');
      const name = document.createElement('span');
      name.className = 'of-name';
      name.textContent = tab.name;
      btn.append(dot, name);
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'of-close';
      close.setAttribute('aria-label', `${t('closeTab')} ${tab.name}`);
      // #143: the glyph itself (Lucide "x" geometry, MIT — the same stroke
      // style as the toolbar icons); CSS only sizes the button, there is
      // no text fallback to localize
      close.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        this.handlers?.onClose(tab.id);
      });
      li.append(btn, close);
      list.append(li);
    }
  }

  /** #109: колонка не занимает место у единственного документа окна;
   * #144: явное нажатие кнопки переопределяет правило (до обратного
   * нажатия, персистится). */
  applyVisibility(multi: boolean): void {
    this.setVisible(this.userShow ?? multi);
  }

  /** Кнопка-переключатель (#144) — текущее состояние видимости. */
  toggle(): void {
    this.userShow = !this.shown;
    this.writePrefs();
    this.setVisible(this.userShow);
  }

  isShown(): boolean {
    return this.shown;
  }

  setVisible(visible: boolean): void {
    if (visible === this.shown || !this.host) return;
    this.shown = visible;
    const panel = this.host.querySelector('#open-files') as HTMLElement | null;
    if (panel) {
      // владелец 2026-10-30: показать/скрыть — анимация ширины; в конце
      // скрытия панель честно уходит из потока и a11y ([hidden])
      window.clearTimeout(this.hideTimer);
      panel.classList.add('of-anim');
      if (visible) {
        panel.hidden = false;
        panel.classList.add('of-collapsed');
        // перекомпоновка до снятия класса, иначе переход не стартанёт с нуля
        void panel.offsetWidth;
        panel.classList.remove('of-collapsed');
        this.hideTimer = window.setTimeout(
          () => panel.classList.remove('of-anim'),
          OF_ANIM_MS + 40,
        );
      } else {
        panel.classList.add('of-collapsed');
        this.hideTimer = window.setTimeout(() => {
          panel.hidden = true;
          panel.classList.remove('of-anim');
        }, OF_ANIM_MS + 40);
      }
    }
    this.host.classList.toggle('of-open', visible);
  }

  relabel(): void {
    const panel = this.host?.querySelector('#open-files') as HTMLElement | null;
    if (!panel) return;
    panel.setAttribute('aria-label', t('openFilesTitle'));
    const cap = panel.querySelector('.of-cap');
    if (cap) cap.textContent = t('openFilesTitle');
  }

  // ---------- #145: контекстные меню ----------

  private onContextMenu(e: MouseEvent): void {
    // #142: нативное меню WebView не появляется нигде в приложении —
    // даже там, где своего меню пока нет
    e.preventDefault();
    const target = e.target instanceof Element ? e.target : null;
    const item = target?.closest('.of-item') ?? null;
    const id = item ? Number((item as HTMLElement).dataset.id) : NaN;
    if (item !== null && !Number.isNaN(id)) {
      const tab = this.tabs.find((tb) => tb.id === id);
      if (!tab) return;
      const entries: MenuEntry[] = [
        { label: t('save'), hint: 'Ctrl+S', action: () => this.handlers?.onSave(id) },
        ...(tab.hasPath ? [{ label: t('reload'), action: () => this.handlers?.onReload(id) }] : []),
        { label: '', separator: true },
        { label: t('closeTab'), action: () => this.handlers?.onClose(id) },
      ];
      this.showMenu(e, entries);
      return;
    }
    // пустая область списка (и заголовок) — оконные действия
    this.showMenu(e, [
      { label: t('open'), hint: 'Ctrl+O', action: () => this.handlers?.onEmptyOpen() },
      { label: t('newDoc'), hint: 'Ctrl+N', action: () => this.handlers?.onEmptyNew() },
      { label: '', separator: true },
      { label: t('closeAll'), action: () => this.handlers?.onEmptyCloseAll() },
    ]);
  }

  /** Меню в стиле ПКМ-панели редактора (.prosa-ctx-panel): тот же вид,
   * строки-пункты вместо иконок. Закрывается внешним кликом и Esc. */
  private showMenu(e: MouseEvent, entries: MenuEntry[]): void {
    this.closeMenu();
    const menu = document.createElement('div');
    menu.className = 'prosa-ctx-panel of-menu';
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

  // ---------- #144: ширина и персист ----------

  private onResizeStart(e: PointerEvent, grip: HTMLElement): void {
    e.preventDefault();
    const panel = this.host?.querySelector('#open-files') as HTMLElement | null;
    if (!panel) return;
    grip.setPointerCapture(e.pointerId);
    const base = panel.getBoundingClientRect().left;
    const move = (ev: PointerEvent): void => {
      this.width = Math.round(Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, ev.clientX - base)));
      this.applyWidth();
    };
    const up = (): void => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      this.writePrefs();
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  }

  private applyWidth(): void {
    const panel = this.host?.querySelector('#open-files') as HTMLElement | null;
    // ширина живёт в CSS-переменной: класс .of-collapsed анимирует ширину
    // в ноль, не воюя с инлайном, а дети держат её же — не сжимаясь
    if (panel) panel.style.setProperty('--of-w', `${this.width}px`);
  }

  private readPrefs(): void {
    try {
      const raw = storageGet(OF_PREFS_KEY);
      if (raw === null) return;
      const prefs = JSON.parse(raw) as { show?: unknown; width?: unknown };
      if (typeof prefs.show === 'boolean') this.userShow = prefs.show;
      if (typeof prefs.width === 'number' && Number.isFinite(prefs.width))
        this.width = Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, Math.round(prefs.width)));
    } catch {
      // битый JSON — стартуем с дефолтов
    }
  }

  private writePrefs(): void {
    storageSet(OF_PREFS_KEY, JSON.stringify({ show: this.userShow, width: this.width }));
  }
}
