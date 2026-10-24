use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU32, Ordering},
        Mutex,
    },
};

use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

// ProsaMD's macOS line lives in its own repository, prosa-mac (owner
// decision 2026-10-14, #121) — this tree builds Windows and Linux only.
// The mac-only modules below (native menu, watchdog checker) compile only
// under the `prosa_mac` cfg that prosa-mac's .cargo/config.toml sets; a
// plain macOS build of this repository stops here with a pointer instead
// of silently producing an unsupported app.
#[cfg(all(target_os = "macos", not(prosa_mac)))]
compile_error!(
    "ProsaMD for macOS is developed in its own repository: \
     https://github.com/Wad-man/prosa-mac (see issue #121)"
);

// the native menu bar belongs to the macOS line (#104) — compiled only in
// the prosa-mac fork; Windows and Linux never build one
#[cfg(prosa_mac)]
mod menu;

// printing commands (#24): system sheet on macOS/Linux, silent WebView2
// PDF on Windows
mod print;

// #114: macOS WebKit channel watchdog — detects the dead UI↔WebContent
// link by the frontend's silence and recreates the webview
mod watchdog;

/// The markdown files the OS passed on the command line. #146: a
/// multi-select open (several files selected in Explorer) passes several
/// arguments — the frontend gives the first one the pristine main window
/// and opens the rest as its tabs.
#[tauri::command]
fn get_initial_files() -> Vec<String> {
    std::env::args()
        .skip(1)
        .filter(|arg| !arg.starts_with('-') && !arg.starts_with("--") && is_markdown(arg))
        .collect()
}

/// Live document state of every open window, reported by the frontend via
/// `report_doc_state`. The Rust side uses it to route newly opened files:
/// focus the window already showing the file, hand it to the last focused
/// window as a new tab (#11), or spawn a new document window.
#[derive(Default)]
struct Docs(Mutex<HashMap<String, DocState>>);

#[derive(Clone)]
struct DocState {
    path: Option<String>,
    dirty: bool,
    /// #11: every file this window holds as a tab — dedup must see the
    /// background tabs, not just the active document
    paths: Vec<String>,
}

/// The label of the window that held focus last (#11 routing: a file
/// opened from the OS lands as a tab in the most recently focused window,
/// the Sublime/Notepad canon).
#[derive(Default)]
struct LastFocused(Mutex<Option<String>>);

/// Files routed in from second instances while no window's frontend has
/// reported yet — the cold multi-open race (#149): Explorer starts one
/// process per selected file, and the primary's first window is still
/// booting when the forwarded paths arrive. Docs is empty then, and
/// routing immediately would give every file its own window. The batch
/// parks here and flows into the routing once a window reports
/// (report_doc_state flushes it).
#[derive(Default)]
struct PendingExternal(Mutex<Vec<String>>);

#[tauri::command]
fn report_doc_state(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<Docs>,
    pending: tauri::State<PendingExternal>,
    watchdog: tauri::State<watchdog::Watchdog>,
    path: Option<String>,
    dirty: bool,
    paths: Vec<String>,
) {
    state.0.lock().unwrap().insert(
        window.label().to_string(),
        DocState {
            path,
            dirty,
            paths,
        },
    );
    // #114: a clean state means the file on disk is the truth — a stale
    // pre-save draft must not be restored over it by a later recovery
    if !dirty {
        watchdog.clear_draft(window.label());
    }
    // #149: this report is the readiness signal a parked multi-open batch
    // was waiting for — route it now. Spawned like the single-instance
    // handler: window creation must stay off this (command) thread.
    let parked: Vec<String> = std::mem::take(&mut *pending.0.lock().unwrap());
    if !parked.is_empty() {
        tauri::async_runtime::spawn(async move {
            for path in parked {
                open_doc_external(&app, app.state::<Docs>().inner(), &path);
            }
        });
    }
}

/// True when any window other than the calling one has unsaved changes —
/// the update installer force-closes the whole app.
#[tauri::command]
fn has_dirty_windows(window: tauri::WebviewWindow, state: tauri::State<Docs>) -> bool {
    state
        .0
        .lock()
        .unwrap()
        .iter()
        .any(|(label, doc)| *label != window.label() && doc.dirty)
}

/// True when this install can use the in-app updater. An AppImage launch
/// sets the APPIMAGE env var; a .deb install has none, and its update flow
/// would download the AppImage artifact just to die on install (updater
/// plugin detects the deb bundle and refuses the AppImage) — deb users
/// upgrade by installing the next package (#105 review MAJOR-2).
#[tauri::command]
fn is_updater_install() -> bool {
    if cfg!(target_os = "linux") {
        std::env::var_os("APPIMAGE").is_some()
    } else {
        true
    }
}

