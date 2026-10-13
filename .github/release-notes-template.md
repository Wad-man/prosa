## ProsaMD v__VERSION__

Кросс-платформенный релиз по итогам первого живого теста macOS и Linux.

**RU** — что нового:

- **macOS Monterey: приложение ожило.** WKWebView на схеме `tauri://` бросал `SecurityError` на само обращение к `localStorage` — один такой бросок на старте убивал весь фронтенд: пустое меню, нерабочие кнопки (отчёт с MacBook Air 2017). Все обращения к хранилищу ушли в безопасную обёртку с фолбэком в память, пол сборки зафиксирован явно. Замечание: визуальному редактору нужен Safari/WebKit 16.4+ (обновлённый Monterey с Safari 17.6 подходит; необновлённые 15.x открывают меню, но редактор не поднимется).
- **macOS: нативная строка меню** на языке интерфейса: ProsaMD (О программе, Настройки… `Cmd+,`, Службы, Скрыть, Завершить) · Правка · Окно со списком открытых документов. Больше никакого шаблонного английского File/Edit/View; `Cmd+C/X/V/A/Z` теперь доходят до редактора (WKWebView получает их только через нативное меню Правка).
- **Linux: основной формат — `.deb`** (x64 и ARM64): системный webkit2gtk вместо вшитого стека — единицы мегабайт вместо 84 МБ, после `apt install` появляются иконка в лаунчере и ассоциации `.md`. AppImage остаётся портативным вариантом для дистрибутивов без webkit2gtk-4.1. Обновление deb-установки — установкой нового пакета (кнопка проверки обновлений в приложении честно об этом сообщает).
- **Окно «Справка» (F1)**: перечень горячих клавиш (тот же источник, что меню) + ссылка на онлайн-справку по разметке — prosamd.ru/markdown, открывается в системном браузере.
- Также с прошлого RC: плавная смена темы (кроссфейд 280 мс, уважает «уменьшить движение») и кнопка хоткеев в строке состояния.

**EN** — what's new:

- **macOS Monterey: the frontend lives again.** WKWebView on the `tauri://` scheme throws a `SecurityError` on merely touching `localStorage` — one such throw at startup killed the whole frontend: empty menu, dead buttons (reported on a 2017 MacBook Air). All storage access now goes through a safe wrapper with an in-memory fallback, and the build floor is pinned explicitly. Note: the visual editor needs Safari/WebKit 16.4+ (an up-to-date Monterey on 17.6 is fine; unpatched 15.x boots the menu but the editor won't mount).
- **macOS: a native menu bar** in the UI language: ProsaMD (About, Settings… `Cmd+,`, Services, Hide, Quit) · Edit · Window with the open-document list. No more template English File/Edit/View; `Cmd+C/X/V/A/Z` now reach the editor (WKWebView only receives them through a native Edit menu).
- **Linux: `.deb` is the primary format** (x64 and ARM64): system webkit2gtk instead of the bundled stack — single-digit megabytes instead of 84 MB, and `apt install` registers the launcher icon and `.md` associations. The AppImage stays as the portable option for distros without webkit2gtk-4.1. Deb installs update by installing the newer package (the in-app update check says so honestly).
- **The Help window (F1)**: the shortcut list (same source as the menu) plus a link to the online Markdown docs — prosamd.ru/markdown, opened in the system browser.
- Also since the previous RC: smooth theme crossfade (280 ms, respects reduced motion) and the shortcuts button in the status bar.

---

**Установка / Install**

- **Windows** — установщик `*_x64-setup.exe` или портативный `*-portable-x64.exe` · installer or portable exe.
- **macOS** (Intel и Apple Silicon, один пакет) — `*.dmg`. Сборка без подписи разработчика: первый запуск через ПКМ по ProsaMD.app → «Открыть», либо `xattr -cr /Applications/ProsaMD.app`.
  Unsigned build: right-click ProsaMD.app → Open on first launch, or `xattr -cr /Applications/ProsaMD.app`.
- **Linux** — Ubuntu/Debian: `sudo apt install ./ProsaMD_*_amd64.deb` (ARM64 — `*_arm64.deb`). Прочие дистрибутивы — AppImage: `chmod +x ProsaMD_*_amd64.AppImage && ./ProsaMD_*_amd64.AppImage`.
  Ubuntu/Debian: install the `.deb`; other distros: make the AppImage executable and run.

<sub>Обновления устанавливаются прямо из приложения (Windows): клик по версии в статусной строке. macOS/Linux — обновление следующим пакетом.
Updates install right from the app on Windows: click the version in the status bar. On macOS/Linux — install the next package.</sub>
