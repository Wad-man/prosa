// Shared literal-string matcher for the app-level find & replace (#32).
// Both mode integrations (the CodeMirror source view and the ProseMirror
// visual view) must agree on what a "match" is, or the count in the bar
// and the decorations in the document drift apart.
//
// Matching is literal (never a regexp — the query comes straight from the
// input), case-insensitive by default. A precompiled RegExp with the `i`
// flag is used instead of toLowerCase()+indexOf because case folding can
// change string length for some code points (Turkish İ → "i̇"), which
// would silently skew match offsets.

export interface TextRange {
  from: number;
  to: number;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** All non-overlapping literal matches of `query` in `text`, in order. */
export function findRanges(text: string, query: string, caseSensitive: boolean): TextRange[] {
  if (!query) return [];
  const re = new RegExp(escapeRegExp(query), caseSensitive ? 'g' : 'gi');
  const out: TextRange[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ from: m.index, to: m.index + m[0].length });
  }
  return out;
}