/// UI language of the native macOS menu bar. The frontend reports it right
/// after i18n resolves and on every change (#104); until then the bar starts
/// in Russian — the product's primary language, corrected within a moment.
// the stored language is only consulted where the native menu exists (the
// prosa-mac fork); elsewhere the state just keeps the command shape uniform.
// Starts as "ru" — the same bar setup() installs, so the first report of a
// Russian UI does not rebuild the menu for nothing.
#[cfg_attr(not(prosa_mac), allow(dead_code))]
struct MenuLang(std::sync::Mutex<String>);

impl MenuLang {
    fn new() -> Self {
        Self(std::sync::Mutex::new("ru".to_string()))
    }
}

#[tauri::command]
fn set_menu_language(app: AppHandle, state: tauri::State<MenuLang>, lang: String) {
    #[cfg(prosa_mac)]
    {
        let mut current = state.0.lock().unwrap();
        if *current != lang {
            *current = lang.clone();
            drop(current);
            if let Err(err) = menu::install(&app, &lang) {
                eprintln!("prosa: failed to rebuild the native menu: {err}");
            }
        }
    }
    // no native menu bar anywhere else — nothing to rebuild
    #[cfg(not(prosa_mac))]
    let _ = (&app, &state, &lang);
}

fn is_markdown(path: &str) -> bool {
    path.rsplit_once('.').is_some_and(|(_, ext)| {
        ["md", "markdown", "mdown", "mkd", "txt"].contains(&ext.to_lowercase().as_str())
    })
}

/// Focus the window already showing `path` (a file may only be open once —
/// two windows editing one file would overwrite each other on save). #11:
/// a background tab counts as "showing" too.
fn focus_existing(app: &AppHandle, state: &Docs, path: &str) -> Option<()> {
    let label = state
        .0
        .lock()
        .unwrap()
        .iter()
        .find(|(_, doc)| {
            doc.path.as_deref() == Some(path) || doc.paths.iter().any(|p| p == path)
        })
        .map(|(label, _)| label.clone())?;
    focus_window(app, &label)
}

fn focus_window(app: &AppHandle, label: &str) -> Option<()> {
    let window = app.get_webview_window(label)?;
    let _ = window.unminimize();
    let _ = window.set_focus();
    Some(())
}

/// Show every window that is still hidden because its frontend never got
/// far enough to call show() (crashed/slow JS) — a window must never stay
/// invisible forever. Runs once, a few seconds into the app's life.
fn show_fallback(app: &AppHandle, delay: std::time::Duration) {
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(delay);
        for window in handle.webview_windows().values() {
            let _ = window.show();
        }
    });
}

/// Window placement copied onto a watchdog replacement window (#114): the
/// healed window must land exactly where the frozen one was.
#[cfg_attr(not(prosa_mac), allow(dead_code))]
struct Geometry {
    position: Option<(f64, f64)>,
    size: Option<(f64, f64)>,
    maximized: bool,
    fullscreen: bool,
}

/// A new document window. Windows stay isolated editor instances (a
/// window's tabs are its own, #11 — state is never shared between
/// windows). An empty `path` opens a fresh untitled document (#60): no
/// `?file=` query, the frontend boots into the empty state.
fn create_doc_window(app: &AppHandle, path: &str) -> tauri::Result<()> {
    build_doc_window(app, path, None, None).map(|_| ())
}

