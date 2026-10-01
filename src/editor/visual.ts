import { Crepe } from '@milkdown/crepe';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame.css';
import { replaceAll } from '@milkdown/kit/utils';

/**
 * Visual mode: Milkdown (Crepe preset) — Typora-style live rendering.
 * The block under the cursor shows raw markdown, the rest is rendered.
 */
export class VisualEditor {
  private crepe: Crepe | null = null;
  private root: HTMLElement | null = null;

  async create(root: HTMLElement, defaultValue: string, onChange: () => void): Promise<void> {
    this.root = root;
    this.crepe = new Crepe({ root, defaultValue });
    await this.crepe.create();
    // contenteditable emits DOM `input` on user edits; programmatic
    // transactions from ProseMirror don't emit it, which is what we want here.
    root.addEventListener('input', onChange);
  }

  getMarkdown(): string {
    return this.crepe?.getMarkdown() ?? '';
  }

  setMarkdown(md: string): void {
    if (!this.crepe) return;
    this.crepe.editor.action(replaceAll(md, true));
  }

  focus(): void {
    const el = this.root?.querySelector('.ProseMirror');
    if (el instanceof HTMLElement) el.focus();
  }
}
