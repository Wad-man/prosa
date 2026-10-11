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
 * block demotes it to an "unparsed prefix" (#83, owner decision 2026-10-11
 * variant (а)): it is neither front-matter (per CommonMark that text is a
 * thematic break + paragraph, and the owner rule of 2026-10-10 stands) nor
 * editor content — it is held byte-for-byte and re-attached on save, so a
 * Jekyll/Hugo YAML block with blank lines survives the visual round-trip
 * instead of being rewritten into headings. Blank lines AFTER the closing
 * fence are absorbed into the block, so the gap between the front-matter
 * and the body survives the visual round-trip byte-for-byte (#40).
 */
export interface FrontMatterSplit {
  /** raw block incl. both fences (and trailing blank lines); null when absent */
  frontMatter: string | null;
  /**
   * #83(а): a closed `--- … ---/…` block at byte 0 that contains blank
   * lines — not front-matter by the rule above, but the editors must not
   * chew it into headings either (Jekyll/Hugo YAML). It is kept out of the
   * document, never shown (not even as the #fm-view service record) and
   * re-attached byte-for-byte on save. Mutually exclusive with
   * `frontMatter`; null when absent.
   */
  unparsedPrefix: string | null;
  body: string;
}

export function splitFrontMatter(text: string): FrontMatterSplit {
  // Linear one-pass scan (#75): the previous single regex closed the block
  // with a lazy `(?:[^\r\n]*\S[^\r\n]*\r?\n)*?` group whose leading
  // `[^\r\n]*` is ambiguous against the `\S` inside each line — without a
  // closing fence the engine backtracked through the ways to split every
  // line (~x17 per line), and `---` + 7 non-blank lines froze the page for
  // ~13 s. The scan walks the text line by line exactly once and yields
  // the identical classification: a fence line is `---` or `...` plus
  // spaces/tabs only; every line before it must be non-blank (owner
  // decision 2026-10-10) and newline-terminated, like the regex demanded.
  // A blank line before the closing fence no longer disqualifies the whole
  // text (#83): the scan keeps going, and a block that still closes is
  // returned as an unparsedPrefix instead of front-matter.
  if (!text.startsWith('---')) return { frontMatter: null, unparsedPrefix: null, body: text };
  let pos = 3;
  while (pos < text.length && (text[pos] === ' ' || text[pos] === '\t')) pos += 1;
  // the opening fence must be line-terminated (`\r\n` or `\n`)
  if (text.startsWith('\r\n', pos)) pos += 2;
  else if (text[pos] === '\n') pos += 1;
  else return { frontMatter: null, unparsedPrefix: null, body: text };

  const len = text.length;
  let sawBlank = false;
  for (;;) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? len : nl;
    let line = text.slice(pos, lineEnd);
    // the \r of a CRLF terminator belongs to the terminator, not to the
    // line (a bare \r at EOF is line content and fails the fence check,
    // exactly as the regex's `[ \t]*` rejected it)
    if (nl !== -1 && line.endsWith('\r')) line = line.slice(0, -1);
    if (/^(?:---|\.\.\.)[ \t]*$/.test(line)) {
      const end = nl === -1 ? len : nl + 1;
      // the blank lines separating the block from the body belong to the
      // block (the body's mdast round-trip collapses a leading blank
      // line, #40); a fence at EOF (the regex's `$` alternative) has no
      // newline and nothing to separate
      const rest = text.slice(end);
      const gap = nl !== -1 ? /^(?:[ \t]*\r?\n)+/.exec(rest)?.[0].length ?? 0 : 0;
      const raw = text.slice(0, end + gap);
      return sawBlank
        ? { frontMatter: null, unparsedPrefix: raw, body: rest.slice(gap) }
        : { frontMatter: raw, unparsedPrefix: null, body: rest.slice(gap) };
    }
    // a content line is non-blank and newline-terminated — text that
    // simply runs out is no front-matter of any kind; a blank line only
    // demotes a still-closing block to the unparsed prefix (#83)
    if (nl === -1) return { frontMatter: null, unparsedPrefix: null, body: text };
    if (!/\S/.test(line)) sawBlank = true;
    pos = nl + 1;
  }
}
