use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU32, Ordering},
        Mutex,
    },
};

use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

// the native menu bar is macOS-only (#104) — see the module docs for why
// Windows and Linux never build one
#[cfg(target_os = "macos")]
mod menu;

// printing commands (#24): system sheet on macOS/Linux, silent WebView2
// PDF on Windows
mod print;

// #114: macOS WebKit channel watchdog — detects the dead UI↔WebContent
// link by the frontend's silence and recreates the webview
mod watchdog;

/// First non-flag CLI argument — the file Windows/shell passes when the user
/// double-clicks a document associated with Prosa (cold start).
#[tauri::command]
fn get_initial_file() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|arg| !arg.starts_with('-') && !arg.starts_with("--"))
}

/// Live document state of every open window, reported by the frontend via
/// `report_doc_state`. The Rust side uses it to route newly opened files:
/// focus the window already showing the file, reuse a pristine window, or
/// spawn a new document window.
#[derive(Default)]
struct Docs(Mutex<HashMap<String, DocState>>);

#[derive(Clone)]
struct DocState {
    path: Option<String>,
    dirty: bool,
    empty: bool,
}

#[tauri::command]
fn report_doc_state(
    window: tauri::WebviewWindow,
    state: tauri::State<Docs>,
    watchdog: tauri::State<watchdog::Watchdog>,
    path: Option<String>,
    dirty: bool,
    empty: bool,
) {
    state
        .0
        .lock()
        .unwrap()
        .insert(window.label().to_string(), DocState { path, dirty, empty });
    // #114: a clean state means the file on disk is the truth — a stale
    // pre-save draft must not be restored over it by a later recovery
    if !dirty {
        watchdog.clear_draft(window.label());
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
// the stored language is only consulted on macOS (the only platform with a
// native menu); elsewhere the state just keeps the command shape uniform.
// Starts as "ru" — the same bar setup() installs, so the first report of a
// Russian UI does not rebuild the menu for nothing.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
struct MenuLang(std::sync::Mutex<String>);

impl MenuLang {
    fn new() -> Self {
        Self(std::sync::Mutex::new("ru".to_string()))
    }
}

#[tauri::command]
fn set_menu_language(app: AppHandle, state: tauri::State<MenuLang>, lang: String) {
    #[cfg(target_os = "macos")]
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
    #[cfg(not(target_os = "macos"))]
    let _ = (&app, &state, &lang);
}

fn is_markdown(path: &str) -> bool {
    path.rsplit_once('.').is_some_and(|(_, ext)| {
        ["md", "markdown", "mdown", "mkd", "txt"].contains(&ext.to_lowercase().as_str())
    })
}

/// Focus the window already showing `path` (a file may only be open once —
/// two windows editing one file would overwrite each other on save).
fn focus_existing(app: &AppHandle, state: &Docs, path: &str) -> Option<()> {
    let label = state
        .0
        .lock()
        .unwrap()
        .iter()
        .find(|(_, doc)| doc.path.as_deref() == Some(path))
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
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
struct Geometry {
    position: Option<(f64, f64)>,
    size: Option<(f64, f64)>,
    maximized: bool,
    fullscreen: bool,
}

/// One document per window: every window is an isolated editor instance, so
/// window state never has to be shared. An empty `path` opens a fresh
/// untitled document (#60): no `?file=` query, the frontend boots into the
/// empty state.
fn create_doc_window(app: &AppHandle, path: &str) -> tauri::Result<()> {
    build_doc_window(app, path, None, None)
}

/// Shared window factory: the normal path takes the defaults, the watchdog
/// (#114) passes the dead window's geometry and a recovery draft stashed
/// for the new label before its frontend can ask for it.
fn build_doc_window(
    app: &AppHandle,
    path: &str,
    geometry: Option<Geometry>,
    recovery: Option<watchdog::Recovery>,
) -> tauri::Result<()> {
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
    if let Some(recovery) = recovery {
        app.state::<watchdog::Watchdog>()
            .stash_recovery(&label, recovery);
    }
    // only the Windows focus dance below consumes the handle; every other
    // platform drops it right away
    #[cfg_attr(not(windows), allow(unused_variables))]
    let window = builder.build()?;
    // #114: the watchdog judges this window's frontend from its birth
    app.state::<watchdog::Watchdog>().register(&label);
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
    Ok(())
}

/// Open a file as a new document window (or focus the window already showing
/// it). Called by a window whose own document is occupied.
// async: WebviewWindowBuilder::build() deadlocks on Windows when called from
// a synchronous command (known Webview2 issue)
#[tauri::command]
async fn open_document_window(
    app: AppHandle,
    state: tauri::State<'_, Docs>,
    path: String,
) -> Result<(), String> {
    if focus_existing(&app, state.inner(), &path).is_some() {
        return Ok(());
    }
    create_doc_window(&app, &path).map_err(|err| err.to_string())
}

/// Route a file opened outside any window (second app instance): focus the
/// window already showing it, else load it into a pristine window, else
/// create a new one.
fn open_doc_external(app: &AppHandle, state: &Docs, path: &str) {
    if focus_existing(app, state, path).is_some() {
        return;
    }
    let pristine_label = state
        .0
        .lock()
        .unwrap()
        .iter()
        .find(|(_, doc)| doc.path.is_none() && !doc.dirty && doc.empty)
        .map(|(label, _)| label.clone());
    if let Some(label) = pristine_label {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .manage(Docs::default())
        .manage(MenuLang::new())
        .manage(watchdog::Watchdog::default())
        .setup(|app| {
            // the main window starts hidden (visible: false in the config,
            // #34) — if its frontend never calls show(), reveal it anyway
            show_fallback(app.handle(), std::time::Duration::from_secs(3));
            // #114: the config-created main window is judged by the
            // watchdog like every window built later
            for label in app.webview_windows().keys() {
                app.state::<watchdog::Watchdog>().register(label);
            }
            #[cfg(target_os = "macos")]
            watchdog::spawn_checker(app.handle().clone());
            // Russian until the frontend reports the resolved UI language
            #[cfg(target_os = "macos")]
            if let Err(err) = menu::install(app.handle(), "ru") {
                eprintln!("prosa: failed to build the native menu: {err}");
            }
            Ok(())
        })
        // the only native item with an in-app action: "Settings…" opens the
        // same dialog as Ctrl+, in the focused window
        .on_menu_event(|app, event| {
            #[cfg(target_os = "macos")]
            if event.id().as_ref() == menu::SETTINGS_ID {
                menu::emit_settings(app);
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        })
        // drop document state of closed windows
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::Destroyed) {
                let label = window.label().to_string();
                let app = window.app_handle();
                app.state::<Docs>().0.lock().unwrap().remove(&label);
                // #114: the watchdog no longer watches the dead label —
                // its replacement registered under a fresh one
                app.state::<watchdog::Watchdog>().unregister(&label);
            }
        });

    // A second instance routes here: a markdown argument (double-clicked
    // document) opens in a window; a plain relaunch — taskbar icon, Start
    // menu shortcut — opens a fresh empty window (#60, owner decision
    // 2026-10-06: the "every file gets its own window" model gives every
    // launch click its own window too).
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(
        |app, args, _cwd| {
            // spawn off the main thread: creating a webview window from
            // inside the message loop deadlocks on Windows (Webview2)
            let handle = app.clone();
            let path = args.into_iter().nth(1).filter(|p| is_markdown(p));
            tauri::async_runtime::spawn(async move {
                match path {
                    Some(path) => {
                        let state = handle.state::<Docs>();
                        open_doc_external(&handle, state.inner(), &path);
                    }
                    None => {
                        if let Err(err) = create_doc_window(&handle, "") {
                            eprintln!("prosa: failed to open new window: {err}");
                        }
                    }
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
            get_initial_file,
            report_doc_state,
            has_dirty_windows,
            open_document_window,
            set_menu_language,
            is_updater_install,
            print::print_document,
            print::print_to_pdf,
            watchdog::watchdog_pong,
            watchdog::watchdog_draft,
            watchdog::pop_recovery
        ])
        .run(tauri::generate_context!())
        .expect("error while running prosa");
}
