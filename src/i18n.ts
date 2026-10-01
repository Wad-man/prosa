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
    versionTip: 'Проверить обновления',
    upToDate: 'У вас последняя версия Prosa',
    updateTitle: 'Обновление Prosa',
    updateAvailable: 'Доступна версия {version}. Установить сейчас?',
    updateSaveFirst:
      'Для установки приложение перезапустится, несохранённый документ будет потерян. Сохранить его перед обновлением?',
    updateDownloading: 'Скачивание обновления…',
    updateInstalling: 'Установка обновления…',
    updateCheckError: 'Не удалось проверить обновления',
    updateError: 'Не удалось установить обновление',
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
    versionTip: 'Check for updates',
    upToDate: 'Prosa is up to date',
    updateTitle: 'Prosa update',
    updateAvailable: 'Version {version} is available. Install now?',
    updateSaveFirst:
      'The app will restart to install the update and unsaved changes will be lost. Save the document first?',
    updateDownloading: 'Downloading update…',
    updateInstalling: 'Installing update…',
    updateCheckError: 'Failed to check for updates',
    updateError: 'Failed to install the update',
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
