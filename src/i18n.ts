export type Lang = 'ru' | 'en';

const STORAGE_KEY = 'prosa.lang';

const strings = {
  ru: {
    open: 'Открыть…',
    save: 'Сохранить',
    saveAs: 'Сохранить как…',
    visual: 'Визуальный',
    source: 'Код',
    untitled: 'Без названия',
    unsaved: 'Несохранённые изменения',
    words: 'слов',
    chars: 'симв.',
    discardTitle: 'Несохранённые изменения',
    discardQuestion: 'Открыть другой файл и отбросить несохранённые изменения?',
    openError: 'Не удалось открыть файл',
    saveError: 'Не удалось сохранить файл',
    notMarkdown: 'Это не Markdown-файл',
    toolbar: 'Панель инструментов',
    langTip: 'Сменить язык интерфейса (RU / EN)',
    themeTip: 'Переключить тему (светлая / тёмная)',
    minShort: 'мин',
    emptyDrop: 'Перетащите .md-файл в окно — или просто начните писать',
    modeToggle: 'Режим',
    versionTip: 'О программе',
    aboutDesc: 'Минималистичный открытый редактор и читалка Markdown — «блокнот» для .md-файлов',
    versionWord: 'Версия',
    licenseLink: 'Лицензия MIT',
    checkUpdates: 'Проверить обновления',
    closeTip: 'Закрыть',
    closeQuestion: 'В документе «{name}» есть несохранённые изменения.',
    dontSave: 'Не сохранять',
    cancel: 'Отмена',
    upToDate: 'У вас последняя версия Prosa',
    updateTitle: 'Обновление Prosa',
    updateAvailable: 'Доступна версия {version}. Установить сейчас?',
    updateSaveFirst:
      'Для установки приложение перезапустится, несохраненный документ будет потерян. Сохранить его перед обновлением?',
    updateDownloading: 'Скачивание обновления…',
    updateInstalling: 'Установка обновления…',
    updateCheckError: 'Не удалось проверить обновления',
    updateError: 'Не удалось установить обновление',
    updateOtherDirty:
      'В других окнах Prosa есть несохранённые изменения — при установке обновления они будут потеряны. Продолжить?',
  },
  en: {
    open: 'Open…',
    save: 'Save',
    saveAs: 'Save as…',
    visual: 'Visual',
    source: 'Source',
    untitled: 'Untitled',
    unsaved: 'Unsaved changes',
    words: 'words',
    chars: 'chars',
    discardTitle: 'Unsaved changes',
    discardQuestion: 'Open another file and discard unsaved changes?',
    openError: 'Failed to open file',
    saveError: 'Failed to save file',
    notMarkdown: 'Not a Markdown file',
    toolbar: 'Toolbar',
    langTip: 'Switch interface language (RU / EN)',
    themeTip: 'Switch theme (light / dark)',
    minShort: 'min',
    emptyDrop: 'Drop a .md file into the window — or just start writing',
    modeToggle: 'Mode',
    versionTip: 'About Prosa',
    aboutDesc: 'A minimal open-source Markdown reader & editor — a "notepad" for .md files',
    versionWord: 'Version',
    licenseLink: 'MIT License',
    checkUpdates: 'Check for updates',
    closeTip: 'Close',
    closeQuestion: '"{name}" has unsaved changes.',
    dontSave: "Don't save",
    cancel: 'Cancel',
    upToDate: 'Prosa is up to date',
    updateTitle: 'Prosa update',
    updateAvailable: 'Version {version} is available. Install now?',
    updateSaveFirst:
      'The app will restart to install the update and unsaved changes will be lost. Save the document first?',
    updateDownloading: 'Downloading update…',
    updateInstalling: 'Installing update…',
    updateCheckError: 'Failed to check for updates',
    updateError: 'Failed to install the update',
    updateOtherDirty:
      'Other Prosa windows have unsaved changes — they will be lost when the update installs. Continue?',
  },
} as const;

export type StrKey = keyof (typeof strings)['ru'];

let current: Lang = detectLang();

function detectLang(): Lang {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === 'ru' || saved === 'en') return saved;
  return navigator.language.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang): void {
  current = lang;
  localStorage.setItem(STORAGE_KEY, lang);
}

export function t(key: StrKey): string {
  return strings[current][key];
}
