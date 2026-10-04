import type { Crepe } from '@milkdown/crepe';
import type { Ctx } from '@milkdown/kit/ctx';
import { commandsCtx } from '@milkdown/kit/core';
import { toggleLinkCommand } from '@milkdown/kit/component/link-tooltip';
import {
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleStrongCommand,
} from '@milkdown/kit/preset/commonmark';
import { toggleStrikethroughCommand } from '@milkdown/kit/preset/gfm';

import { editorStrings } from './crepe-locale';
import { applyVisualBlock, blockHotkey, type BlockId } from './actions';
import { getLang, t } from '../i18n';

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
  copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  cut: '<svg viewBox="0 0 24 24"><circle cx="6" cy="6" r="3"/><path d="M8.12 8.12 12 12"/><path d="M20 4 8.12 15.88"/><circle cx="6" cy="18" r="3"/><path d="M14.8 14.8 20 20"/></svg>',
  paste: '<svg viewBox="0 0 24 24"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/></svg>',
  link: '<svg viewBox="0 0 24 24"><path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5"/></svg>',
  code: '<svg viewBox="0 0 24 24"><path d="m8 7-5 5 5 5"/><path d="m16 7 5 5-5 5"/></svg>',
  quote:
    '<svg viewBox="0 0 24 24"><path d="M9 7H5a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h2c0 2-1 3-3 3"/><path d="M19 7h-4a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h2c0 2-1 3-3 3"/></svg>',
  ul: '<svg viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1" fill="currentColor"/><circle cx="3.5" cy="12" r="1" fill="currentColor"/><circle cx="3.5" cy="18" r="1" fill="currentColor"/></svg>',
  ol: '<svg viewBox="0 0 24 24"><path d="M10 6h11M10 12h11M10 18h11"/><text x="2" y="8" font-size="7" fill="currentColor" stroke="none">1</text><text x="2" y="14.5" font-size="7" fill="currentColor" stroke="none">2</text><text x="2" y="20.5" font-size="7" fill="currentColor" stroke="none">3</text></svg>',
};

/** Clipboard actions for the panel's Копировать/Вырезать/Вставить row —
 * injected from main.ts so the panel stays decoupled from app state. */
export interface PanelClipboardActions {
  copy(): void;
  cut(): void;
  paste(): void;
}

export class ContextPanel {
  private crepe: Crepe | null = null;
  private root: HTMLElement | null = null;
  private panel: HTMLElement | null = null;
  private submenu: HTMLElement | null = null;
  private closeTimer: number | undefined;
  private clipboard: PanelClipboardActions | null = null;

  mount(crepe: Crepe, root: HTMLElement, clipboard?: PanelClipboardActions): void {
    this.crepe = crepe;
    this.root = root;
    this.clipboard = clipboard ?? null;
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
    this.clipboard = null;
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
    const node = e.target instanceof Node ? e.target : null;
    if (this.panel.contains(node) || this.submenu?.contains(node)) return;
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
    // (named `target` — `t` is the i18n translator here)
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    if (!this.root?.contains(target) && !target.closest('.milkdown-block-handle')) return;
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

    // clipboard row first — the native menu this panel replaces had
    // Copy/Cut/Paste, and without it right-click copying was impossible
    if (this.clipboard) {
      const cb = this.clipboard;
      const clip = row();
      if (hasSel) {
        clip.append(
          btn(t('copy'), 'Ctrl+C', ICONS.copy, () => cb.copy()),
          btn(t('cut'), 'Ctrl+X', ICONS.cut, () => cb.cut()),
        );
      }
      clip.append(btn(t('paste'), 'Ctrl+V', ICONS.paste, () => cb.paste()));
      panel.append(clip, sep());
    }

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
        it.innerHTML = `<span>${label}</span><span class="ctx-kbd">${blockHotkey(id)}</span>`;
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

  /** Block commands live in ./actions — shared with the menu bar (#20). */
  private applyBlock(id: BlockId): void {
    if (this.crepe) applyVisualBlock(this.crepe, id);
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
