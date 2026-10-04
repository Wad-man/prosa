import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Prec } from '@codemirror/state';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { keymap } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';

/**
 * Syntax colors go through the CSS variables of styles.css, so both themes
 * (and theme switching) restyle tokens without rebuilding this style.
 * basicSetup registers defaultHighlightStyle as a fallback — a non-fallback
 * syntaxHighlighting() fully replaces it.
 */
const highlightStyle = HighlightStyle.define([
  /* Markdown */
  // t.heading also covers heading1–heading6 AND @lezer/markdown's TableHeader
  // (tagged as t.heading), so table header rows render accent+bold like
  // headings — an accepted stylistic overlap, not a separate rule
  { tag: t.heading, color: 'var(--accent)', fontWeight: '700' },
  { tag: [t.link, t.url], color: 'var(--accent)' },
  { tag: t.quote, color: 'var(--fg-3)', fontStyle: 'italic' },
  { tag: t.monospace, color: 'var(--code-fg)' }, // inline `code`
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.processingInstruction, color: 'var(--fg-2)' }, // markup markers: # ** - ``` …
  { tag: t.contentSeparator, color: 'var(--syn-num)' }, // --- horizontal rule
  /* Embedded languages (fenced code blocks) */
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.definitionKeyword], color: 'var(--syn-key)' },
  { tag: [t.string, t.special(t.string), t.character], color: 'var(--syn-str)' },
  { tag: [t.number, t.bool, t.atom], color: 'var(--syn-num)' }, // integer/float inherit t.number
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--syn-com)', fontStyle: 'italic' },
  { tag: t.variableName, color: 'var(--fg)' },
  { tag: t.propertyName, color: 'var(--fg-2)' },
  { tag: [t.typeName, t.className], color: 'var(--syn-num)' },
]);

/** Source mode: CodeMirror 6 with markdown language + code-block highlighting. */
export class SourceEditor {
  readonly view: EditorView;

  constructor(parent: HTMLElement, doc: string, onDocChanged: () => void) {
    this.view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        extensions: [
          // Ctrl+/ switches modes at the app level (window keydown in
          // main.ts), but basicSetup's default keymap binds the same Mod-/ to
          // toggleComment — and lang-markdown's block comment tokens are
          // `<!-- -->`, so every switch from source mode silently wrapped the
          // cursor line in HTML comments. Same class of collision for Ctrl+I:
          // defaultKeymap runs selectParentSyntax first, which expands the
          // selection before the app's italic alias (sourceHotkey) reads it.
          // CM's keymap fires before the window listener (bubbling), so
          // swallow both here with the highest precedence; returning true
          // marks the key handled for CodeMirror while the app-level
          // handlers still run.
          Prec.high(
            keymap.of([
              { key: 'Mod-/', run: () => true },
              { key: 'Mod-i', run: () => true },
            ]),
          ),
          basicSetup,
          syntaxHighlighting(highlightStyle),
          EditorView.lineWrapping,
          markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: true }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onDocChanged();
          }),
        ],
      }),
    });
  }

  setContent(md: string): void {
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: md },
    });
  }

  getContent(): string {
    return this.view.state.doc.toString();
  }

  focus(): void {
    this.view.focus();
  }
}
