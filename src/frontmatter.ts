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
 * Only a closed block of NON-BLANK lines at byte 0 counts (opening `---`
 * line, closing `---` or `...` line on its own). A blank line inside the
 * block disqualifies it: per CommonMark that text is then a thematic break
 * + paragraph + thematic break, and it renders as such (owner decision
 * 2026-10-10 — diverges from gray-matter, which tolerates blank lines in
 * YAML). Blank lines AFTER the closing fence are absorbed into the block,
 * so the gap between the front-matter and the body survives the visual
 * round-trip byte-for-byte (#40).
 */
export interface FrontMatterSplit {
  /** raw block incl. both fences (and trailing blank lines); null when absent */
  frontMatter: string | null;
  body: string;
}

export function splitFrontMatter(text: string): FrontMatterSplit {
  // a content line carries at least one non-whitespace character (a
  // whitespace-only line is blank per CommonMark and disqualifies the
  // block); the `*?` group keeps an empty block (`---\n---`) valid
  const m = /^---[ \t]*\r?\n(?:[^\r\n]*\S[^\r\n]*\r?\n)*?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { frontMatter: null, body: text };
  // the blank lines separating the block from the body belong to the block
  // (the body's mdast round-trip collapses a leading blank line, #40)
  const rest = text.slice(m[0].length);
  const gap = m[0].endsWith('\n') ? /^(?:[ \t]*\r?\n)+/.exec(rest)?.[0].length ?? 0 : 0;
  return { frontMatter: text.slice(0, m[0].length + gap), body: rest.slice(gap) };
}
