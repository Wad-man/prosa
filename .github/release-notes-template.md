## ProsaMD v__VERSION__

**RU** — что нового:

- Поиск и замена (Ctrl+F / Ctrl+H) во всех трёх режимах: подсветка совпадений, счётчик, переходы Enter/F3, учёт регистра, «Заменить все» одним шагом отмены.
- Масштаб: Ctrl+колесо, Ctrl+= / Ctrl+−, сброс Ctrl+Num0; уровень запоминается.
- Исправлено: конвертация нумерованного списка в маркированный (Ctrl+Alt+8) в визуальном режиме.
- Исправлено: «Снять форматирование» больше не съедает флажок задачи `[x]` на строке со ссылкой.
- Исправлено: оглавление показывает «Заголовков нет» на пустом документе.
- Локализация: триггер языка блока кода — «Текст»/«Text».

**EN** — what's new:

- Find & replace (Ctrl+F / Ctrl+H) in all three modes: match highlighting, counter, Enter/F3 navigation, match case, Replace all as a single undo step.
- Zoom: Ctrl+wheel, Ctrl+= / Ctrl+−, reset with Ctrl+Num0; the level persists.
- Fixed: converting an ordered list to a bullet list (Ctrl+Alt+8) in the visual editor.
- Fixed: Clear formatting no longer eats the `[x]` task checkbox on a line with a link.
- Fixed: the outline shows its "no headings" placeholder on an empty document.
- Localization: the code-block language trigger now reads «Текст»/«Text».

---

**Установка / Install**

- **Windows** — установщик `*_x64-setup.exe` или портативный `*-portable-x64.exe` · installer or portable exe.
- **macOS** (Intel и Apple Silicon, один пакет) — `*.dmg`. Сборка без подписи разработчика: первый запуск через ПКМ по ProsaMD.app → «Открыть», либо `xattr -cr /Applications/ProsaMD.app`.
  Unsigned build: right-click ProsaMD.app → Open on first launch, or `xattr -cr /Applications/ProsaMD.app`.
- **Linux** — AppImage: `chmod +x ProsaMD_*_amd64.AppImage && ./ProsaMD_*_amd64.AppImage` (ARM64 — `*_aarch64.AppImage`).

<sub>Обновления устанавливаются прямо из приложения: клик по версии в статусной строке (проверено на Windows; на macOS/Linux — обновление следующим пакетом).
Updates install right from the app: click the version in the status bar (verified on Windows; on macOS/Linux — install the next package over the old one).</sub>
