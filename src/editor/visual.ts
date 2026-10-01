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
    this.crepe = new Crepe({
      root,
      defaultValue,
      // the app-level empty-state hint replaces Crepe's block placeholder
      features: { placeholder: false },
    });
    await this.crepe.create();
    // ProseMirror applies its own DOM mutations and does not reliably emit
    // native `input` events, so observe the DOM for user edits instead.
    new MutationObserver(() => onChange()).observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
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
