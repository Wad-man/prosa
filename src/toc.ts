import { EditorView } from '@codemirror/view';
import { EditorSelection } from '@codemirror/state';
import { t } from './i18n';
import { sourceHeadings } from './editor/md-source';

/**
 * Document outline (#21): the first core capability gated by a feature flag
 * (src/features.ts). A left sidebar inside #editor-host, sibling of the
 * editor panes wrapper — shown via Вид → Оглавление / Ctrl+Shift+1, hidden
 * by default like Typora's collapsed sidebar.
 *
 * Heading sources are mode-native: the live DOM in visual mode (element
 * anchors survive Crepe rebuilds because they are re-queried per refresh),
 * the document text in source mode (ATX scan that skips fenced code).
 */

export interface TocSourceEditor {
  view: EditorView;
  getContent(): string;
  focus(): void;
}

export interface TocContext {
  getMode(): 'visual' | 'source';
  getVisualPane(): HTMLElement | null;
  getSource(): TocSourceEditor | null;
}

interface TocEntry {
  level: number;
  text: string;
  el?: Element;
  line?: number; // source mode, 1-based
}

export class TocPanel {
  private ctx: TocContext | null = null;
  private panel: HTMLElement | null = null;
  private list: HTMLElement | null = null;
  private entries: TocEntry[] = [];
  private activeIndex = -1;
  private flashTimer: number | undefined;

  mount(host: HTMLElement, ctx: TocContext): void {
    this.ctx = ctx;

    const panel = document.createElement('aside');
    panel.id = 'toc-panel';
    panel.hidden = true;
    panel.setAttribute('aria-label', t('tocTitle'));

    const head = document.createElement('div');
    head.className = 'toc-head';
    head.textContent = t('tocTitle');

    this.list = document.createElement('nav');
    this.list.className = 'toc-list';
    this.list.setAttribute('role', 'navigation');

    panel.append(head, this.list);
    host.prepend(panel); // first child: panes wrapper shifts right
    this.panel = panel;
  }

  relabel(): void {
    if (!this.panel) return;
    this.panel.setAttribute('aria-label', t('tocTitle'));
    const head = this.panel.querySelector('.toc-head');
    if (head) head.textContent = t('tocTitle');
    this.render(); // placeholder text is localized too
  }

  setVisible(visible: boolean): void {
    this.panel?.toggleAttribute('hidden', !visible);
  }

  isVisible(): boolean {
    return this.panel?.hidden !== true;
  }

  /**
   * Live heading elements of the visual mode. ProseMirror re-creates node
   * DOM on full replaces (file open, mode switch) — cached `el` references
   * go stale and detached, so every consumer re-resolves through here
   * instead of trusting the cached entry.
   */
  private visualHeadingEls(): Element[] {
    const pane = this.ctx?.getVisualPane();
    if (!pane) return [];
    return Array.from(
      pane.querySelectorAll(
        '.ProseMirror h1, .ProseMirror h2, .ProseMirror h3, .ProseMirror h4, .ProseMirror h5, .ProseMirror h6',
      ),
    );
  }

  /** Recollect headings from the active mode's native source. */
  refresh(): void {
    this.entries = [];
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.getMode() === 'visual') {
      for (const el of this.visualHeadingEls()) {
        this.entries.push({
          level: Number(el.tagName.slice(1)),
          text: (el.textContent ?? '').trim(),
          el,
        });
      }
    } else {
      const source = ctx.getSource();
      if (source) {
        for (const h of sourceHeadings(source.getContent())) {
          this.entries.push({ level: h.level, text: h.text, line: h.line });
        }
      }
    }
    this.activeIndex = -1;
    this.render();
    this.updateActive();
  }

  private render(): void {
    if (!this.list) return;
    this.list.replaceChildren();
    if (this.entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'toc-empty';
      empty.textContent = t('tocEmpty');
      this.list.append(empty);
      return;
    }
    this.entries.forEach((entry, i) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'toc-item';
      item.style.setProperty('--lvl', String(entry.level));
      item.textContent = entry.text || '#';
      item.title = entry.text;
      item.addEventListener('pointerdown', (e) => e.preventDefault());
      item.addEventListener('click', () => this.navigate(i));
      this.list?.append(item);
    });
  }

  private navigate(index: number): void {
    const entry = this.entries[index];
    const ctx = this.ctx;
    if (!entry || !ctx) return;
    if (ctx.getMode() === 'visual') {
      // re-resolve: the cached el may be stale after a PM full replace
      const els = this.visualHeadingEls();
      const el = els.length === this.entries.length ? els[index] : entry.el;
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      this.flash(el);
    } else {
      const source = ctx.getSource();
      if (source && entry.line !== undefined) {
        const view = source.view;
        const pos = Math.min(view.state.doc.line(entry.line).from + 1, view.state.doc.length);
        view.dispatch({
          selection: EditorSelection.cursor(pos),
          effects: EditorView.scrollIntoView(pos, { y: 'center' }),
        });
        source.focus();
      }
    }
    this.setActive(index);
  }

  private flash(el: Element | undefined): void {
    if (!(el instanceof HTMLElement)) return;
    window.clearTimeout(this.flashTimer);
    el.classList.remove('toc-flash');
    // restart the animation on repeated clicks
    void el.offsetWidth;
    el.classList.add('toc-flash');
    this.flashTimer = window.setTimeout(() => el.classList.remove('toc-flash'), 1300);
  }

  /** Highlight the heading the viewport is currently in (scroll listener). */
  updateActive(): void {
    if (!this.list || this.entries.length === 0) return;
    const ctx = this.ctx;
    if (!ctx) return;
    let index = -1;
    if (ctx.getMode() === 'visual') {
      // re-resolve for the same staleness reason as navigate()
      const els = this.visualHeadingEls();
      const useLive = els.length === this.entries.length ? els : this.entries.map((e) => e.el);
      for (let i = 0; i < useLive.length; i++) {
        const el = useLive[i];
        if (el && el.getBoundingClientRect().top <= 140) index = i;
      }
    } else {
      const source = ctx.getSource();
      if (source) {
        const view = source.view;
        const rect = view.dom.getBoundingClientRect();
        const pos = view.posAtCoords({ x: rect.left + 24, y: rect.top + 24 });
        if (pos !== null) {
          const line = view.state.doc.lineAt(pos).number;
          for (let i = 0; i < this.entries.length; i++) {
            if ((this.entries[i].line ?? Infinity) <= line) index = i;
          }
        }
      }
    }
    this.setActive(index);
  }

  private setActive(index: number): void {
    if (index === this.activeIndex) return;
    this.activeIndex = index;
    if (!this.list) return;
    const items = this.list.querySelectorAll('.toc-item');
    items.forEach((item, i) => item.classList.toggle('active', i === index));
    if (index >= 0) {
      // keep the active item in view when tracking scrolls past it
      items[index].scrollIntoView({ block: 'nearest' });
    }
  }
}
