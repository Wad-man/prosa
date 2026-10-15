import { getLang, t } from './i18n';
import { listRecent, removeRecent, type RecentEntry } from './recent';

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

/** The folder, shortened to its last two segments (concept A: the full
 *  path lives in the row's tooltip). */
function shortDirOf(path: string): string | null {
  const parts = path.split(/[\\/]/);
  parts.pop();
  const sep = path.includes('\\') ? '\\' : '/';
  const tail = parts.filter(Boolean).slice(-2);
  return tail.length ? tail.join(sep) : null;
}

/** «сегодня, 10:42» / «вчера» / «3 окт.» — the concept's quiet date column. */
function whenOf(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const lang = getLang() === 'ru' ? 'ru-RU' : 'en-US';
  const d = new Date(ts);
  const now = new Date();
  const day = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff === 0) {
    const hm = d.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
    return `${t('ssToday')}, ${hm}`;
  }
  if (diff === 1) return t('ssYesterday');
  return d.toLocaleDateString(lang, {
    day: 'numeric',
    month: 'short',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

export class StartScreen {
  private actions: StartScreenActions | null = null;
  private recentBlock: HTMLElement | null = null;
  private recentList: HTMLElement | null = null;
  private recentCap: HTMLElement | null = null;
  private dropNote: HTMLElement | null = null;

  mount(host: HTMLElement, actions: StartScreenActions): void {
    this.actions = actions;
    const inner = host.querySelector('.eh-inner');
    if (!inner) return;

    // concept A: hairline, then the actions as links with their keys, then
    // the recent files; the shortcut row (.eh-keys) stays last
    const wrap = document.createElement('div');
    wrap.className = 'ss';

    const rule = document.createElement('div');
    rule.className = 'ss-rule';

    const actionsRow = document.createElement('div');
    actionsRow.className = 'ss-actions';

    const link = (id: string, kbd: string, onClick: () => void): HTMLElement => {
      const cell = document.createElement('span');
      cell.className = 'ss-act';
      const btn = document.createElement('button');
      btn.id = id;
      btn.type = 'button';
      btn.className = 'ss-link';
      btn.addEventListener('click', onClick);
      const k = document.createElement('kbd');
      k.textContent = kbd;
      cell.append(btn, k);
      return cell;
    };

    this.dropNote = document.createElement('span');
    this.dropNote.className = 'ss-drop';

    actionsRow.append(
      link('ss-new', 'Ctrl+N', () => this.actions?.onNew()),
      link('ss-open', 'Ctrl+O', () => this.actions?.onOpen()),
      this.dropNote,
    );

    this.recentBlock = document.createElement('div');
    this.recentBlock.className = 'ss-recent';
    this.recentBlock.hidden = true;

    this.recentCap = document.createElement('div');
    this.recentCap.className = 'ss-recent-cap';

    this.recentList = document.createElement('div');
    this.recentList.className = 'ss-recent-list';

    this.recentBlock.append(this.recentCap, this.recentList);
    wrap.append(rule, actionsRow, this.recentBlock);
    inner.insertBefore(wrap, inner.querySelector('.eh-keys'));

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
    if (this.dropNote) this.dropNote.textContent = t('ssDrop');
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
      // the row is a wrapper: the open button and the «×» are siblings
      // (no interactive content nested inside a button)
      const row = document.createElement('div');
      row.className = 'ss-recent-row';
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'ss-recent-item';
      item.title = entry.path;
      const name = document.createElement('span');
      name.className = 'ss-recent-name';
      name.textContent = fileNameOf(entry.path);
      item.append(name);
      const dir = shortDirOf(entry.path);
      if (dir) {
        const dirEl = document.createElement('span');
        dirEl.className = 'ss-recent-dir';
        dirEl.textContent = dir;
        item.append(dirEl);
      }
      const when = document.createElement('span');
      when.className = 'ss-recent-when';
      when.textContent = whenOf(entry.ts);
      item.append(when);
      item.addEventListener('click', () => this.actions?.onOpenRecent(entry.path));

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'ss-recent-x';
      remove.textContent = '×';
      remove.title = t('ssRemove');
      remove.setAttribute('aria-label', `${t('ssRemove')}: ${fileNameOf(entry.path)}`);
      remove.addEventListener('click', () => {
        removeRecent(entry.path);
        this.refreshRecent();
      });

      row.append(item, remove);
      list.append(row);
    }
  }
}
