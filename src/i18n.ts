import { storageGet, storageSet } from './storage';

export type Lang = 'ru' | 'en';

const STORAGE_KEY = 'prosa.lang';

const strings = {
  ru: {
    open: 'Открыть…',
    save: 'Сохранить',
    saveAs: 'Сохранить как…',
    reading: 'Просмотр',
    visual: 'Визуальный редактор',
    source: 'Код',
    split: 'Сплит',
    untitled: 'Без названия',
    unsaved: 'Несохранённые изменения',
    words: 'слов',
    word: 'слово',
    chars: 'симв.',
    discardTitle: 'Несохранённые изменения',
    discardQuestion: 'Открыть другой файл и отбросить несохранённые изменения?',
    openError: 'Не удалось открыть файл',
    saveError: 'Не удалось сохранить файл',
    notMarkdown: 'Это не Markdown-файл',
    toolbar: 'Панель инструментов',
    themeTip: 'Переключить тему (светлая / тёмная)',
    minShort: 'мин',
    emptyDrop: 'Начните писать или вставьте текст — это станет новым документом',
    // #131-4: Просмотр cannot write — its own empty-document line
    emptyDropReading: 'Пустой документ — создайте новый или откройте файл',
    ehPaste: 'вставить',
    ehMode: 'режим',
    ehSettings: 'настройки',
    ehAllKeys: 'все сочетания клавиш',
    formatKbd: 'ПКМ',
    formatMouse: 'Правая кнопка мыши',
    formatPanel: 'форматирование',
    modeToggle: 'Режим',
    // #110: the View-menu entry for the Просмотр ↔ Редактирование switch
    modeViewToggle: 'Просмотр / редактирование',
    versionTip: 'О программе',
    aboutDesc: 'Минималистичный открытый редактор и просмотрщик Markdown — «блокнот» для .md-файлов',
    versionWord: 'Версия',
    licenseLink: 'Лицензия MIT',
    checkUpdates: 'Проверить обновления',
    closeTip: 'Закрыть',
    closeQuestion: 'В документе «{name}» есть несохранённые изменения.',
    // #143: the window close with several dirty tabs at once
    closeQuestionMany: 'В {n} документах есть несохранённые изменения.',
    saveAll: 'Сохранить все',
    dontSave: 'Не сохранять',
    // #145: the open-files list's context menus
    reload: 'Обновить',
    closeAll: 'Закрыть все',
    cancel: 'Отмена',
    upToDate: 'У вас последняя версия ProsaMD',
    updateTitle: 'Обновление ProsaMD',
    updateAvailable: 'Доступна версия {version}. Установить сейчас?',
    updateSaveFirst:
      'Для установки приложение перезапустится, несохранённый документ будет потерян. Сохранить его перед обновлением?',
    updateDownloading: 'Скачивание обновления…',
    updateInstalling: 'Установка обновления…',
    updateCheckError: 'Не удалось проверить обновления',
    updateError: 'Не удалось установить обновление',
    updateOtherDirty:
      'В других окнах ProsaMD есть несохранённые изменения — при установке обновления они будут потеряны. Продолжить?',
    menuBar: 'Строка меню',
    mFile: 'Файл',
    mEdit: 'Правка',
    mParagraph: 'Параграф',
    mFormat: 'Формат',
    mView: 'Вид',
    mHelp: 'Справка',
    newDoc: 'Создать',
    newQuestion: 'Создать новый документ и отбросить несохранённые изменения?',
    undo: 'Отменить',
    redo: 'Повторить',
    cut: 'Вырезать',
    copy: 'Копировать',
    copyForWord: 'Копировать для Word',
    paste: 'Вставить',
    selectAll: 'Выделить всё',
    deleteLine: 'Удалить строку',
    taskToggle: 'Флажок задачи [x]',
    clearFormat: 'Снять форматирование',
    clipboardError: 'Не удалось обратиться к буферу обмена',
    imgSaveTitle: 'Вставка картинки',
    imgSaveQuestion:
      'Чтобы вставить картинку, сначала сохраните документ — файл картинки будет лежать рядом с ним в подпапке assets/. Сохранить сейчас?',
    imgSaveError: 'Не удалось сохранить файл картинки',
    themeLight: 'Светлая',
    themeDark: 'Тёмная',
    tocTitle: 'Оглавление',
    tocOnPage: 'На странице',
    tocEmpty: 'Заголовков нет',
    // #11: open files panel
    openFilesTitle: 'Открытые',
    closeTab: 'Закрыть документ',
    // #96: start screen (empty state)
    ssNewFile: 'Новый файл',
    ssOpenFile: 'Открыть файл…',
    ssRecent: 'Недавние',
    ssDrop: 'или перетащите .md-файл в окно',
    ssRemove: 'Убрать из недавних',
    ssToday: 'сегодня',
    ssYesterday: 'вчера',
    website: 'Веб-сайт',
    sourceCode: 'Исходный код',
    // Help-menu links (гейт 2026-10-16, вариант А): the CloudTips page and
    // the site's feedback form — one external-links family with the site
    tipAuthor: 'Поблагодарить автора',
    feedback: 'Предложения и замечания',
    hotkeys: 'Горячие клавиши',
    // #107: the F1 window — shortcut list plus a link to the site docs
    help: 'Справка',
    helpOnline: 'Онлайн-справка: разметка Markdown',
    // #105: .deb installs update by installing the next package
    updateDebPackage: 'Установка из .deb обновляется новым пакетом со страницы релизов.',
    settings: 'Настройки…',
    settingsTitle: 'Настройки',
    settingsLangSection: 'Язык интерфейса',
    // #32: find & replace bar + its Edit-menu entries
    findMenu: 'Найти…',
    findReplaceMenu: 'Найти и заменить…',
    findLabel: 'Найти',
    replaceLabel: 'Заменить на',
    findCountLabel: 'Совпадения',
    findNextTip: 'Следующее совпадение (Enter)',
    findPrevTip: 'Предыдущее совпадение (Shift+Enter)',
    matchCaseTip: 'Учитывать регистр',
    replaceBtn: 'Заменить',
    replaceAllBtn: 'Все',
    replaceAllTip: 'Заменить все',
    // #25: zoom (View menu)
    zoomIn: 'Увеличить',
    zoomOut: 'Уменьшить',
    zoomReset: 'Масштаб 100%',
    // #24 → #134: print/save-PDF (File menu) + the failure dialogs — the
    // wording follows the platform's actual pipeline (print.ts)
    print: 'Печать…',
    savePdf: 'Сохранить в PDF…',
    printError: 'Не удалось выполнить печать',
    printErrorPdf: 'Не удалось создать PDF',
    closeWindow: 'Закрыть окно',
    // #125: the status-bar path copy feedback
    pathCopied: 'Путь скопирован',
    // #37: what's new (Help menu + modal)
    whatsNew: 'Что нового',
    changelogFull: 'Полная история версий',
    // имена языков — эндонимы, не переводятся ни в одном из словарей
    langRu: 'Русский',
    langEn: 'English',
  },
  en: {
    open: 'Open…',
    save: 'Save',
    saveAs: 'Save as…',
    reading: 'Reading',
    visual: 'Visual editor',
    // "Code", not "Source code": the Help menu already links to the repo as
    // "Source code" (mirrors RU «Код» / «Исходный код», #81)
    source: 'Code',
    split: 'Split',
    untitled: 'Untitled',
    unsaved: 'Unsaved changes',
    words: 'words',
    word: 'word',
    chars: 'chars',
    discardTitle: 'Unsaved changes',
    discardQuestion: 'Open another file and discard unsaved changes?',
    openError: 'Failed to open file',
    saveError: 'Failed to save file',
    notMarkdown: 'Not a Markdown file',
    toolbar: 'Toolbar',
    themeTip: 'Switch theme (light / dark)',
    minShort: 'min',
    emptyDrop: 'Start writing or paste text — it becomes a new document',
    // #131-4: reading cannot write — its own empty-document line
    emptyDropReading: 'Empty document — create a new file or open one',
    ehPaste: 'paste',
    ehMode: 'mode',
    ehSettings: 'settings',
    ehAllKeys: 'all shortcuts',
    formatKbd: 'RMB',
    formatMouse: 'Right mouse button',
    formatPanel: 'formatting',
    modeToggle: 'Mode',
    // #110: the View-menu entry for the reading ↔ editing switch
    modeViewToggle: 'Reading / editing',
    versionTip: 'About ProsaMD',
    aboutDesc: 'A minimal open-source Markdown editor & viewer — a "notepad" for .md files',
    versionWord: 'Version',
    licenseLink: 'MIT License',
    checkUpdates: 'Check for updates',
    closeTip: 'Close',
    closeQuestion: '"{name}" has unsaved changes.',
    // #143: the window close with several dirty tabs at once
    closeQuestionMany: '{n} documents have unsaved changes.',
    saveAll: 'Save all',
    dontSave: "Don't save",
    // #145: the open-files list's context menus
    reload: 'Reload',
    closeAll: 'Close all',
    cancel: 'Cancel',
    upToDate: 'ProsaMD is up to date',
    updateTitle: 'ProsaMD update',
    updateAvailable: 'Version {version} is available. Install now?',
    updateSaveFirst:
      'The app will restart to install the update and unsaved changes will be lost. Save the document first?',
    updateDownloading: 'Downloading update…',
    updateInstalling: 'Installing update…',
    updateCheckError: 'Failed to check for updates',
    updateError: 'Failed to install the update',
    updateOtherDirty:
      'Other ProsaMD windows have unsaved changes — they will be lost when the update installs. Continue?',
    menuBar: 'Menu bar',
    mFile: 'File',
    mEdit: 'Edit',
    mParagraph: 'Paragraph',
    mFormat: 'Format',
    mView: 'View',
    mHelp: 'Help',
    newDoc: 'New',
    newQuestion: 'Start a new document and discard unsaved changes?',
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    copyForWord: 'Copy for Word',
    paste: 'Paste',
    selectAll: 'Select all',
    deleteLine: 'Delete line',
    taskToggle: 'Task checkbox [x]',
    clearFormat: 'Clear formatting',
    clipboardError: 'Clipboard access failed',
    imgSaveTitle: 'Pasting an image',
    imgSaveQuestion:
      'Save the document first — the image file will live next to it in an assets/ subfolder. Save now?',
    imgSaveError: 'Failed to save the image file',
    themeLight: 'Light',
    themeDark: 'Dark',
    tocTitle: 'Outline',
    tocOnPage: 'On this page',
    tocEmpty: 'No headings yet',
    // #11: open files panel
    openFilesTitle: 'Open files',
    closeTab: 'Close document',
    // #96: start screen (empty state)
    ssNewFile: 'New file',
    ssOpenFile: 'Open file…',
    ssRecent: 'Recent',
    ssDrop: 'or drop a .md file into the window',
    ssRemove: 'Remove from recent',
    ssToday: 'today',
    ssYesterday: 'yesterday',
    website: 'Website',
    sourceCode: 'Source code',
    tipAuthor: 'Support the author',
    feedback: 'Feedback',
    hotkeys: 'Keyboard shortcuts',
    // #107: the F1 window — shortcut list plus a link to the site docs
    help: 'Help',
    helpOnline: 'Online help: Markdown reference',
    // #105: .deb installs update by installing the next package
    updateDebPackage: 'The .deb install updates by installing the newer package from the releases page.',
    settings: 'Settings…',
    settingsTitle: 'Settings',
    settingsLangSection: 'Interface language',
    // #32: find & replace bar + its Edit-menu entries
    findMenu: 'Find…',
    findReplaceMenu: 'Find and replace…',
    findLabel: 'Find',
    replaceLabel: 'Replace with',
    findCountLabel: 'Matches',
    findNextTip: 'Next match (Enter)',
    findPrevTip: 'Previous match (Shift+Enter)',
    matchCaseTip: 'Match case',
    replaceBtn: 'Replace',
    replaceAllBtn: 'All',
    replaceAllTip: 'Replace all',
    // #25: zoom (View menu)
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    zoomReset: 'Actual size',
    // #24: print (File menu) + its failure dialog
    print: 'Print…',
    savePdf: 'Save as PDF…',
    printError: 'Failed to print',
    printErrorPdf: 'Failed to create the PDF',
    closeWindow: 'Close Window',
    // #125: the status-bar path copy feedback
    pathCopied: 'Path copied',
    // #37: what's new (Help menu + modal)
    whatsNew: "What's new",
    changelogFull: 'Full version history',
    // language names are endonyms — identical in both dictionaries
    langRu: 'Русский',
    langEn: 'English',
  },
} as const;

