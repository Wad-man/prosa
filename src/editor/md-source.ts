import type { EditorView } from '@codemirror/view';
import { redo, selectAll, undo } from '@codemirror/commands';
import type { BlockId, MarkId } from './actions';

/**
 * Markdown block/mark transforms for the source mode (CodeMirror 6), so the
 * Paragraph/Format sections of the menu bar and the hotkey aliases behave
 * the same in both editors (#20). Line-prefix edits are deliberately simple:
 * every selected line is treated as one block/item line (multi-line list
 * items keep their continuation lines untouched when the whole item is not
 * selected — an accepted MVP trade-off).
 */

const MARK_TOKENS: Record<MarkId, [string, string]> = {
  bold: ['**', '**'],
  italic: ['*', '*'],
  strike: ['~~', '~~'],
  code: ['`', '`'],
  link: ['[', '](…)'],
};

export function sourceUndoRedo(view: EditorView, which: 'undo' | 'redo'): void {
  (which === 'undo' ? undo : redo)(view);
  view.focus();
}

export function sourceSelectAll(view: EditorView): void {
  selectAll(view);
  view.focus();
}

export function sourceSelectionText(view: EditorView): string {
  const { from, to } = view.state.selection.main;
  return from === to ? '' : view.state.sliceDoc(from, to);
}

export function sourceDeleteSelection(view: EditorView): void {
  const { from, to } = view.state.selection.main;
  if (from === to) return;
  view.dispatch({ changes: { from, to } });
  view.focus();
}

export function sourceInsertText(view: EditorView, text: string): void {
  if (!text) return;
  view.dispatch(view.state.replaceSelection(text), { scrollIntoView: true });
  view.focus();
}

/** Wrap/unwrap the selection with a mark; empty selection inserts an empty
 * pair with the caret inside (pressing it again right away removes that
 * empty pair — caret between the markers reads as "toggle off"). */
export function sourceToggleMark(view: EditorView, id: MarkId): void {
  const [open, close] = MARK_TOKENS[id];
  const { from, to } = view.state.selection.main;
  if (from === to) {
    const before = view.state.sliceDoc(Math.max(0, from - open.length), from);
    const after = view.state.sliceDoc(to, Math.min(view.state.doc.length, to + close.length));
    if (before === open && after === close) {
      view.dispatch({
        changes: [
          { from: from - open.length, to: from },
          { from: to, to: to + close.length },
        ],
      });
    } else {
      view.dispatch({
        changes: { from, insert: `${open}${close}` },
        selection: { anchor: from + open.length },
        scrollIntoView: true,
      });
    }
  } else {
    const text = view.state.sliceDoc(from, to);
    if (id === 'link') {
      // a real [text](url) selection unwraps to its text; anything else wraps
      const m = /^\[([\s\S]*)\]\([^)]*\)$/.exec(text);
      if (m) {
        view.dispatch({ changes: { from, to, insert: m[1] } });
      } else {
        view.dispatch({ changes: { from, to, insert: `[${text}](…)` } });
      }
    } else if (text.startsWith(open) && text.endsWith(close) && text.length >= open.length + close.length) {
      view.dispatch({
        changes: { from, to, insert: text.slice(open.length, text.length - close.length) },
      });
    } else {
      view.dispatch({
        changes: { from, to, insert: `${open}${text}${close}` },
      });
    }
  }
  view.focus();
}

// ---------- block (line-prefix) transforms ----------

interface LinePrefix {
  id: BlockId | null;
  marker: string;
}

function parsePrefix(line: string): LinePrefix {
  let m = /^(#{1,6})\s+/.exec(line);
  if (m) return { id: `h${m[1].length}` as BlockId, marker: m[0] };
  m = /^>\s?/.exec(line);
  if (m) return { id: 'quote', marker: m[0] };
  m = /^[-*+]\s+/.exec(line);
  if (m) return { id: 'ul', marker: m[0] };
  m = /^\d+[.)]\s+/.exec(line);
  if (m) return { id: 'ol', marker: m[0] };
  return { id: null, marker: '' };
}

function stripPrefix(line: string): string {
  return line.slice(parsePrefix(line).marker.length);
}

/** The range of complete lines covered by the selection. */
function lineRange(view: EditorView): { from: number; to: number } {
  const { from, to } = view.state.selection.main;
  const first = view.state.doc.lineAt(from);
  const last = view.state.doc.lineAt(to);
  return { from: first.from, to: last.to };
}

function mapSelectedLines(
  view: EditorView,
  fn: (line: string, index: number) => string,
): void {
  const { from, to } = lineRange(view);
  const firstLine = view.state.doc.lineAt(from);
  const lastLine = view.state.doc.lineAt(to);
  const changes: { from: number; to?: number; insert: string }[] = [];
  let index = 0;
  for (let n = firstLine.number; n <= lastLine.number; n++) {
    const line = view.state.doc.line(n);
    const next = fn(line.text, index++);
    if (next !== line.text) changes.push({ from: line.from, to: line.to, insert: next });
  }
  if (changes.length > 0) view.dispatch({ changes });
  view.focus();
}

