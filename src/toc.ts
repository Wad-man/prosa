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
  /** The live mode collapsed to the pane that renders it: reading → 'visual'
   *  (same render), split stays 'split' — the #91 gate (2026-10-15, вариант
   *  А) makes split code-first: entries come from the ATX scan, navigation
   *  drives the code pane with the preview softly following. */
  getMode(): 'visual' | 'source' | 'split';
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
  private host: HTMLElement | null = null;
  private panel: HTMLElement | null = null;
  private list: HTMLElement | null = null;
  private entries: TocEntry[] = [];
  private activeIndex = -1;
  private flashTimer: number | undefined;
  // #36: [hidden] lands only after the close transition finished
  private closeTimer: number | undefined;
  // #30: skip button rebuilds when the headings did not change — mode
  // switches used to recreate every .toc-item (and its listeners) for nothing.
  // #50: starts at null — '' is the legitimate signature of a heading-less
  // document and must not collide with "never rendered yet" (the fresh
  // empty document skipped its placeholder on exactly that collision)
  private renderedSig: string | null = null;

  mount(host: HTMLElement, ctx: TocContext): void {
    this.ctx = ctx;
    this.host = host;

    const panel = document.createElement('aside');
    panel.id = 'toc-panel';
    panel.hidden = true;
    panel.setAttribute('aria-label', t('tocTitle'));

    // #91: a quiet page-part caption instead of the old sidebar header
    const cap = document.createElement('div');
    cap.className = 'toc-cap';
    cap.textContent = t('tocOnPage');

    this.list = document.createElement('nav');
    this.list.className = 'toc-list';
    this.list.setAttribute('role', 'navigation');

    panel.append(cap, this.list);
    // #91: right column, after the text in DOM so Tab reaches the document
    // first and screen readers announce text before navigation
    host.append(panel);
    this.panel = panel;
  }

  relabel(): void {
    if (!this.panel) return;
    this.panel.setAttribute('aria-label', t('tocTitle'));
    const cap = this.panel.querySelector('.toc-cap');
    if (cap) cap.textContent = t('tocOnPage');
    this.render(); // placeholder text is localized too
  }

  /** Show/hide the overlay column (#91 → rc.7): a transform+opacity flight
   *  on the panel (compositor-only — the text column's padding does the
   *  layout side) with `hidden` landing only after the close transition
   *  finished; `inert` drops the closing panel from the tab order at once.
   *  Before opening, the host gets --sb — the live scrollbar width of the
   *  text scroller, so the column parks left of the bar instead of over
   *  it (Chromium ignores custom ::-webkit widths under scrollbar-width,
   *  measuring beats guessing on every platform). */
  setVisible(visible: boolean): void {
    const panel = this.panel;
    if (!panel) return;
    const open = panel.classList.contains('is-open');
    if (visible === open) return;
    window.clearTimeout(this.closeTimer);
    if (visible) {
      const host = this.host;
      if (host) {
        const scroller = document.getElementById('visual-editor') ?? host.firstElementChild;
        const sb =
          scroller instanceof HTMLElement ? scroller.offsetWidth - scroller.clientWidth : 0;
        host.style.setProperty('--sb', `${Math.max(0, sb)}px`);
      }
      panel.hidden = false;
      panel.inert = false;
      // reflow so the flight plays from the parked state, not from display:none
      void panel.offsetWidth;
      panel.classList.add('is-open');
      this.host?.classList.add('toc-open');
    } else {
      panel.classList.remove('is-open');
      this.host?.classList.remove('toc-open');
      panel.inert = true;
      this.closeTimer = window.setTimeout(() => {
        if (!panel.classList.contains('is-open')) panel.hidden = true;
      }, 260);
    }
  }

  isVisible(): boolean {
    const panel = this.panel;
    return panel !== null && panel.classList.contains('is-open');
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
    // same headings as the last render — the buttons (and their listeners)
    // stay; only the active highlight may still change (#30)
    const sig = this.entries.map((e) => `${e.level}|${e.text}`).join('\n');
    if (sig === this.renderedSig) return;
    this.renderedSig = sig;
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
        // #91 gate (вариант А): a split click is code-first — the preview no
        // longer needs an explicit follow, the panes scroll as one (#62,
        // гейт 2026-10-15): the code jump itself carries the preview along
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
        // #91 gate: in split the active item follows the caret («where I'm
        // editing» — predictable, already known); pane scroll drifts, and a
        // preview scrolled away for a check must not make the outline lie.
        // Plain source keeps its viewport-top tracking (#21 behavior).
        let line: number;
        if (ctx.getMode() === 'split') {
          line = view.state.doc.lineAt(view.state.selection.main.head).number;
        } else {
          const rect = view.dom.getBoundingClientRect();
          const pos = view.posAtCoords({ x: rect.left + 24, y: rect.top + 24 });
          if (pos === null) return;
          line = view.state.doc.lineAt(pos).number;
        }
        for (let i = 0; i < this.entries.length; i++) {
          if ((this.entries[i].line ?? Infinity) <= line) index = i;
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
