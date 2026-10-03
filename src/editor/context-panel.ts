import type { Crepe } from '@milkdown/crepe';
import type { Ctx } from '@milkdown/kit/ctx';
import { commandsCtx } from '@milkdown/kit/core';
import { toggleLinkCommand } from '@milkdown/kit/component/link-tooltip';
import {
  blockquoteSchema,
  bulletListSchema,
  codeBlockSchema,
  headingSchema,
  orderedListSchema,
  paragraphSchema,
  setBlockTypeCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleStrongCommand,
  wrapInBlockTypeCommand,
} from '@milkdown/kit/preset/commonmark';
import { toggleStrikethroughCommand } from '@milkdown/kit/preset/gfm';

import { editorStrings } from './crepe-locale';
import { getLang } from '../i18n';

/**
 * Right-click formatting panel (owner decision 2026-10-03, after HTML
 * prototype testing): THE floating panel of the visual editor, replacing
 * Crepe's auto selection toolbar (features: { toolbar: false }).
 *
 * Adaptive content, driven by the selection at contextmenu time (on
 * Windows a right-click inside a selection keeps it, outside — collapses
 * to a caret, so the DOM selection read here is the right trigger):
 * - text selected in the editor → inline marks row + block row + submenu;
 * - caret only → block row + submenu (the "change block type" path).
 *
 * All actions run the same stock milkdown commands Crepe's own UI uses
 * (via commandsCtx), so everything lands on the undo stack and no library
 * code is forked. Labels come from editorStrings() at open time — a
 * language switch re-localizes the panel without an editor rebuild.
 *
 * Buttons suppress pointerdown (Crepe toolbar pattern) so clicking a
 * button never blurs the editor or collapses the selection the command
 * is about to act on.
 */

const ICONS = {
  link: '<svg viewBox="0 0 24 24"><path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5"/></svg>',
  code: '<svg viewBox="0 0 24 24"><path d="m8 7-5 5 5 5"/><path d="m16 7 5 5-5 5"/></svg>',
  quote:
    '<svg viewBox="0 0 24 24"><path d="M9 7H5a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h2c0 2-1 3-3 3"/><path d="M19 7h-4a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h2c0 2-1 3-3 3"/></svg>',
  ul: '<svg viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1" fill="currentColor"/><circle cx="3.5" cy="12" r="1" fill="currentColor"/><circle cx="3.5" cy="18" r="1" fill="currentColor"/></svg>',
  ol: '<svg viewBox="0 0 24 24"><path d="M10 6h11M10 12h11M10 18h11"/><text x="2" y="8" font-size="7" fill="currentColor" stroke="none">1</text><text x="2" y="14.5" font-size="7" fill="currentColor" stroke="none">2</text><text x="2" y="20.5" font-size="7" fill="currentColor" stroke="none">3</text></svg>',
};

type BlockId = 'text' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'quote' | 'ul' | 'ol' | 'code';

/** Hotkey captions shown in the submenu — the aliases/combos that exist
 * in the product (Windows-only today, so plain Ctrl-spelling is fine). */
const BLOCK_HOTKEYS: Record<BlockId, string> = {
  text: 'Ctrl+0',
  h1: 'Ctrl+1',
  h2: 'Ctrl+2',
  h3: 'Ctrl+3',
  h4: 'Ctrl+4',
  h5: 'Ctrl+5',
  h6: 'Ctrl+6',
  quote: 'Ctrl+Shift+B',
  ul: 'Ctrl+Alt+8',
  ol: 'Ctrl+Alt+7',
  code: 'Ctrl+Alt+C',
};

export class ContextPanel {
  private crepe: Crepe | null = null;
  private root: HTMLElement | null = null;
  private panel: HTMLElement | null = null;
  private submenu: HTMLElement | null = null;
  private closeTimer: number | undefined;

  mount(crepe: Crepe, root: HTMLElement): void {
    this.crepe = crepe;
    this.root = root;
    // document-level so the block handle («+», a body-level overlay in
    // the left gutter) also opens our panel instead of the native menu
    document.addEventListener('contextmenu', this.onContextMenu);
    document.addEventListener('pointerdown', this.onPointerDown, true);
    document.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('blur', this.close);
  }

  destroy(): void {
    document.removeEventListener('contextmenu', this.onContextMenu);
    document.removeEventListener('pointerdown', this.onPointerDown, true);
    document.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('blur', this.close);
    this.close();
    this.crepe = null;
    this.root = null;
  }

