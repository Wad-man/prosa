//! Native macOS menu bar (#104). ProsaMD's own menu lives inside the window
//! (#20) and stays there on every platform; on macOS the system menu bar is
//! still expected to exist — it owns the Cmd-shortcut machinery (Quit, Hide
//! and the Edit clipboard commands WKWebView needs to receive Cmd+C/X/V/Z/A)
//! that an in-window menu cannot hook into. Windows and Linux never build
//! it (variant (а) of #104: app menu + Edit + Window, no mirror of the six
//! in-window sections).

use tauri::menu::{Menu, MenuBuilder, MenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager};

/// Id of the only custom item — routes "Settings…" back into the webview.
pub const SETTINGS_ID: &str = "prosa.settings";
/// Event sent to the focused window when a native item maps onto an in-app
/// dialog (payload: "settings").
pub const MENU_EVENT: &str = "prosa://menu";

struct Texts {
    about: &'static str,
    settings: &'static str,
    services: &'static str,
    hide: &'static str,
    hide_others: &'static str,
    show_all: &'static str,
    quit: &'static str,
    edit: &'static str,
    undo: &'static str,
    redo: &'static str,
    cut: &'static str,
    copy: &'static str,
    paste: &'static str,
    select_all: &'static str,
    window: &'static str,
    minimize: &'static str,
    close_window: &'static str,
}

fn texts(lang: &str) -> Texts {
    if lang.starts_with("ru") {
        Texts {
            about: "О программе ProsaMD",
            settings: "Настройки…",
            services: "Службы",
            hide: "Скрыть ProsaMD",
            hide_others: "Скрыть остальные",
            show_all: "Показать все",
            quit: "Завершить ProsaMD",
            edit: "Правка",
            undo: "Отменить",
            redo: "Повторить",
            cut: "Вырезать",
            copy: "Скопировать",
            paste: "Вставить",
            select_all: "Выбрать все",
            window: "Окно",
            minimize: "Свернуть",
            close_window: "Закрыть окно",
        }
    } else {
        Texts {
            about: "About ProsaMD",
            settings: "Settings…",
            services: "Services",
            hide: "Hide ProsaMD",
            hide_others: "Hide Others",
            show_all: "Show All",
            quit: "Quit ProsaMD",
            edit: "Edit",
            undo: "Undo",
            redo: "Redo",
            cut: "Cut",
            copy: "Copy",
            paste: "Paste",
            select_all: "Select All",
            window: "Window",
            minimize: "Minimize",
            close_window: "Close Window",
        }
    }
}

/// Build and install the menu bar for `lang` (two-letter i18n code such as
/// "ru"/"en"). Rebuilding wholesale is the only way to re-localize — muda
/// items cannot swap their accelerator-bound role, and item texts created by
/// the predefined builders are baked in. The bar is global: it shows the
/// language of whichever window reported last (accepted — per-window UI
/// languages in one app instance are exotic).
pub fn install(app: &AppHandle, lang: &str) -> tauri::Result<()> {
    let t = texts(lang);
    // "Settings…" opens the same in-app dialog as Ctrl+, — the native item is
    // a shortcut to it, not a second settings surface.
    let settings =
        MenuItem::with_id(app, SETTINGS_ID, t.settings, true, Some("CmdOrCtrl+,"))?;
    let app_menu = SubmenuBuilder::new(app, "ProsaMD")
        .about_with_text(t.about, None)
        .separator()
        .item(&settings)
        .separator()
        .services_with_text(t.services)
        .hide_with_text(t.hide)
        .hide_others_with_text(t.hide_others)
        .show_all_with_text(t.show_all)
        .separator()
        .quit_with_text(t.quit)
        .build()?;
    let edit = SubmenuBuilder::new(app, t.edit)
        .undo_with_text(t.undo)
        .redo_with_text(t.redo)
        .separator()
        .cut_with_text(t.cut)
        .copy_with_text(t.copy)
        .paste_with_text(t.paste)
        .select_all_with_text(t.select_all)
        .build()?;
    let window = SubmenuBuilder::new(app, t.window)
        .minimize_with_text(t.minimize)
        .close_window_with_text(t.close_window)
        .build()?;
    let menu: Menu<tauri::Wry> = MenuBuilder::new(app)
        .item(&app_menu)
        .item(&edit)
        .item(&window)
        .build()?;
    app.set_menu(menu)?;
    // register as the NSApp windows menu — AFTER set_menu: the muda lookup
    // reads NSApp.mainMenu() and finds the new submenu only once it is the
    // main menu (called earlier it silently no-ops). macOS then lists every
    // open document window here automatically (one window per document).
    window.set_as_windows_menu_for_nsapp()?;
    Ok(())
}

/// Deliver a custom menu item activation to the focused document window —
/// every window is an isolated editor, so only one may open the dialog.
pub fn emit_settings(app: &AppHandle) {
    if let Some(window) = app.get_focused_window() {
        let _ = app.emit_to(window.label(), MENU_EVENT, "settings");
    }
}
