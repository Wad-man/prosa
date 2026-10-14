## ProsaMD v__VERSION__

Релиз Windows и Linux. macOS развивается отдельной версией — [Wad-man/prosa-mac](https://github.com/Wad-man/prosa-mac) (#121).

**RU** — что нового:

- **Linux: основной формат — `.deb`** (x64 и ARM64): системный webkit2gtk вместо вшитого стека — единицы мегабайт вместо 84 МБ, после `apt install` появляются иконка в лаунчере и ассоциации `.md`. AppImage остаётся портативным вариантом для дистрибутивов без webkit2gtk-4.1. Обновление deb-установки — установкой нового пакета (кнопка проверки обновлений в приложении честно об этом сообщает).
- **Окно «Справка» (F1)**: перечень горячих клавиш (тот же источник, что меню) + ссылка на онлайн-справку по разметке — prosamd.ru/markdown, открывается в системном браузере.
- Также с прошлого RC: плавная смена темы (кроссфейд 280 мс, уважает «уменьшить движение») и кнопка хоткеев в строке состояния.

**EN** — what's new:

- **Linux: `.deb` is the primary format** (x64 and ARM64): system webkit2gtk instead of the bundled stack — single-digit megabytes instead of 84 MB, and `apt install` registers the launcher icon and `.md` associations. The AppImage stays as the portable option for distros without webkit2gtk-4.1. Deb installs update by installing the newer package (the in-app update check says so honestly).
- **The Help window (F1)**: the shortcut list (same source as the menu) plus a link to the online Markdown docs — prosamd.ru/markdown, opened in the system browser.
- Also since the previous RC: smooth theme crossfade (280 ms, respects reduced motion) and the shortcuts button in the status bar.

---

**Установка / Install**

- **Windows** — установщик `*_x64-setup.exe` или портативный `*-portable-x64.exe` · installer or portable exe.
- **macOS** — отдельная версия: [Wad-man/prosa-mac](https://github.com/Wad-man/prosa-mac).
  A separate version: Wad-man/prosa-mac.
- **Linux** — Ubuntu/Debian: `sudo apt install ./ProsaMD_*_amd64.deb` (ARM64 — `*_arm64.deb`). Прочие дистрибутивы — AppImage: `chmod +x ProsaMD_*_amd64.AppImage && ./ProsaMD_*_amd64.AppImage`.
  Ubuntu/Debian: install the `.deb`; other distros: make the AppImage executable and run.

<sub>Обновления — из окна «О программе» (клик по версии в статусной строке): работают на Windows и AppImage-установках Linux; установка из .deb обновляется новым пакетом.
Updates live in the About window (click the version in the status bar): available on Windows and AppImage installs on Linux; a .deb install upgrades by installing the newer package.</sub>
