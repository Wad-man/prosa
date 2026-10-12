## ProsaMD v__VERSION__

**RU** — что нового:

- **HTML в визуальном режиме**: инлайн-теги `kbd`, `sub`, `sup` и `<br>` рендерятся как настоящие теги — `H<sub>2</sub>O`, `x<sup>2</sup>`, клавиши `<kbd>Ctrl</kbd>`; выделение, ссылки и жирный работают поверх. Блочный HTML (`<div>`, HTML-таблицы, комментарии) показывается стилизованным кодом, а не рендерится. Файл сохраняется побайтово: регистр тегов (`<BR/>`) и формы (`<br />`/`<br>`) переживают редактирование, «Копировать для Word» уносит те же теги. Редкие записи — вложенность одного тега в такой же, пустые пары `<sub></sub>`, теги с атрибутами — остаются текстом без потерь байтов; запись вида `**<sub>a</sub>**` при сохранении переставляется в `<sub>**a**</sub>` (эквивалентная разметка). Остальной HTML остаётся текстом.
- **Поиск в режиме «Код»**: Ctrl+F и Ctrl+H открывают штатную панель CodeMirror (регекс, «целое слово», кнопки) в любом месте фокуса; Ctrl+H сразу ставит курсор в поле замены. Esc панели больше не перехватывает клавишу у меню и подсказок редактора.
- Исправлено (по прогону rc.2): панель поиска не закрывалась и всегда показывала строку замены; кнопка регистра была пустой.

**EN** — what's new:

- **HTML in the visual mode**: the inline `kbd`, `sub`, `sup` and `<br>` tags render as real tags — `H<sub>2</sub>O`, `x<sup>2</sup>`, `<kbd>Ctrl</kbd>` keycaps — with bold/links working across them. Block-level HTML (`<div>`, HTML tables, comments) shows as styled code instead of rendering. The file saves byte-exactly: tag case (`<BR/>`) and forms (`<br />`/`<br>`) survive editing, and Copy-for-Word carries the same tags. Rare spellings — a tag nested in the same tag, empty pairs like `<sub></sub>`, tags with attributes — stay literal text without losing bytes; `**<sub>a</sub>**` re-serializes as `<sub>**a**</sub>` (equivalent markup). Everything else stays literal text.
- **Search in the Source mode**: Ctrl+F and Ctrl+H open CodeMirror's own panel (regexp, whole word, buttons) no matter where the focus is; Ctrl+H lands the caret in the replace field. The panel's Esc no longer steals the key from menus and editor hints.
- Fixed (from the rc.2 owner run): the find bar would not close and always showed the replace row; the case-sensitivity button was empty.

---

**Установка / Install**

- **Windows** — установщик `*_x64-setup.exe` или портативный `*-portable-x64.exe` · installer or portable exe.
- **macOS** (Intel и Apple Silicon, один пакет) — `*.dmg`. Сборка без подписи разработчика: первый запуск через ПКМ по ProsaMD.app → «Открыть», либо `xattr -cr /Applications/ProsaMD.app`.
  Unsigned build: right-click ProsaMD.app → Open on first launch, or `xattr -cr /Applications/ProsaMD.app`.
- **Linux** — AppImage: `chmod +x ProsaMD_*_amd64.AppImage && ./ProsaMD_*_amd64.AppImage` (ARM64 — `*_aarch64.AppImage`).

<sub>Обновления устанавливаются прямо из приложения: клик по версии в статусной строке (проверено на Windows; на macOS/Linux — обновление следующим пакетом).
Updates install right from the app: click the version in the status bar (verified on Windows; on macOS/Linux — install the next package over the old one).</sub>
