import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';

/** Source mode: CodeMirror 6 with markdown language + code-block highlighting. */
export class SourceEditor {
  readonly view: EditorView;

  constructor(parent: HTMLElement, doc: string, onDocChanged: () => void) {
    this.view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        extensions: [
          basicSetup,
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