/// Shared window factory: the normal path takes the defaults, the watchdog
/// (#114) passes the dead window's geometry and a recovery draft stashed
/// for the new label before its frontend can ask for it. Returns the new
/// window's label — the watchdog records the replacement's document state
/// under it right away.
fn build_doc_window(
    app: &AppHandle,
    path: &str,
    geometry: Option<Geometry>,
    recovery: Option<watchdog::Recovery>,
) -> tauri::Result<String> {
    static COUNTER: AtomicU32 = AtomicU32::new(1);
    let label = format!("doc-{}", COUNTER.fetch_add(1, Ordering::Relaxed));
    let query = if path.is_empty() {
        String::new()
    } else {
        format!("?file={}", utf8_percent_encode(path, NON_ALPHANUMERIC))
    };
    let builder = WebviewWindowBuilder::new(
        app,
        &label,
        WebviewUrl::App(format!("index.html{query}").into()),
    )
    .title("ProsaMD")
    .inner_size(1100.0, 780.0)
    .min_inner_size(520.0, 400.0)
    // hidden until the frontend painted its first real frame (#34): an
    // immediately visible window flashes white, then an empty shell
    .visible(false);
    let builder = match &geometry {
        Some(geo) => {
            let mut builder = builder;
            if let Some((x, y)) = geo.position {
                builder = builder.position(x, y);
            }
            if let Some((w, h)) = geo.size {
                builder = builder.inner_size(w, h);
            }
            if geo.maximized {
                builder = builder.maximized(true);
            }
            if geo.fullscreen {
                builder = builder.fullscreen(true);
            }
            builder
        }
        None => builder,
    };
    // Tauri's native drag-drop handler must stay off for in-page HTML5
    // drag-and-drop (block handles) — same as the main window config
    // (dragDropEnabled in tauri.conf.json). Windows-only: wry has no native
    // handler to disable on macOS (HTML5 drag-and-drop just works there),
    // and on Linux disabling it would kill OS file drops entirely.
    #[cfg(windows)]
    let builder = builder.drag_and_drop(false);
    // only the Windows focus dance below consumes the handle; every other
    // platform drops it right away
    #[cfg_attr(not(windows), allow(unused_variables))]
    let window = builder.build()?;
    // stash the recovery AFTER a successful build — a failed one would leak
    // the payload under a label that never exists (review MINOR)
    if let Some(recovery) = recovery {
        app.state::<watchdog::Watchdog>()
            .stash_recovery(&label, recovery);
    }
    // #114: the watchdog judges this window's frontend from its birth and
    // remembers the file it was created with — a white window that never
    // reports still recovers to that file (review MAJOR-а)
    app.state::<watchdog::Watchdog>()
        .register(&label, (!path.is_empty()).then(|| path.to_string()));
    show_fallback(app, std::time::Duration::from_secs(3));
    // Windows denies foreground to a window created by an already-running
    // background process: the document would open behind the user's current
    // app (issue #5). A brief topmost toggle forces the activation that
    // set_focus() alone cannot get. Dropping the topmost flag must not fail
    // silently — a window stuck on top of everything is worse than no focus.
    #[cfg(windows)]
    {
        let _ = window.set_always_on_top(true);
        let _ = window.set_focus();
        if let Err(err) = window.set_always_on_top(false) {
            eprintln!("prosa: failed to drop topmost flag on {label}: {err}");
        }
    }
    Ok(label)
}

/// Route a file opened outside any window (second app instance): focus the
/// window already showing it, else hand it to the last focused window as a
/// new tab via the frontend hook (#11 — the frontend applies the full
/// canon: pristine-slot replacement, dedup, tab), else create a new window.
/// #149: the frontend hook opens a TAB — a window never spawns another
/// window for a file, so a routed batch lands in one window.
fn open_doc_external(app: &AppHandle, state: &Docs, path: &str) {
    if focus_existing(app, state, path).is_some() {
        return;
    }
    // #11: the most recently focused window receives the file — the
    // frontend decides whether it replaces a pristine untitled document or
    // becomes a tab; no window has ever been focused (fresh boot race) —
    // fall back to any known window
    let fallback_label = state.0.lock().unwrap().keys().next().cloned();
    let label = app
        .state::<LastFocused>()
        .0
        .lock()
        .unwrap()
        .clone()
        .or(fallback_label);
    if let Some(label) = label {
        if let Some(window) = app.get_webview_window(&label) {
            let arg = serde_json::to_string(path).unwrap_or_default();
            if window
                .eval(&format!("window.__prosaOpen && window.__prosaOpen({arg})"))
                .is_ok()
            {
                let _ = window.unminimize();
                let _ = window.set_focus();
                return;
            }
        }
    }
    if let Err(err) = create_doc_window(app, path) {
        eprintln!("prosa: failed to open document window: {err}");
    }
}

