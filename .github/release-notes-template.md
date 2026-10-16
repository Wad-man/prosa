## ProsaMD v0.2.0

Стабильный релиз: вся дельта с v0.1.10. Релиз Windows и Linux; macOS развивается отдельной версией — [Wad-man/prosa-mac](https://github.com/Wad-man/prosa-mac) (#121).

**RU** — что нового:

- **Режимы и Сплит.** Все четыре режима — Просмотр, Визуальный, Код и Сплит — в одном переключателе справа вверху. `Ctrl+/` мгновенно переключает Просмотр ↔ редактирование; клик по ячейке из Просмотра сразу начинает редактирование этим способом. Сплит показывает код и живое превью бок о бок, прокрутка синхронна.
- **Оглавление.** `Ctrl+Shift+1` или кнопка в правом верхнем углу: колонка как часть страницы — на широком окне стоит в поле справа от текста, на узком текст уступает ей полосу (оглавление никогда не перекрывает текст). Подсветка текущего раздела следует за прокруткой и доходит до последнего заголовка; нажатие по пункту переносит к нему; появление и скрытие колонки анимированы одним движением с текстом. На пустом документе колонка не показывается.
- **Поиск и замена.** `Ctrl+F` / `Ctrl+H` во всех режимах: подсветка совпадений, счётчик, переходы Enter/F3, учёт регистра, «Заменить все» одним шагом отмены. В режиме Код — панель CodeMirror с поддержкой регулярных выражений.
- **Печать и PDF.** «Печать…» (`Ctrl+P`) открывает настоящий диалог печати — в Windows с предпросмотром и выбором принтера, в macOS/Linux системный лист. «Сохранить в PDF…» (`Ctrl+Shift+P`, Windows) пишет тихий PDF через диалог сохранения: A4, поля ~2 см, без колонтитулов, тёмная тема печатается светлой вёрсткой; в macOS/Linux PDF сохраняется из диалога печати. Печатается рендер документа из исходника (front-matter не выводится, картинки подхватываются из папки документа) в любом режиме и поверх открытых диалогов; пустой документ печатается пустым листом.
- **Стартовый экран.** Пустой документ встречает действиями: «Новый файл» (`Ctrl+N`), «Открыть файл» (`Ctrl+O`), список недавних документов с датами и подсказками клавиш; файл можно перетащить прямо в окно.
- **HTML в визуальном режиме.** Инлайн-теги `kbd`, `sub`, `sup` и `br` рендерятся как настоящие элементы — `H<sub>2</sub>O`, клавиши `<kbd>Ctrl</kbd>`; блочный HTML (div, HTML-таблицы, комментарии) показывается стилизованным кодом. Файл сохраняется побайтово: регистр тегов и формы записей переживают редактирование.
- **Масштаб.** `Ctrl+колесо`, `Ctrl+=` / `Ctrl+−`, сброс `Ctrl+Num0`; выбранный уровень запоминается между запусками.
- **Настройки и тема.** Диалог «Настройки» (`Ctrl+,`): язык интерфейса русский/английский применяется сразу, без перезапуска. Смена светлой и тёмной темы — плавная.
- **Справка.** Окно `F1`: все горячие клавиши (тот же источник, что меню) и ссылка на онлайн-документацию по Markdown — prosamd.ru/markdown. Кнопка справки в строке состояния несёт видимую метку F1. В меню «Справка» — «Поблагодарить автора» (CloudTips) и «Предложения и замечания» (форма на сайте, каждое обращение читается).
- **Строка состояния и мелочи.** Нажатие на путь файла копирует полный путь в буфер; счётчик слов не показывается на пустом документе; в меню «Файл» — «Закрыть окно» (`Ctrl+W`); после обновления пункт «Что нового» показывает сводку релиза.
- **Linux: основной формат — `.deb`** (x64 и ARM64): системный webkit2gtk вместо вшитого стека — единицы мегабайт вместо 84 МБ, после `apt install` появляются иконка в лаунчере и ассоциации `.md`. AppImage остаётся портативным вариантом для дистрибутивов без webkit2gtk-4.1.
- **Исправления** (с v0.1.10): конвертация нумерованного списка в маркированный (`Ctrl+Alt+8`); «Снять форматирование» больше не удаляет флажки задач `[x]`; корректное закрытие панели поиска; локализация подписи языка код-блока; типографические доводки.

**EN** — what's new:

- **Modes & Split.** All four modes — Reading, Visual, Code and Split — live in one switcher at the top right. `Ctrl+/` flips Reading ↔ editing instantly; clicking a cell from Reading starts editing that way. Split shows the code and the live preview side by side, scrolling together.
- **Document outline.** `Ctrl+Shift+1` or the top-right button: a column that belongs to the page — parked in the margin on wide windows, given its own strip when the window is narrow (never over the text). The current section is highlighted as you scroll, down to the last heading; a click takes you to it; the column's show/hide animates as one motion with the text. Empty documents show no column.
- **Find & replace.** `Ctrl+F` / `Ctrl+H` in every mode: highlighted matches, a counter, Enter/F3 navigation, match case, Replace all as a single undo step. The Code mode gets CodeMirror's own panel with regular expressions.
- **Print & PDF.** Print… (`Ctrl+P`) opens the real print dialog — with preview and printer picker on Windows, the system sheet on macOS/Linux. Save as PDF… (`Ctrl+Shift+P`, Windows) writes a silent PDF through a Save dialog: A4, ~2 cm margins, no headers or footers, dark theme prints in a light layout; on macOS/Linux save the PDF from the print dialog. What prints is the document rebuilt from its source (front-matter skipped, images loaded from the document's folder), in any mode and over open dialogs; an empty document prints as a blank sheet.
- **Start screen.** An empty document greets you with actions: New file (`Ctrl+N`), Open file (`Ctrl+O`), recent documents with dates and key hints; drop a file straight into the window.
- **HTML in the visual mode.** The inline `kbd`, `sub`, `sup` and `br` tags render as real elements — `H<sub>2</sub>O`, `<kbd>Ctrl</kbd>` keycaps; block-level HTML (div, HTML tables, comments) shows as styled code. The file saves byte-exactly: tag case and spellings survive editing.
- **Zoom.** `Ctrl+wheel`, `Ctrl+=` / `Ctrl+−`, reset with `Ctrl+Num0`; the level persists across launches.
- **Settings & theme.** A Settings dialog (`Ctrl+,`): the RU/EN interface language applies immediately, no restart. Light/dark theme changes are now a smooth cross-fade.
- **Help.** The `F1` window: every shortcut (the same source as the menu) plus a link to the online Markdown docs — prosamd.ru/markdown. The status-bar help button carries a visible F1 label. The Help menu gains "Support the author" (CloudTips) and "Feedback" (the site's form — every message gets read).
- **Status bar & small things.** Pressing the file path copies the full path; the word count hides on an empty document; the File menu gains "Close Window" (`Ctrl+W`); after an update, "What's new" shows the release summary.
- **Linux: `.deb` is the primary format** (x64 and ARM64): system webkit2gtk instead of the bundled stack — single-digit megabytes instead of 84 MB, and `apt install` registers the launcher icon and `.md` associations. The AppImage stays as the portable option.
- **Fixes** (since v0.1.10): ordered-to-bullet list conversion (`Ctrl+Alt+8`); Clear formatting no longer removes task checkboxes; the find bar closes correctly; the code-block language caption is localized; typography polish.

---

**Установка / Install**

- **Windows** — установщик `*_x64-setup.exe` или портативный `*-portable-x64.exe` · installer or portable exe.
- **macOS** — отдельная версия: [Wad-man/prosa-mac](https://github.com/Wad-man/prosa-mac).
  A separate version: Wad-man/prosa-mac.
- **Linux** — Ubuntu/Debian: `sudo apt install ./ProsaMD_*_amd64.deb` (ARM64 — `*_arm64.deb`). Прочие дистрибутивы — AppImage: `chmod +x ProsaMD_*_amd64.AppImage && ./ProsaMD_*_amd64.AppImage`.
  Ubuntu/Debian: install the `.deb`; other distros: make the AppImage executable and run.

<sub>Обновления — из окна «О программе» (клик по версии в статусной строке): работают на Windows и AppImage-установках Linux; установка из .deb обновляется новым пакетом. Обновление с v0.2.0-rc.N: для .deb apt считает rc-версию «новее» стабильной и предупредит о понижении — подтвердите установку пакета 0.2.0 вручную.
Updates live in the About window (click the version in the status bar): available on Windows and AppImage installs on Linux; a .deb install upgrades by installing the newer package. Coming from v0.2.0-rc.N on .deb: apt treats the rc build as "newer" and will warn about a downgrade — confirm the 0.2.0 package install manually.</sub>
