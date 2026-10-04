import type { Crepe } from '@milkdown/crepe';
import { commandsCtx, editorViewCtx, parserCtx } from '@milkdown/kit/core';
import { Slice } from '@milkdown/kit/prose/model';
import { selectAll, deleteSelection } from '@milkdown/kit/prose/commands';
import { undoCommand, redoCommand } from '@milkdown/kit/plugin/history';
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

/**
 * Programmatic formatting for the visual editor — the same stock milkdown
 * commands Crepe's own UI (slash menu, toolbar) runs, so semantics match and
 * everything lands on the undo stack. Shared by the right-click context
 * panel and the menu bar (#20): one command layer, two entry points.
 */

export type BlockId = 'text' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'quote' | 'ul' | 'ol' | 'code';

export type MarkId = 'bold' | 'italic' | 'strike' | 'code' | 'link';

/** Hotkey captions shown next to block entries — the bindings that exist in
 * the product (Windows-only today, so plain Ctrl-spelling is fine). */
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

export function blockHotkey(id: BlockId): string {
  return BLOCK_HOTKEYS[id];
}

export function applyVisualBlock(crepe: Crepe, id: BlockId): void {
  crepe.editor.action((ctx) => {
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

export function toggleVisualMark(crepe: Crepe, id: MarkId): void {
  crepe.editor.action((ctx) => {
    const commands = ctx.get(commandsCtx);
    if (id === 'bold') commands.call(toggleStrongCommand.key);
    else if (id === 'italic') commands.call(toggleEmphasisCommand.key);
    else if (id === 'strike') commands.call(toggleStrikethroughCommand.key);
    else if (id === 'code') commands.call(toggleInlineCodeCommand.key);
    else commands.call(toggleLinkCommand.key);
  });
}

export function visualUndoRedo(crepe: Crepe, which: 'undo' | 'redo'): void {
  crepe.editor.action((ctx) => {
    ctx.get(commandsCtx).call(which === 'undo' ? undoCommand.key : redoCommand.key);
  });
}

export function visualSelectAll(crepe: Crepe): void {
  crepe.editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    selectAll(view.state, view.dispatch);
    view.focus();
  });
}

/** Plain text of the current selection ('' when collapsed). */
export function visualSelectionText(crepe: Crepe): string {
  let text = '';
  crepe.editor.action((ctx) => {
    const { selection, doc } = ctx.get(editorViewCtx).state;
    if (!selection.empty) text = doc.textBetween(selection.from, selection.to, '\n');
  });
  return text;
}

export function visualDeleteSelection(crepe: Crepe): void {
  crepe.editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    deleteSelection(view.state, view.dispatch);
    view.focus();
  });
}

/** Markdown-aware paste: parse the text and splice it in at the selection.
 * maxOpen keeps the slice open at the boundaries (PM's own clipboard path),
 * so pasting plain text at a caret mid-paragraph splices inline instead of
 * splitting the paragraph into blocks. */
export function visualInsertMarkdown(crepe: Crepe, md: string): void {
  if (!md) return;
  crepe.editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    // parserCtx holds the parser itself: (markdown) => ProseMirror node
    const node = ctx.get(parserCtx)(md);
    if (!node) return;
    const tr = view.state.tr.replaceSelection(Slice.maxOpen(node.content));
    tr.scrollIntoView();
    view.dispatch(tr);
    view.focus();
  });
}

/** Block type at the cursor — drives the checkmarks of the Paragraph menu. */
export function visualCurrentBlock(crepe: Crepe): BlockId | null {
  let current: BlockId | null = null;
  crepe.editor.action((ctx) => {
    const { $from } = ctx.get(editorViewCtx).state.selection;
    for (let depth = $from.depth; depth > 0; depth--) {
      const node = $from.node(depth);
      const name = node.type.name;
      if (name === 'heading') {
        current = `h${node.attrs.level}` as BlockId;
        return;
      }
      if (name === 'code_block') {
        current = 'code';
        return;
      }
      if (name === 'blockquote') {
        current = 'quote';
        return;
      }
      if (name === 'bullet_list') {
        current = 'ul';
        return;
      }
      if (name === 'ordered_list') {
        current = 'ol';
        return;
      }
    }
    current = 'text';
  });
  return current;
}
