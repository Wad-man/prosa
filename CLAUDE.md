# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

ProsaMD: a minimal Markdown reader/editor built on Tauri 2 (Rust shell) + TypeScript. This directory is its own git repo (public `Wad-man/prosa`). In the maintainer's checkout it is nested inside a private workspace repo at `../`, so run git commands here (`git -C` or `cd` in), not from the parent. If `../AGENTS.md` exists, it holds process rules (task board, QA skills); read it for release/QA workflow context.

## Commands

Run from this directory.

```bash
npm install
npm run dev            # Vite only on :1420 (frontend in a browser, no native APIs)
npm run tauri dev      # full app with the Tauri shell
npx tsc                # typecheck (fast; the only automated check besides the build)
npm run build          # tsc + vite build -> dist/
npm run tauri build    # signed NSIS installer; needs Rust/MSVC and TAURI_SIGNING_PRIVATE_KEY
```

- There is no test suite and no linter. Correctness is checked by `tsc`, the build, and manual runs in dev mode.
- Rust commands need `export PATH="$HOME/.cargo/bin:$PATH"` in Git Bash.
- Before `tauri build` on Windows, stop any running `prosa.exe`, or the link fails with "os error 5".
- A background `npm run dev` started from a tool shell dies when the command ends. Use `scripts/dev-detached.cmd` for a server that must outlive the call. After CSS/TS edits Vite can serve stale modules; check the served file with curl and restart the process on port 1420 if needed.
- Browser-side checks of the WebView go through the CDP scripts in `scripts/` (`cdp-check.mjs`, `cdp-type-test.mjs`).
- Version lives in three files that must move together: `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` (plus `src-tauri/Cargo.lock`). Releases: tag `vX.Y.Z` triggers `.github/workflows/release.yml`, which creates a draft; RC releases must be published as prerelease. Full steps in `RELEASING.md`.

## Architecture

**Two processes, one frontend core.** `src/` is the TypeScript UI (bundled by Vite into `dist/`); `src-tauri/src/lib.rs` is the native shell. The frontend talks to Rust through `invoke` (`get_initial_file`, `report_doc_state`, `has_dirty_windows`, `open_document_window`) and to Tauri plugins for dialogs, fs, clipboard, opener, updater, and process. Commands are registered in `run()` in `lib.rs`.

**Multi-window, one document per window.** Each open file is a separate `doc-*` window created by `create_doc_window`. The Rust side keeps a `Docs` state that tracks which path is open where (`focus_existing` refocuses an already-open file instead of opening a duplicate) and each window's dirty state (`report_doc_state`, `has_dirty_windows` for the close-confirmation flow). The main window is hidden at start (`visible: false` in `tauri.conf.json`). Windows do not share state at runtime, so theme, language, and feature flags are read at window startup from `localStorage`.

**Three modes, two editors.** `src/main.ts` defines `Mode = 'reading' | 'visual' | 'source'` (cycled with `Ctrl+/`). Reading and visual share one `VisualEditor` instance (`src/editor/visual.ts`, Milkdown/Crepe on ProseMirror): switching between them only flips `editable`, and the document is never re-parsed. Source mode is `SourceEditor` (`src/editor/source.ts`, CodeMirror 6), created lazily on first switch. Any command (undo, selection, format, paste, block change, delete) has to be dispatched per mode. Find the `mode === 'visual' ? ... : mode === 'source' ? ...` pattern in `main.ts` (around lines 480–560) and mirror it for new commands. Formatting logic is split the same way: `src/editor/actions.ts` holds the shared `BlockId`/`MarkId` vocabulary, `md-source.ts` implements the source-mode edits on raw text, and the visual side goes through Crepe/ProseMirror.

**Lossless round-trip is the hardest invariant.** The visual mode re-serializes Markdown (table padding and similar), so opening and saving an untouched file must write the original bytes. `main.ts` tracks this with `frontMatter` (YAML carved out before Milkdown sees it, shown in a non-ProseMirror DOM element), `savedRaw` (exact bytes of the last load/save, written back verbatim when nothing was edited), `baseline` (serialized form after load/save; returning to it clears dirty), and `editedSinceSave`. Changes to load/save, dirty tracking, or mode switching must keep this passing. A file must not change byte-for-byte after open → save.

**Other modules.**
- `src/markdown-html.ts`: unified/remark pipeline used for HTML copy.
- `src/frontmatter.ts`: splits the YAML block off the document.
- `src/menu.ts`: the menu bar (File/Edit/Paragraph/Format/View/Help) and its Alt-key mnemonics.
- `src/toc.ts`: the table-of-contents panel, shown in both modes.
- `src/features.ts`: boolean feature flags for finished core features (currently `toc`). This is deliberately not a plugin system. Plugins are a future design (design notes live outside this repo).
- `src/i18n.ts` + `src/editor/crepe-locale.ts`: RU/EN strings. Every user-facing string needs both languages.
- `src/platform/webview2-dnd.ts`: workaround for HTML5 drag-and-drop in the WebView2 shell. It must run before the editors mount.
- `src/editor/image-assets.ts`: image path resolution relative to the open document.

**Design constraints that shape code decisions.** Minimal core, with additions preferred as plugins; a minimal look and no extra modes beyond the three above; a small binary and fast startup; RU/EN UI with light and dark themes. The `kit/GUIDELINES.md` brand rules apply to any visual change: the app follows palette C (owner decision 2026-10-10): one UI accent, ultramarine `#4600F9` / `#7885F7`; brand cinnabar `#D9452B` appears only in the mark. Take colors from the tokens at the top of `src/styles.css` (never raw hex in components), keep links underlined, pair status colors with an icon, and no gradients in the app. Typography values and their rationale are in `TYPOGRAPHY.md` and the `typography` section of `src/styles.css`.

**Updater and signing.** `tauri-plugin-updater` polls `releases/latest/download/latest.json` on startup. Packages are signed with the private key in `src-tauri/keys/prosa-updater.key` (gitignored) or the `TAURI_SIGNING_PRIVATE_KEY` secret. The build fails without it because `createUpdaterArtifacts` is on, so local `tauri build` needs the key in the environment. Do not publish a stable release that breaks the update path: `RELEASING.md` covers the incident procedure.

**CI** (`.github/workflows/ci.yml`, on push/PR to `main`): a Linux job runs `tsc` and `vite build`; a Windows job runs full `tauri build`. Keep both green. `audit.yml` and `social-posts.yml` are separate.
