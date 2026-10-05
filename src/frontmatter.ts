/**
 * YAML front-matter split for the lossless round-trip (#33).
 *
 * The visual editor cannot round-trip a front-matter block: remark parses
 * the opening `---` into a thematic break and the fields into headings, so
 * saving from the visual mode would mangle Jekyll/Hugo/Zettelkasten docs.
 * The block is therefore carved out before the markdown body reaches the
 * editors and re-attached byte-for-byte on save; the source mode still
 * shows it (it is part of the raw text there, see main.ts setMode).
 *
 * Only a closed block at byte 0 counts (opening `---` line, closing `---`
 * or `...` line on its own) — the same convention gray-matter and the
 * static-site generators use.
 */
export interface FrontMatterSplit {
  /** raw block incl. both fences and the trailing newline; null when absent */
  frontMatter: string | null;
  body: string;
}

export function splitFrontMatter(text: string): FrontMatterSplit {
  // the optional content group keeps an empty block (`---\n---`) valid
  const m = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?(---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { frontMatter: null, body: text };
  return { frontMatter: text.slice(0, m[0].length), body: text.slice(m[0].length) };
}