  private close = (): void => {
    window.clearTimeout(this.closeTimer);
    this.panel?.remove();
    this.submenu?.remove();
    this.panel = null;
    this.submenu = null;
  };

  /** Outside press closes the panel; a press inside it is handled by the
   * buttons themselves (pointerdown-prevented, selection kept). */
  private onPointerDown = (e: PointerEvent): void => {
    if (!this.panel) return;
    const t = e.target instanceof Node ? e.target : null;
    if (this.panel.contains(t) || this.submenu?.contains(t)) return;
    this.close();
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (this.panel && e.key === 'Escape') this.close();
  };

  /** Context-menu convention: an executed action closes the panel; the
   * submenu opener row is exempt (hover target). */
  private onPanelClick = (e: Event): void => {
    if (e.target instanceof Element && e.target.closest('[aria-haspopup]')) return;
    this.close();
  };

  /** The submenu is a sibling element on body — schedule its removal when
   * the pointer leaves the panel/submenu area (with a small grace period
   * for the gap crossing). */
  private scheduleSubmenuClose = (): void => {
    window.clearTimeout(this.closeTimer);
    this.closeTimer = window.setTimeout(() => {
      this.submenu?.remove();
      this.submenu = null;
    }, 200);
  };

  private cancelSubmenuClose = (): void => {
    window.clearTimeout(this.closeTimer);
  };

  private onContextMenu = (e: MouseEvent): void => {
    // our panel replaces the native menu inside the editor (and on the
    // block handle overlay) only — everywhere else the native menu stays
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    if (!this.root?.contains(t) && !t.closest('.milkdown-block-handle')) return;
    e.preventDefault();
    this.close();
    const s = editorStrings(getLang());
    const hasSel =
      !getSelection()?.isCollapsed &&
      this.root?.contains(getSelection()?.anchorNode ?? null) === true;

    const panel = document.createElement('div');
    panel.className = 'prosa-ctx-panel';
    panel.setAttribute('role', 'menu');
    panel.setAttribute('aria-label', s.paragraph);

    if (hasSel) {
      const inline = row();
      inline.append(
        btn(s.bold, 'Ctrl+B', 'B', () => this.run((ctx) => ctx.get(commandsCtx).call(toggleStrongCommand.key))),
        btn(s.italic, 'Ctrl+I', 'I', () => this.run((ctx) => ctx.get(commandsCtx).call(toggleEmphasisCommand.key))),
        btn(
          s.strikethrough,
          '',
          'S',
          () => this.run((ctx) => ctx.get(commandsCtx).call(toggleStrikethroughCommand.key)),
        ),
        btn(
          s.inlineCode,
          'Ctrl+E',
          ICONS.code,
          () => this.run((ctx) => ctx.get(commandsCtx).call(toggleInlineCodeCommand.key)),
        ),
        btn(s.link, '', ICONS.link, () => this.run((ctx) => ctx.get(commandsCtx).call(toggleLinkCommand.key))),
      );
      panel.append(inline, sep());
    }

    const blocks = row();
    blocks.append(
      btn(
        s.quote,
        'Ctrl+Shift+B',
        ICONS.quote,
        () => this.applyBlock('quote'),
      ),
      btn(s.bulletList, 'Ctrl+Alt+8', ICONS.ul, () => this.applyBlock('ul')),
      btn(s.orderedList, 'Ctrl+Alt+7', ICONS.ol, () => this.applyBlock('ol')),
    );
    panel.append(blocks, sep(), this.submenuRow(s));
    panel.addEventListener('click', this.onPanelClick);
    panel.addEventListener('pointerleave', this.scheduleSubmenuClose);
    panel.addEventListener('pointerenter', this.cancelSubmenuClose);

    document.body.append(panel);
    this.panel = panel;
    const r = panel.getBoundingClientRect();
    panel.style.left = `${Math.min(Math.max(8, e.clientX), innerWidth - r.width - 8)}px`;
    panel.style.top = `${Math.min(Math.max(8, e.clientY + 6), innerHeight - r.height - 8)}px`;
  };

