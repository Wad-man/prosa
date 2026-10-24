// #11 (этап 1): панель «Открытые» — вертикальный список документов окна.
// Дизайн-канон — гейт ★2 по итогам #109 (RESEARCH-OPEN-FILES-UX):
// список в левой колонке, без полосы табов; скрыта при одном документе;
// dirty-точка у строки; средний клик и × закрывают. Порядок и ПКМ-меню —
// этап 2. Панель — чистый UI: состояние вкладок живёт в main.ts, сюда
// приходит готовый список.

import { t } from './i18n';

export interface OpenTabInfo {
  id: number;
  name: string;
  dirty: boolean;
  active: boolean;
}

export interface OpenFilesHandlers {
  onActivate(id: number): void;
  onClose(id: number): void;
}

export class OpenFilesPanel {
  private host: HTMLElement | null = null;
  private list: HTMLElement | null = null;
  private handlers: OpenFilesHandlers | null = null;
  private width = 240; // #109: 180–420, старт 240; резайл границы — этап 1.5
  private shown = false;

  mount(host: HTMLElement, handlers: OpenFilesHandlers): void {
    this.host = host;
    this.handlers = handlers;

    const panel = document.createElement('aside');
    panel.id = 'open-files';
    panel.hidden = true;
    panel.setAttribute('aria-label', t('openFilesTitle'));

    const cap = document.createElement('div');
    cap.className = 'of-cap';
    cap.textContent = t('openFilesTitle');

    this.list = document.createElement('ul');
    this.list.className = 'of-list';

    panel.append(cap, this.list);
    host.prepend(panel);
    this.applyWidth();
  }

  /** Полный ререндер — вкладок в окне единицы, стабильность важнее диффа. */
  setTabs(tabs: OpenTabInfo[]): void {
    const list = this.list;
    if (!list) return;
    list.replaceChildren();
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
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        this.handlers?.onClose(tab.id);
      });
      li.append(btn, close);
      list.append(li);
    }
  }

  /** #109: колонка не занимает место у единственного документа окна. */
  setVisible(visible: boolean): void {
    if (visible === this.shown || !this.host) return;
    this.shown = visible;
    const panel = this.host.querySelector('#open-files') as HTMLElement | null;
    if (panel) panel.hidden = !visible;
    this.host.classList.toggle('of-open', visible);
  }

  relabel(): void {
    const panel = this.host?.querySelector('#open-files') as HTMLElement | null;
    if (!panel) return;
    panel.setAttribute('aria-label', t('openFilesTitle'));
    const cap = panel.querySelector('.of-cap');
    if (cap) cap.textContent = t('openFilesTitle');
  }

  private applyWidth(): void {
    const panel = this.host?.querySelector('#open-files') as HTMLElement | null;
    if (panel) panel.style.width = `${this.width}px`;
  }
}
