use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU32, Ordering},
        Mutex,
    },
};

use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

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

struct DocState {
    path: Option<String>,
    dirty: bool,
    empty: bool,
}

#[tauri::command]
fn report_doc_state(
    window: tauri::WebviewWindow,
    state: tauri::State<Docs>,
    path: Option<String>,
    dirty: bool,
    empty: bool,
) {
    state
        .0
        .lock()
        .unwrap()
        .insert(window.label().to_string(), DocState { path, dirty, empty });
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

/// One document per window: every window is an isolated editor instance, so
/// window state never has to be shared.
fn create_doc_window(app: &AppHandle, path: &str) -> tauri::Result<()> {
    static COUNTER: AtomicU32 = AtomicU32::new(1);
    let label = format!("doc-{}", COUNTER.fetch_add(1, Ordering::Relaxed));
    let encoded = utf8_percent_encode(path, NON_ALPHANUMERIC).to_string();
    let builder = WebviewWindowBuilder::new(
        app,
        &label,
        WebviewUrl::App(format!("index.html?file={encoded}").into()),
    )
    .title("ProsaMD")
    .inner_size(1100.0, 780.0)
    .min_inner_size(520.0, 400.0)
    // hidden until the frontend painted its first real frame (#34): an
    // immediately visible window flashes white, then an empty shell
    .visible(false);
    // Tauri's native drag-drop handler must stay off for in-page HTML5
    // drag-and-drop (block handles) — same as the main window config
    #[cfg(windows)]
    let builder = builder.drag_and_drop(false);
    let window = builder.build()?;
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
        .setup(|app| {
            // the main window starts hidden (visible: false in the config,
            // #34) — if its frontend never calls show(), reveal it anyway
            show_fallback(app.handle(), std::time::Duration::from_secs(3));
            Ok(())
        })
        // drop document state of closed windows
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::Destroyed) {
                window
                    .app_handle()
                    .state::<Docs>()
                    .0
                    .lock()
                    .unwrap()
                    .remove(window.label());
            }
        });

    // When a second instance is launched with a file argument (e.g. the user
    // double-clicks another .md while Prosa is running), route the file to
    // this instance and exit.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(
        |app, args, _cwd| {
            if let Some(path) = args.into_iter().nth(1).filter(|p| is_markdown(p)) {
                // spawn off the main thread: creating a webview window from
                // inside the message loop deadlocks on Windows (Webview2)
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    let state = handle.state::<Docs>();
                    open_doc_external(&handle, state.inner(), &path);
                });
            }
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
            open_document_window
        ])
        .run(tauri::generate_context!())
        .expect("error while running prosa");
}
