import type { Crepe } from '@milkdown/crepe';
import type { Ctx } from '@milkdown/kit/ctx';
import { commandsCtx, editorViewCtx, parserCtx, schemaCtx, serializerCtx } from '@milkdown/kit/core';
import { Slice, type NodeType } from '@milkdown/kit/prose/model';
import { Selection } from '@milkdown/kit/prose/state';
import { selectAll, deleteSelection, lift } from '@milkdown/kit/prose/commands';
import { undoCommand, redoCommand } from '@milkdown/kit/plugin/history';
import { toggleLinkCommand } from '@milkdown/kit/component/link-tooltip';
import {
  blockquoteSchema,
  bulletListSchema,
  codeBlockSchema,
  headingSchema,
  listItemSchema,
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

/** A caret parked at a doc boundary (typical right after a full document
 * replace) resolves at depth 0, where ancestor walks find nothing. Resolve
 * it to the nearest real text cursor first — every block-level helper below
 * must reason about a position INSIDE a block. */
function resolved$from(ctx: Ctx) {
  const selection = ctx.get(editorViewCtx).state.selection;
  return selection.$from.depth === 0 ? Selection.near(selection.$from).$from : selection.$from;
}

/** Depth of the nearest ancestor (incl. the selection's own block) whose
 * type name is in `names`; 0 when there is none. Drives the toggle logic:
 * "am I inside X at all" — not "is X the innermost container" (a quote
 * wrapping a list must still toggle the quote off, #28). */
function ancestorDepth(ctx: Ctx, names: string[]): number {
  const $from = resolved$from(ctx);
  for (let depth = $from.depth; depth > 0; depth--) {
    if (names.includes($from.node(depth).type.name)) return depth;
  }
  return 0;
}

/** Lift the selected block one structural level (out of a quote/list), the
 * prosemirror `lift` command — mirrors the source mode's "strip one marker
 * per press" semantics. */
function liftSelection(ctx: Ctx): void {
  const view = ctx.get(editorViewCtx);
  lift(view.state, view.dispatch);
  view.focus();
}

/** Convert the nearest enclosing list to `listType` in place (ul ↔ ol). */
function setListType(ctx: Ctx, listType: NodeType): void {
  const view = ctx.get(editorViewCtx);
  const depth = ancestorDepth(ctx, ['bullet_list', 'ordered_list']);
  if (depth === 0) return;
  view.dispatch(view.state.tr.setNodeMarkup(resolved$from(ctx).before(depth), listType));
  view.focus();
}

export function applyVisualBlock(crepe: Crepe, id: BlockId): void {
  crepe.editor.action((ctx) => {
    const commands = ctx.get(commandsCtx);
    if (id === 'text') {
      // Ctrl+0: a block inside a quote/list steps out one level first (the
      // source mode strips one marker per press); headings become plain
      // paragraphs; inside a code block it is a no-op, like the source mode
      if (ancestorDepth(ctx, ['blockquote', 'bullet_list', 'ordered_list']) > 0) {
        liftSelection(ctx);
      } else if (visualCurrentBlock(crepe) !== 'code') {
        commands.call(setBlockTypeCommand.key, { nodeType: paragraphSchema.type(ctx) });
      }
    } else if (id === 'quote') {
      if (ancestorDepth(ctx, ['blockquote']) > 0) liftSelection(ctx);
      else commands.call(wrapInBlockTypeCommand.key, { nodeType: blockquoteSchema.type(ctx) });
    } else if (id === 'ul' || id === 'ol') {
      const listType = (id === 'ul' ? bulletListSchema : orderedListSchema).type(ctx);
      const other = id === 'ul' ? 'ol' : 'ul';
      if (visualCurrentBlock(crepe) === id) {
        liftSelection(ctx); // same type again → unwrap
      } else if (visualCurrentBlock(crepe) === other) {
        setListType(ctx, listType); // ul ↔ ol converts in place
      } else {
        commands.call(wrapInBlockTypeCommand.key, { nodeType: listType });
      }
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

/** Markdown of the current selection ('' when collapsed) — the exact
 * serialization the clipboard plugin uses for native Ctrl+C (#47), so the
 * menu/right-click "Copy" carries markdown formatting, like Obsidian. */
export function visualSelectionMarkdown(crepe: Crepe): string {
  let md = '';
  crepe.editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const { from, to } = view.state.selection;
    if (from === to) return;
    const slice = view.state.selection.content();
    const doc = ctx.get(schemaCtx).topNodeType.createAndFill(undefined, slice.content);
    if (!doc) return;
    md = ctx.get(serializerCtx)(doc);
  });
  return md;
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

/** Ctrl+D: delete the selection, or the whole top-level block at the caret
 * (Obsidian's line-delete). Deleting the document's last block would
 * violate the schema, so it degrades to clearing the block. */
export function visualDeleteBlock(crepe: Crepe): void {
  crepe.editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const { selection, tr } = view.state;
    if (!selection.empty) {
      view.dispatch(tr.deleteSelection().scrollIntoView());
    } else {
      const $from = resolved$from(ctx);
      const from = $from.before(1);
      const to = $from.after(1);
      const paragraph = paragraphSchema.type(ctx).create();
      view.dispatch(tr.replaceWith(from, to, paragraph).scrollIntoView());
    }
    view.focus();
  });
}

/** Ctrl+L: toggle the task checkbox of the current list item; a non-list
 * block turns into an unchecked task item (Obsidian semantics). The gfm
 * preset models tasks as a `checked` attr on the regular list_item. */
export function visualToggleTask(crepe: Crepe): void {
  crepe.editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const { tr } = view.state;
    const $from = resolved$from(ctx);
    for (let depth = $from.depth; depth > 0; depth--) {
      if ($from.node(depth).type.name !== 'list_item') continue;
      const node = $from.node(depth);
      const checked = node.attrs.checked == null ? true : !node.attrs.checked;
      view.dispatch(tr.setNodeMarkup($from.before(depth), undefined, { checked }));
      view.focus();
      return;
    }
    // not in a list yet — wrap into an unchecked task item
    const range = $from.blockRange();
    if (!range) return;
    const bulletList = bulletListSchema.type(ctx);
    const listItem = listItemSchema.type(ctx);
    view.dispatch(
      tr.wrap(range, [
        { type: bulletList },
        { type: listItem, attrs: { checked: false } },
      ]),
    );
    view.focus();
  });
}

/** Ctrl+Shift+N: strip the inline marks (bold/italic/strike/code/links) off
 * the selection — Telegram/Word "Normal" semantics. With a bare caret the
 * whole current top-level block is cleaned. */
export function visualClearFormatting(crepe: Crepe): void {
  crepe.editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const { selection, tr } = view.state;
    let from: number;
    let to: number;
    if (selection.empty) {
      const $from = resolved$from(ctx);
      from = $from.before(1);
      to = $from.after(1);
    } else {
      from = selection.from;
      to = selection.to;
    }
    view.dispatch(tr.removeMark(from, to));
    view.focus();
  });
}

/** Block type at the cursor — drives the checkmarks of the Paragraph menu. */
export function visualCurrentBlock(crepe: Crepe): BlockId | null {
  let current: BlockId | null = null;
  crepe.editor.action((ctx) => {
    const $from = resolved$from(ctx);
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