/** Inside a fenced code block (``` or ~~~) at the selection head? The
 * closing fence must use the same character and be at least as long. */
function insideFence(view: EditorView): boolean {
  const cursorLine = view.state.doc.lineAt(view.state.selection.main.head).number;
  let fence = ''; // '' = outside, otherwise the opening marker (char + length)
  for (let n = 1; n <= cursorLine; n++) {
    const m = /^\s*(```+|~~~+)/.exec(view.state.doc.line(n).text);
    if (m) {
      if (!fence) fence = m[1];
      else if (m[1][0] === fence[0] && m[1].length >= fence.length) fence = '';
    }
  }
  return fence !== '';
}

export function sourceSetBlock(view: EditorView, id: BlockId): void {
  if (id === 'code') {
    toggleFence(view);
    return;
  }
  if (id === 'text') {
    mapSelectedLines(view, (line) => stripPrefix(line));
    return;
  }
  if (id === 'h1' || id === 'h2' || id === 'h3' || id === 'h4' || id === 'h5' || id === 'h6') {
    const level = Number(id.slice(1));
    const prefix = '#'.repeat(level) + ' ';
    // a heading entry sets the level (Typora semantics); re-applying the
    // same level keeps it — Ctrl+0 is the way back to plain text
    mapSelectedLines(view, (line) => prefix + stripPrefix(line));
    return;
  }
  // quote / ul / ol — toggle: applying the current type of ALL lines removes it
  const { from, to } = lineRange(view);
  const first = view.state.doc.lineAt(from);
  const last = view.state.doc.lineAt(to);
  let allMatch = true;
  for (let n = first.number; n <= last.number; n++) {
    if (parsePrefix(view.state.doc.line(n).text).id !== id) {
      allMatch = false;
      break;
    }
  }
  if (allMatch) {
    mapSelectedLines(view, (line) => stripPrefix(line));
    return;
  }
  if (id === 'quote') {
    mapSelectedLines(view, (line) => (line === '' ? '>' : '> ' + stripPrefix(line)));
  } else if (id === 'ul') {
    mapSelectedLines(view, (line) => '- ' + stripPrefix(line));
  } else {
    let n = 0;
    mapSelectedLines(view, (line) => `${++n}. ` + stripPrefix(line));
  }
}

function toggleFence(view: EditorView): void {
  const { from, to } = lineRange(view);
  const doc = view.state.doc;
  if (insideFence(view)) {
    // remove the fence pair around the selection: the nearest ``` lines
    // above `from` and below `to`
    let startLine = doc.lineAt(from).number;
    while (startLine > 1 && !/^\s*(```|~~~)/.test(doc.line(startLine).text)) startLine--;
    let endLine = doc.lineAt(to).number;
    while (endLine < doc.lines && !/^\s*(```|~~~)/.test(doc.line(endLine).text)) endLine++;
    if (/^\s*(```|~~~)/.test(doc.line(startLine).text) && /^\s*(```|~~~)/.test(doc.line(endLine).text)) {
      if (endLine === startLine + 1) {
        // empty fence body — both lines go in one change (no overlap)
        view.dispatch({ changes: [{ from: doc.line(startLine).from, to: doc.line(endLine).to }] });
      } else {
        view.dispatch({
          changes: [
            { from: doc.line(startLine).from, to: doc.line(startLine + 1).from },
            { from: doc.line(endLine - 1).to, to: doc.line(endLine).to },
          ],
        });
      }
    }
    view.focus();
    return;
  }
  const first = doc.lineAt(from);
  const last = doc.lineAt(to);
  view.dispatch({
    changes: [
      { from: first.from, insert: '```\n' },
      { from: last.to, insert: '\n```' },
    ],
    selection: { anchor: first.from },
    scrollIntoView: true,
  });
  view.focus();
}

/** Block type at the cursor — drives the checkmarks of the Paragraph menu. */
export function sourceCurrentBlock(view: EditorView): BlockId | null {
  if (insideFence(view)) return 'code';
  const line = view.state.doc.lineAt(view.state.selection.main.head).text;
  const { id } = parsePrefix(line);
  return id ?? 'text';
}

// ---------- TOC support ----------

export interface SourceHeading {
  level: number;
  text: string;
  line: number; // 1-based
}

/** ATX headings outside fenced code blocks (closing fence = same char,
 * at least as long as the opening one). */
export function sourceHeadings(text: string): SourceHeading[] {
  const out: SourceHeading[] = [];
  let fence = ''; // '' = outside, otherwise the opening marker
  for (const [i, raw] of text.split('\n').entries()) {
    const fenceMatch = /^\s*(```+|~~~+)/.exec(raw);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1];
      else if (fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = '';
      continue;
    }
    if (fence) continue;
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(raw);
    if (m) out.push({ level: m[1].length, text: m[2] || '#'.repeat(m[1].length), line: i + 1 });
  }
  return out;
}