/// The safety net for parked files (#149): if no window ever reports — a
/// dead frontend, the white-window failure — the batch would sit in the
/// queue forever. After a grace period each parked file gets its own
/// window after all: ugly, but a file the user opened must not vanish.
/// Plain thread like show_fallback; window creation from a non-main
/// thread, same constraint as the single-instance handler.
fn spawn_pending_failsafe(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(10));
        let parked = std::mem::take(&mut *handle.state::<PendingExternal>().0.lock().unwrap());
        if parked.is_empty() {
            return;
        }
        eprintln!(
            "prosa: no window reported for {}s, opening {} parked file(s) in new windows",
            10,
            parked.len()
        );
        for path in parked {
            if focus_existing(&handle, handle.state::<Docs>().inner(), &path).is_none() {
                if let Err(err) = create_doc_window(&handle, &path) {
                    eprintln!("prosa: failed to open document window: {err}");
                }
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .manage(Docs::default())
        .manage(LastFocused::default())
        .manage(PendingExternal::default())
        .manage(MenuLang::new())
        .manage(watchdog::Watchdog::default())
        .setup(|app| {
            // the main window starts hidden (visible: false in the config,
            // #34) — if its frontend never calls show(), reveal it anyway
            show_fallback(app.handle(), std::time::Duration::from_secs(3));
            // #114: the config-created main window is judged by the
            // watchdog like every window built later; its birth file is
            // the CLI argument a cold start was launched with — a white
            // main window must recover to the document the user opened
            for label in app.webview_windows().keys() {
                // #146: multi-select cold start — the watchdog's birth file
                // is the FIRST CLI document (what a white main window must
                // recover to)
                let birth = if label == "main" {
                    get_initial_files().into_iter().next()
                } else {
                    None
                };
                app.state::<watchdog::Watchdog>().register(label, birth);
            }
            #[cfg(prosa_mac)]
            watchdog::spawn_checker(app.handle().clone());
            // Russian until the frontend reports the resolved UI language
            #[cfg(prosa_mac)]
            if let Err(err) = menu::install(app.handle(), "ru") {
                eprintln!("prosa: failed to build the native menu: {err}");
            }
            Ok(())
        })
        // the only native item with an in-app action: "Settings…" opens the
        // same dialog as Ctrl+, in the focused window
        .on_menu_event(|app, event| {
            #[cfg(prosa_mac)]
            if event.id().as_ref() == menu::SETTINGS_ID {
                menu::emit_settings(app);
            }
            #[cfg(not(prosa_mac))]
            let _ = (app, event);
        })
        // drop document state of closed windows; #11: track the last
        // focused window for OS-file routing (a closed window obviously
        // stops being the routing target)
        .on_window_event(|window, event| {
            let label = window.label().to_string();
            match event {
                WindowEvent::Focused(true) => {
                    *window
                        .app_handle()
                        .state::<LastFocused>()
                        .0
                        .lock()
                        .unwrap() = Some(label.clone());
                }
                WindowEvent::Destroyed => {
                    let app = window.app_handle();
                    app.state::<Docs>().0.lock().unwrap().remove(&label);
                    let last_focused = app.state::<LastFocused>();
                    let mut last = last_focused.0.lock().unwrap();
                    if last.as_deref() == Some(label.as_str()) {
                        *last = None;
                    }
                    // #114: the watchdog no longer watches the dead label —
                    // its replacement registered under a fresh one
                    app.state::<watchdog::Watchdog>().unregister(&label);
                }
                _ => {}
            }
        });

    // A second instance routes here: markdown arguments (double-clicked or
    // multi-selected documents) open in a window; a plain relaunch —
    // taskbar icon, Start menu shortcut — opens a fresh empty window (#60,
    // owner decision 2026-10-06: the "every file gets its own window"
    // model gives every launch click its own window too). #146: EVERY
    // markdown argument routes — a multi-select Explorer open lands as a
    // batch of tabs in the last focused window (§11.7 canon). #149: on a
    // cold start the batch typically beats the first window's frontend —
    // park it until a window reports instead of spawning a window per
    // file.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(
        |app, args, _cwd| {
            // spawn off the main thread: creating a webview window from
            // inside the message loop deadlocks on Windows (Webview2)
            let handle = app.clone();
            let paths: Vec<String> = args.into_iter().skip(1).filter(|p| is_markdown(p)).collect();
            tauri::async_runtime::spawn(async move {
                if paths.is_empty() {
                    if let Err(err) = create_doc_window(&handle, "") {
                        eprintln!("prosa: failed to open new window: {err}");
                    }
                    return;
                }
                if handle.state::<Docs>().0.lock().unwrap().is_empty() {
                    let pending = handle.state::<PendingExternal>();
                    let mut queue = pending.0.lock().unwrap();
                    if queue.is_empty() {
                        spawn_pending_failsafe(&handle);
                    }
                    queue.extend(paths);
                    return;
                }
                let state = handle.state::<Docs>();
                for path in paths {
                    open_doc_external(&handle, state.inner(), &path);
                }
            });
        },
    ));

    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            get_initial_files,
            report_doc_state,
            has_dirty_windows,
            set_menu_language,
            is_updater_install,
            print::print_document,
            print::print_to_pdf,
            print::show_print_ui,
            watchdog::watchdog_pong,
            watchdog::watchdog_draft,
            watchdog::pop_recovery
        ])
        .run(tauri::generate_context!())
        .expect("error while running prosa");
}
