// CodeMirror side of the app-level find & replace (#32). The bar in
// search.ts owns the query text and the active-match index; this module
// mirrors them into the source editor: a StateField holds the matches
// (recomputed on every query change and every document change), a
// ViewPlugin paints them as mark decorations.
//
// basicSetup already ships @codemirror/search with its own Mod-f panel —
// the app-level bar replaces it for the whole window, and the Ctrl+F
// capture handler in search.ts runs before CodeMirror's keymap, so the
// stock panel never opens. This extension is intentionally separate from
// it: no search state is shared, the panel is simply never triggered.
import { StateEffect, StateField, type Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { findRanges, type TextRange } from './search-core';

export interface SearchQueryState {
  query: string;
  caseSensitive: boolean;
  /** index of the highlighted "current" match, -1 when none */
  active: number;
}

interface SearchState extends SearchQueryState {
  matches: TextRange[];
}

export const setSearchQuery = StateEffect.define<SearchQueryState>();

const searchField = StateField.define<SearchState>({
  create: (): SearchState => ({ query: '', caseSensitive: false, active: -1, matches: [] }),
  update: (prev, tr): SearchState => {
    const eff = tr.effects.find((e) => e.is(setSearchQuery));
    if (!eff && !tr.docChanged) return prev;
    const next = eff ? { ...prev, ...eff.value } : prev;
    // no query, no scan — doc.toString() on every keystroke of an editor
    // whose search bar has never been opened would be pure waste
    if (!next.query) return { ...next, matches: [] };
    // recomputed unconditionally: query switches and document edits are
    // both rare compared to caret movement, and a stale count in the bar
    // would be worse than a redundant scan
    return { ...next, matches: findRanges(tr.state.doc.toString(), next.query, next.caseSensitive) };
  },
});

const hitMark = Decoration.mark({ class: 'cm-prosa-search-hit' });
const activeMark = Decoration.mark({ class: 'cm-prosa-search-hit-active' });

function buildDecorations(view: EditorView): DecorationSet {
  const s = view.state.field(searchField);
  if (!s.query) return Decoration.none;
  const parts: Range<Decoration>[] = [];
  for (let i = 0; i < s.matches.length; i++) {
    const m = s.matches[i];
    parts.push((i === s.active ? activeMark : hitMark).range(m.from, m.to));
  }
  return Decoration.set(parts, true);
}

const searchDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.transactions.some((tr) => tr.effects.some((e) => e.is(setSearchQuery)))
      ) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/** Add to the SourceEditor extensions; carries the match state + highlights. */
export const cmSearchExtension = [searchField, searchDecorations];

// ---------- bar-facing API (called by search.ts only) ----------

/** Push a new query / active index; returns the fresh match count. */
export function cmApplySearch(
  view: EditorView,
  query: string,
  caseSensitive: boolean,
  active: number,
): number {
  view.dispatch({ effects: setSearchQuery.of({ query, caseSensitive, active }) });
  return view.state.field(searchField).matches.length;
}

/** Current match count for the active query. */
export function cmMatchCount(view: EditorView): number {
  return view.state.field(searchField).matches.length;
}

/** Highlight + select + scroll to match `index`. */
export function cmGoToMatch(view: EditorView, index: number): void {
  const s = view.state.field(searchField);
  const m = s.matches[index];
  if (!m) return;
  view.dispatch({
    selection: { anchor: m.from, head: m.to },
    effects: [setSearchQuery.of({ query: s.query, caseSensitive: s.caseSensitive, active: index })],
    scrollIntoView: true,
  });
}

/** Replace the match at `index`; one undo step. */
export function cmReplaceMatch(view: EditorView, index: number, replacement: string): boolean {
  const s = view.state.field(searchField);
  const m = s.matches[index];
  if (!m) return false;
  view.dispatch({
    changes: { from: m.from, to: m.to, insert: replacement },
    selection: { anchor: m.from + replacement.length },
  });
  return true;
}

/** Replace every match in one transaction (one undo step, byte-exact
 * outside the replaced ranges — the untouched text is never reprocessed). */
export function cmReplaceAllMatches(view: EditorView, replacement: string): number {
  const s = view.state.field(searchField);
  if (s.matches.length === 0) return 0;
  view.dispatch({
    changes: s.matches.map((m) => ({ from: m.from, to: m.to, insert: replacement })),
    selection: { anchor: Math.min(s.matches[0].from + replacement.length, view.state.doc.length) },
  });
  return s.matches.length;
}
