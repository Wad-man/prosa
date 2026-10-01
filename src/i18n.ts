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
