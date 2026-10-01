use tauri::{Emitter, Manager};

/// First non-flag CLI argument — the file Windows/shell passes when the user
/// double-clicks a document associated with Prosa (cold start).
#[tauri::command]
fn get_initial_file() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|arg| !arg.starts_with('-') && !arg.starts_with("--"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // When a second instance is launched with a file argument (e.g. the user
    // double-clicks another .md while Prosa is running), forward the path to
    // the existing instance and exit.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(
        |app, args, _cwd| {
            if let Some(path) = args.into_iter().nth(1) {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit("prosa://open-file", path);
                }
            }
        }
    ));

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![get_initial_file])
        .run(tauri::generate_context!())
        .expect("error while running prosa");
}
