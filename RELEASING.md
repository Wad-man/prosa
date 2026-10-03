# Как выпустить релиз

Требуемые секреты репозитория (Settings → Secrets and variables → Actions):

- `TAURI_SIGNING_PRIVATE_KEY` — содержимое `src-tauri/keys/prosa-updater.key`
  (подпись пакетов обновления; **держите бэкап этого ключа** — без него уже
  установленные версии не смогут обновляться).
- `RELEASES_REPO_TOKEN` — [fine-grained PAT](https://github.com/settings/personal-access-tokens/new),
  доступ только к `Wad-man/prosa-releases`, права **Contents: Read and write**
  (публикация черновика релиза из workflow).

## Шаги

1. Поднять версию в трёх файлах: `package.json`, `src-tauri/tauri.conf.json`,
   `src-tauri/Cargo.toml` (коммит «Bump version to X.Y.Z»).
2. Запушить в `main`, затем проставить тег:

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

3. Workflow [`release.yml`](.github/workflows/release.yml) соберёт подписанные
   пакеты и создаст **черновик** релиза в
   [Wad-man/prosa-releases](https://github.com/Wad-man/prosa-releases):
   установщик NSIS + его подпись `.sig` (для NSIS установщик и есть пакет
   обновления), portable exe и `latest.json` (скрипт
   `scripts/make-updater-json.mjs` сверяет тег с версией в конфигах и падает
   при несовпадении).
4. В черновике заполнить RU/EN заметки и опубликовать. С этого момента
   приложение видит обновление: `releases/latest/download/latest.json`.

Установленная вручную сборка обновляется при запуске (тихо) или по клику по
версии в статусной строке. У пользователей версии ≤ 0.1.3 автообновления нет —
им нужен ручной переход на 0.1.4+.

## Локальная проверка без публикации

```bash
export PATH="$HOME/.cargo/bin:$PATH"
TAURI_SIGNING_PRIVATE_KEY="$(cat src-tauri/keys/prosa-updater.key)" npx tauri build
node scripts/make-updater-json.mjs v0.1.4   # сгенерирует latest.json и распечатает URL
```
