import { Crepe, type CrepeConfig } from '@milkdown/crepe';

import type { Lang } from '../i18n';

/**
 * Localized labels for the editor UI: Crepe's own features (fed through
 * `featureConfigs`, see crepeLocaleConfigs) and our context formatting
 * panel (src/editor/context-panel.ts). One shared dictionary so the slash
 * menu, the Crepe tooltips and the panel never drift apart.
 *
 * Crepe has no locale support of its own — every user-visible string of
 * its features defaults to English. Because Crepe bakes featureConfigs in
 * at construction (defaultsDeep), the visual editor is rebuilt on language
 * switch (VisualEditor.rebuild); the context panel reads this dictionary
 * at open time, so it re-localizes without a rebuild.
 */
export interface EditorStrings {
  /** slash-menu group titles */
  groupText: string;
  groupList: string;
  groupAdvanced: string;
  /** block-type labels (slash menu + context panel submenu) */
  text: string;
  h1: string;
  h2: string;
  h3: string;
  h4: string;
  h5: string;
  h6: string;
  quote: string;
  divider: string;
  bulletList: string;
  orderedList: string;
  taskList: string;
  image: string;
  table: string;
  math: string;
  codeBlock: string;
  /** inline-formatting labels (Crepe toolbar config; panel uses them too) */
  bold: string;
  italic: string;
  strikethrough: string;
  inlineCode: string;
  link: string;
  /** context panel: title of the block-type submenu row */
  paragraph: string;
}

const STRINGS: Record<Lang, EditorStrings> = {
  ru: {
    groupText: 'Текст',
    groupList: 'Списки',
    groupAdvanced: 'Дополнительно',
    text: 'Обычный текст',
    h1: 'Заголовок 1',
    h2: 'Заголовок 2',
    h3: 'Заголовок 3',
    h4: 'Заголовок 4',
    h5: 'Заголовок 5',
    h6: 'Заголовок 6',
    quote: 'Цитата',
    divider: 'Разделитель',
    bulletList: 'Маркированный список',
    orderedList: 'Нумерованный список',
    taskList: 'Список задач',
    image: 'Изображение',
    table: 'Таблица',
    math: 'Формула',
    codeBlock: 'Блок кода',
    bold: 'Полужирный',
    italic: 'Курсив',
    strikethrough: 'Зачёркнутый',
    inlineCode: 'Инлайн-код',
    link: 'Ссылка',
    paragraph: 'Параграф',
  },
  en: {
    groupText: 'Text',
    groupList: 'List',
    groupAdvanced: 'Advanced',
    text: 'Text',
    h1: 'Heading 1',
    h2: 'Heading 2',
    h3: 'Heading 3',
    h4: 'Heading 4',
    h5: 'Heading 5',
    h6: 'Heading 6',
    quote: 'Quote',
    divider: 'Divider',
    bulletList: 'Bullet List',
    orderedList: 'Ordered List',
    taskList: 'Task List',
    image: 'Image',
    table: 'Table',
    math: 'Math',
    codeBlock: 'Code block',
    bold: 'Bold',
    italic: 'Italic',
    strikethrough: 'Strikethrough',
    inlineCode: 'Inline code',
    link: 'Link',
    paragraph: 'Paragraph',
  },
};

export function editorStrings(lang: Lang): EditorStrings {
  return STRINGS[lang];
}

/**
 * Crepe feature strings for one language. The English branch repeats
 * Crepe's defaults explicitly so both languages stay symmetric above.
 * Non-label feature strings (placeholders) live here too.
 */
export function crepeLocaleConfigs(lang: Lang): NonNullable<CrepeConfig['featureConfigs']> {
  const ru = lang === 'ru';
  const s = editorStrings(lang);
  return {
    [Crepe.Feature.BlockEdit]: {
      textGroup: {
        label: s.groupText,
        text: { label: s.text },
        h1: { label: s.h1 },
        h2: { label: s.h2 },
        h3: { label: s.h3 },
        h4: { label: s.h4 },
        h5: { label: s.h5 },
        h6: { label: s.h6 },
        quote: { label: s.quote },
        divider: { label: s.divider },
      },
      listGroup: {
        label: s.groupList,
        bulletList: { label: s.bulletList },
        orderedList: { label: s.orderedList },
        taskList: { label: s.taskList },
      },
      advancedGroup: {
        label: s.groupAdvanced,
        image: { label: s.image },
        codeBlock: { label: s.codeBlock },
        table: { label: s.table },
        math: { label: s.math },
      },
    },
    // (Crepe's auto selection toolbar is disabled in visual.ts — its
    // label config would be dead code; the context panel uses
    // editorStrings() directly)
    [Crepe.Feature.LinkTooltip]: {
      inputPlaceholder: ru ? 'Вставьте ссылку…' : 'Paste link...',
    },
    [Crepe.Feature.ImageBlock]: {
      inlineUploadPlaceholderText: ru ? 'или вставьте ссылку' : 'or paste link',
      blockCaptionPlaceholderText: ru ? 'Подпись к изображению' : 'Write Image Caption',
      blockUploadPlaceholderText: ru ? 'или вставьте ссылку' : 'or paste link',
    },
    [Crepe.Feature.CodeMirror]: {
      searchPlaceholder: ru ? 'Поиск языка' : 'Search language',
      copyText: ru ? 'Копировать' : 'Copy',
      noResultText: ru ? 'Ничего не найдено' : 'No result',
      previewToggleText: (previewOnlyMode: boolean) =>
        previewOnlyMode ? (ru ? 'Изменить' : 'Edit') : (ru ? 'Скрыть' : 'Hide'),
    },
  };
}