  /** The «Параграф ▸» row: opens the block-type submenu on hover.
   * MVP note: the menu is mouse/Esc-driven only (no focus trap or arrow
   * navigation) — keyboard users have the hotkeys and the slash menu. */
  private submenuRow(s: ReturnType<typeof editorStrings>): HTMLElement {
    const item = document.createElement('div');
    item.className = 'ctx-item';
    item.setAttribute('role', 'menuitem');
    item.setAttribute('aria-haspopup', 'menu');
    item.innerHTML = `<span>${s.paragraph}</span><span class="ctx-arrow">▸</span>`;
    suppress(item);

    item.addEventListener('pointerenter', () => {
      this.cancelSubmenuClose();
      this.submenu?.remove();
      const sub = document.createElement('div');
      sub.className = 'prosa-ctx-panel prosa-ctx-sub';
      sub.setAttribute('role', 'menu');
      sub.addEventListener('pointerenter', this.cancelSubmenuClose);
      sub.addEventListener('pointerleave', this.scheduleSubmenuClose);
      sub.addEventListener('click', this.onPanelClick);

      const labels: [BlockId, string][] = [
        ['text', s.text],
        ['h1', s.h1],
        ['h2', s.h2],
        ['h3', s.h3],
        ['h4', s.h4],
        ['h5', s.h5],
        ['h6', s.h6],
        ['quote', s.quote],
        ['ul', s.bulletList],
        ['ol', s.orderedList],
        ['code', s.codeBlock],
      ];
      for (const [id, label] of labels) {
        const it = document.createElement('div');
        it.className = 'ctx-item';
        it.setAttribute('role', 'menuitem');
        it.innerHTML = `<span>${label}</span><span class="ctx-kbd">${BLOCK_HOTKEYS[id]}</span>`;
        suppress(it);
        it.addEventListener('click', () => {
          this.applyBlock(id);
          this.close();
        });
        sub.append(it);
      }
      document.body.append(sub);
      this.submenu = sub;
      const ir = item.getBoundingClientRect();
      const sr = sub.getBoundingClientRect();
      sub.style.left = `${Math.min(ir.right + 4, innerWidth - sr.width - 8)}px`;
      sub.style.top = `${Math.min(Math.max(8, ir.top - 4), innerHeight - sr.height - 8)}px`;
    });
    return item;
  }

  /** Stock milkdown commands — same ones Crepe's slash menu runs, so the
   * semantics (incl. wrap-in for lists/quote, set-type for text and
   * headings) match the "/" menu exactly and everything is undoable. */
  private applyBlock(id: BlockId): void {
    this.run((ctx) => {
      const commands = ctx.get(commandsCtx);
      if (id === 'text') {
        commands.call(setBlockTypeCommand.key, { nodeType: paragraphSchema.type(ctx) });
      } else if (id === 'quote') {
        commands.call(wrapInBlockTypeCommand.key, { nodeType: blockquoteSchema.type(ctx) });
      } else if (id === 'ul') {
        commands.call(wrapInBlockTypeCommand.key, { nodeType: bulletListSchema.type(ctx) });
      } else if (id === 'ol') {
        commands.call(wrapInBlockTypeCommand.key, { nodeType: orderedListSchema.type(ctx) });
      } else if (id === 'code') {
        commands.call(setBlockTypeCommand.key, { nodeType: codeBlockSchema.type(ctx) });
      } else {
        const level = Number(id.slice(1));
        commands.call(setBlockTypeCommand.key, {
          nodeType: headingSchema.type(ctx),
          attrs: { level },
        });
      }
    });
  }

  private run(fn: (ctx: Ctx) => void): void {
    this.crepe?.editor.action((ctx) => fn(ctx));
  }
}

// ---------- small DOM helpers ----------

function row(): HTMLElement {
  const r = document.createElement('div');
  r.className = 'ctx-row';
  return r;
}

function sep(): HTMLElement {
  const s = document.createElement('div');
  s.className = 'ctx-sep';
  return s;
}

/** Keep editor focus/selection alive through the press (Crepe toolbar
 * pattern): suppressed pointerdown never focuses the button. */
function suppress(el: HTMLElement): void {
  el.addEventListener('pointerdown', (e) => e.preventDefault());
}

function btn(label: string, hotkey: string, content: string, fn: () => void): HTMLElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ctx-btn';
  const title = hotkey ? `${label} (${hotkey})` : label;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.innerHTML = content;
  suppress(b);
  b.addEventListener('click', fn);
  return b;
}
