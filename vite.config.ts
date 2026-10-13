import { defineConfig } from "vite";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({

  // Vue ships as a transitive dependency of Milkdown (Crepe); defining its
  // feature flags silences the runtime warning and trims the prod bundle
  define: {
    __VUE_OPTIONS_API__: true,
    __VUE_PROD_DEVTOOLS__: false,
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false,
  },

  // Explicit floor (#103): Vite's default baseline (~Safari 16.4) drops
  // unpatched Monterey boxes (WKWebView Safari 15). Syntax floor only —
  // milkdown builds lookbehind regexes at editor init, so the visual
  // editor still needs Safari 16.4+; the real #90 target class is an
  // up-to-date Monterey (Safari 17.6)
  build: {
    target: ["safari15", "chrome107"],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