export type StrKey = keyof (typeof strings)['ru'];

let current: Lang = detectLang();

function detectLang(): Lang {
  const saved = storageGet(STORAGE_KEY);
  if (saved === 'ru' || saved === 'en') return saved;
  return navigator.language.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang): void {
  current = lang;
  storageSet(STORAGE_KEY, lang);
}

export function t(key: StrKey): string {
  return strings[current][key];
}

// ---------- CodeMirror UI phrases (#76) ----------
// CodeMirror renders its own UI (the Ctrl+F search panel, the go-to-line
// dialog on Ctrl+Alt+G, fold-gutter tooltips, screen-reader announcements)
// through view.state.phrase(), which falls back to the phrase's English
// source string — so that string is the key below. The English dictionary
// repeats CodeMirror's defaults explicitly, both languages stay symmetric
// (same pattern as crepe-locale.ts).
const cmPhrases: Record<Lang, Record<string, string>> = {
  ru: {
    // @codemirror/search — the search panel and its announcements
    Find: 'Найти',
    Replace: 'Заменить',
    next: 'Далее',
    previous: 'Назад',
    all: 'Все',
    'match case': 'Учитывать регистр',
    regexp: 'Регулярное выражение',
    'by word': 'Слово целиком',
    replace: 'Заменить',
    'replace all': 'Заменить все',
    close: 'Закрыть',
    'Go to line': 'Перейти к строке',
    go: 'Перейти',
    'current match': 'Текущее совпадение',
    'on line': 'в строке',
    'replaced $ matches': 'Заменено совпадений: $',
    'replaced match on line $': 'Заменено совпадение в строке $',
    // @codemirror/language — folding (gutter tooltips, announcements)
    'Fold line': 'Свернуть строку',
    'Unfold line': 'Развернуть строку',
    'Folded lines': 'Свёрнуты строки',
    'Unfolded lines': 'Развёрнуты строки',
    to: 'до',
    'folded code': 'Свёрнутый код',
    unfold: 'Развернуть',
    // @codemirror/view, autocomplete, commands, lint (basicSetup surface)
    'Control character': 'Управляющий символ',
    Completions: 'Автодополнение',
    'Selection deleted': 'Выделение удалено',
    Diagnostics: 'Диагностика',
    'No diagnostics': 'Нет замечаний',
  },
  en: {
    Find: 'Find',
    Replace: 'Replace',
    next: 'next',
    previous: 'previous',
    all: 'all',
    'match case': 'match case',
    regexp: 'regexp',
    'by word': 'by word',
    replace: 'replace',
    'replace all': 'replace all',
    close: 'close',
    'Go to line': 'Go to line',
    go: 'go',
    'current match': 'Current match',
    'on line': 'on line',
    'replaced $ matches': 'replaced $ matches',
    'replaced match on line $': 'replaced match on line $',
    'Fold line': 'Fold line',
    'Unfold line': 'Unfold line',
    'Folded lines': 'Folded lines',
    'Unfolded lines': 'Unfolded lines',
    to: 'to',
    'folded code': 'folded code',
    unfold: 'unfold',
    'Control character': 'Control character',
    Completions: 'Completions',
    'Selection deleted': 'Selection deleted',
    Diagnostics: 'Diagnostics',
    'No diagnostics': 'No diagnostics',
  },
};

/**
 * Phrases for EditorState.phrases.of() in the source mode. The source
 * editor is created once and outlives language switches (main.ts only
 * rebuilds the visual editor), so instead of a snapshot the object exposes
 * the strings through getters: EditorState.phrase() does hasOwnProperty +
 * [key] on every call, and each search-panel open or gutter render
 * re-reads the live language (#76).
 */
export function getCmPhrases(): Record<string, string> {
  const live: Record<string, string> = {};
  for (const key of Object.keys(cmPhrases.ru)) {
    Object.defineProperty(live, key, {
      enumerable: true,
      // a key missing from the active dictionary falls back to the English
      // source string, exactly like CodeMirror's own default
      get: () => cmPhrases[current][key] ?? key,
    });
  }
  return live;
}
