import { t } from './i18n';
import { listRecent, type RecentEntry } from './recent';

/**
 * Start screen (#96): the empty state grows up from a passive hint into
 * the first frame of work — create a file, open one, or jump back into a
 * recent document. It IS the old #empty-hint surface (no extra frame on
 * the critical start path, #34): the actions and the recent list are
 * appended under the existing hint, shown under exactly the same
 * conditions (an empty document in the visual/reading modes).
 *
 * The container stays pointer-events:none (clicks must reach the editor
 * behind it); only the interactive rows re-enable them.
 */

export interface StartScreenActions {
  onNew(): void;
  onOpen(): void;
  onOpenRecent(path: string): void;
}

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function dirOf(path: string): string | null {
  const i = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return i > 0 ? path.slice(0, i) : null;
}

export class StartScreen {
  private actions: StartScreenActions | null = null;
  private recentBlock: HTMLElement | null = null;
  private recentList: HTMLElement | null = null;
  private recentCap: HTMLElement | null = null;

  mount(host: HTMLElement, actions: StartScreenActions): void {
    this.actions = actions;
    const inner = host.querySelector('.eh-inner');
    if (!inner) return;

    const wrap = document.createElement('div');
    wrap.className = 'ss';

    const actionsRow = document.createElement('div');
    actionsRow.className = 'ss-actions';

    const newBtn = document.createElement('button');
    newBtn.id = 'ss-new';
    newBtn.type = 'button';
    newBtn.className = 'ss-btn';
    newBtn.addEventListener('click', () => this.actions?.onNew());

    const openBtn = document.createElement('button');
    openBtn.id = 'ss-open';
    openBtn.type = 'button';
    openBtn.className = 'ss-btn';
    openBtn.addEventListener('click', () => this.actions?.onOpen());

    actionsRow.append(newBtn, openBtn);

    this.recentBlock = document.createElement('div');
    this.recentBlock.className = 'ss-recent';
    this.recentBlock.hidden = true;

    this.recentCap = document.createElement('div');
    this.recentCap.className = 'ss-recent-cap';

    this.recentList = document.createElement('div');
    this.recentList.className = 'ss-recent-list';

    this.recentBlock.append(this.recentCap, this.recentList);
    wrap.append(actionsRow, this.recentBlock);
    inner.append(wrap);

    // cross-window freshness: another document window's save/open rewrites
    // the shared storage — the storage event lands here (review MINOR)
    window.addEventListener('storage', (e) => {
      if (e.key === 'prosa.recent') this.refreshRecent();
    });

    this.relabel();
    this.refreshRecent();
  }

  relabel(): void {
    const newBtn = document.getElementById('ss-new');
    const openBtn = document.getElementById('ss-open');
    if (newBtn) newBtn.textContent = t('ssNewFile');
    if (openBtn) openBtn.textContent = t('ssOpenFile');
    if (this.recentCap) this.recentCap.textContent = t('ssRecent');
    this.refreshRecent();
  }

  /** Rebuild the recent list from storage (call after every add/remove). */
  refreshRecent(): void {
    const list = this.recentList;
    if (!list) return;
    const entries: RecentEntry[] = listRecent().slice(0, 8);
    if (this.recentBlock) this.recentBlock.hidden = entries.length === 0;
    list.replaceChildren();
    for (const entry of entries) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'ss-recent-item';
      item.title = entry.path;
      const name = document.createElement('span');
      name.className = 'ss-recent-name';
      name.textContent = fileNameOf(entry.path);
      const dir = dirOf(entry.path);
      item.append(name);
      if (dir) {
        const dirEl = document.createElement('span');
        dirEl.className = 'ss-recent-dir';
        dirEl.textContent = dir;
        item.append(dirEl);
      }
      item.addEventListener('click', () => this.actions?.onOpenRecent(entry.path));
      list.append(item);
    }
  }
}
