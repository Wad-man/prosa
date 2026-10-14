//! Recovery for the dead UI-process ↔ WebContent channel on macOS (#114).
//!
//! Monterey's WebKit 17.6 randomly severs the link between the app process
//! and the WebContent process (the WebKit 274818 family): mouse events and
//! IPC stop being delivered while both processes stay alive — and a related
//! mode corrupts module loading itself (white page, `SyntaxError`). The only
//! workaround confirmed upstream is recreating the WKWebView.
//!
//! The frontend pings `watchdog_pong` every couple of seconds. A visible,
//! focused window that stopped answering for `PING_DEAD_AFTER` — or one
//! whose frontend never answered within `BOOT_DEAD_AFTER`, the
//! corrupted-load mode — gets its webview recreated: a fresh window with
//! the dead one's geometry and a recovery draft of the document (pushed by
//! `watchdog_draft` while it was dirty), then the dead one is
//! force-destroyed. The channel cannot be probed from the Rust side; only
//! the frontend's silence is observable.
//!
//! The bookkeeping commands compile everywhere, but only macOS runs the
//! checker — Windows (WebView2) and Linux (webkit2gtk) have never shown
//! this failure, and their windows never ping.

use std::{
    collections::{HashMap, HashSet},
    sync::Mutex,
    time::Instant,
};

/// Document handed to a recreated window, consumed by `pop_recovery` after
/// the new frontend boots. `content` is the last dirty draft — fresher than
/// the file on disk, which the frontend has already loaded by then.
#[derive(serde::Serialize)]
pub struct Recovery {
    pub path: Option<String>,
    pub content: Option<String>,
}

#[derive(Default)]
pub struct Watchdog {
    /// last pong per label with the page's own visibility at that moment;
    /// an entry means the frontend booted far enough to start the heartbeat
    pongs: Mutex<HashMap<String, (Instant, bool)>>,
    /// window label → (creation time, the file the window was created
    /// with) — the time bounds the never-booted mode; the file is the
    /// recovery route of a white window that never got far enough to
    /// report its document
    created: Mutex<HashMap<String, (Instant, Option<String>)>>,
    /// last tick the window was seen unfocused — the focus grace below
    unfocused_since: Mutex<HashMap<String, Instant>>,
    /// dirty-document drafts per label, cleared when the window reports a
    /// clean state (a saved document recovers from disk, not from a stale
    /// pre-save draft)
    drafts: Mutex<HashMap<String, String>>,
    /// recovery payload waiting for the freshly created replacement window
    recovery: Mutex<HashMap<String, Recovery>>,
    /// timestamps of recent recoveries — the anti-storm budget (macOS
    /// checker only)
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    recoveries: Mutex<Vec<Instant>>,
    /// labels already reported as given up — the budget message must not
    /// repeat on every check tick while the window stays frozen
    gave_up: Mutex<HashSet<String>>,
}

impl Watchdog {
    pub fn register(&self, label: &str, path: Option<String>) {
        self.created
            .lock()
            .unwrap()
            .insert(label.to_string(), (Instant::now(), path));
    }

    pub fn unregister(&self, label: &str) {
        self.pongs.lock().unwrap().remove(label);
        self.created.lock().unwrap().remove(label);
        self.unfocused_since.lock().unwrap().remove(label);
        self.drafts.lock().unwrap().remove(label);
        self.gave_up.lock().unwrap().remove(label);
    }

    /// A clean `report_doc_state` invalidates any stored draft: the file on
    /// disk is now the truth, and restoring a pre-save draft over it would
    /// lose the save.
    pub fn clear_draft(&self, label: &str) {
        self.drafts.lock().unwrap().remove(label);
    }

    pub fn stash_recovery(&self, label: &str, recovery: Recovery) {
        self.recovery.lock().unwrap().insert(label.to_string(), recovery);
    }
}

/// The frontend heartbeat. async and off the main thread on purpose: a
/// synchronous command would run there and could meet the checker holding
/// a watchdog lock while itself waiting on a main-thread round-trip —
/// the classic mutual block (review BLOCK-1). `visible` carries the page's
/// own visibility: a page the system suspended (display sleep, occlusion,
/// another Space) cannot ping on schedule and says so instead of being
/// judged dead (review MAJOR-в).
#[tauri::command]
pub async fn watchdog_pong(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Watchdog>,
    visible: bool,
) -> Result<(), String> {
    state
        .pongs
        .lock()
        .unwrap()
        .insert(window.label().to_string(), (Instant::now(), visible));
    Ok(())
}

/// The frontend attaches the full text while its document is dirty (and
/// under `MAX_DRAFT_BYTES`); a pathological document must not turn the
/// two-second heartbeat into a megabyte-per-tick IPC stream — its recovery
/// falls back to the last save on disk.
#[tauri::command]
pub async fn watchdog_draft(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Watchdog>,
    content: String,
) -> Result<(), String> {
    const MAX_DRAFT_BYTES: usize = 1_000_000;
    let mut drafts = state.drafts.lock().unwrap();
    if content.len() <= MAX_DRAFT_BYTES {
        drafts.insert(window.label().to_string(), content);
    } else {
        // a refused oversized update must not leave an OLDER draft behind:
        // recovery then falls back to the last save on disk instead of
        // resurrecting stale text (review MAJOR-б)
        drafts.remove(window.label());
    }
    Ok(())
}

#[tauri::command]
pub fn pop_recovery(
    window: tauri::WebviewWindow,
    state: tauri::State<Watchdog>,
) -> Option<Recovery> {
    state.recovery.lock().unwrap().remove(window.label())
}

// ---------- macOS-only detection and recovery ----------

#[cfg(target_os = "macos")]
pub use checker::spawn as spawn_checker;

#[cfg(target_os = "macos")]
mod checker {
    use std::time::{Duration, Instant};

    use tauri::{AppHandle, Manager};

    use super::Watchdog;
    use crate::{build_doc_window, Geometry};

    /// How long a visible, focused window may stay silent after having
    /// answered at least once — five missed two-second pings, generous for
    /// timer jitter.
    const PING_DEAD_AFTER: Duration = Duration::from_secs(10);
    /// How long a window may live without a single pong — the
    /// corrupted-load white page where the app modules never parse.
    /// Generous for a slow first paint, short enough to heal within half a
    /// minute.
    const BOOT_DEAD_AFTER: Duration = Duration::from_secs(20);
    /// A freshly focused window gets this much grace before its silence
    /// counts: a healthy page resumes its throttled timers within a second
    /// of regaining focus, and recreating a merely napped window (draft and
    /// all) would be a false positive.
    const FOCUS_GRACE: Duration = Duration::from_secs(3);
    const CHECK_EVERY: Duration = Duration::from_secs(2);
    /// Recreations that don't take mean the session is systematically
    /// broken, not randomly glitched — stop flashing windows after this
    /// many recoveries inside the storm window.
    const STORM_LIMIT: usize = 3;
    const STORM_WINDOW: Duration = Duration::from_secs(120);

    pub fn spawn(app: AppHandle) {
        std::thread::spawn(move || loop {
            std::thread::sleep(CHECK_EVERY);
            check(&app);
        });
    }

    fn check(app: &AppHandle) {
        let watchdog = app.state::<Watchdog>();
        let now = Instant::now();

        // Pass 1 — no watchdog lock may be held here: visibility, minimize
        // and focus getters are synchronous round-trips to the main thread,
        // and holding a lock across one could block it against the pong
        // commands — the mutual block that froze whole sessions (review
        // BLOCK-1)
        let mut candidates = Vec::new();
        for (label, window) in app.webview_windows() {
            let engaged = window.is_visible().unwrap_or(false)
                && !window.is_minimized().unwrap_or(false)
                && window.is_focused().unwrap_or(false);
            candidates.push((label, engaged));
        }

        // Pass 2 — brief lock windows around plain map reads
        let mut dead = Vec::new();
        {
            let pongs = watchdog.pongs.lock().unwrap();
            let created = watchdog.created.lock().unwrap();
            let mut unfocused = watchdog.unfocused_since.lock().unwrap();
            for (label, engaged) in candidates {
                // hidden and minimized windows legitimately pause their
                // timers — and nobody is looking at a dead one until it is
                // visible and focused again, which re-arms this check
                if !engaged {
                    unfocused.insert(label, now);
                    continue;
                }
                // a page the system suspended (display sleep, occlusion,
                // another Space) throttles its timers while its window
                // keeps focus — it self-reports hidden with every pong and
                // is skipped until its visibilitychange ping says otherwise
                // (review MAJOR-в)
                if pongs
                    .get(&label)
                    .is_some_and(|(_, page_visible)| !page_visible)
                {
                    unfocused.insert(label, now);
                    continue;
                }
                // focus grace: a window focused less than FOCUS_GRACE ago
                // may simply not have fired its first resumed ping yet
                let past_grace = unfocused
                    .get(&label)
                    .is_none_or(|lost| now.duration_since(*lost) >= FOCUS_GRACE);
                let silent = match pongs.get(&label) {
                    Some((last, _)) => {
                        past_grace && now.duration_since(*last) > PING_DEAD_AFTER
                    }
                    // no pong ever: the white-page mode, judged from birth
                    None => created
                        .get(&label)
                        .is_some_and(|(born, _)| now.duration_since(*born) > BOOT_DEAD_AFTER),
                };
                if silent {
                    dead.push(label);
                }
            }
        }
        for label in dead {
            recover(app, &label);
        }
    }

    fn recover(app: &AppHandle, label: &str) {
        let watchdog = app.state::<Watchdog>();
        // a window the storm budget gave up on stays frozen for the rest of
        // the session — the storm window sliding past must not resume
        // flashing a systematically broken webview every couple of minutes
        if watchdog.gave_up.lock().unwrap().contains(label) {
            return;
        }

        let Some(old) = app.get_webview_window(label) else {
            return;
        };

        // document route: the last reported state, falling back to the file
        // the window was CREATED with — a white window never reported
        // anything and must still recover to its birth file, not to an
        // untitled document (review MAJOR-а)
        let doc = app.state::<crate::Docs>().0.lock().unwrap().get(label).cloned();
        let birth_path = watchdog
            .created
            .lock()
            .unwrap()
            .get(label)
            .and_then(|(_, path)| path.clone());
        let (path, dirty) = match &doc {
            Some(doc) => (doc.path.clone().or(birth_path), doc.dirty),
            None => (birth_path, false),
        };
        let draft = if dirty {
            watchdog.drafts.lock().unwrap().get(label).cloned()
        } else {
            None
        };

        {
            let mut recoveries = watchdog.recoveries.lock().unwrap();
            let cutoff = now_checked_sub(STORM_WINDOW);
            recoveries.retain(|t| *t > cutoff);
            if recoveries.len() >= STORM_LIMIT {
                let mut gave_up = watchdog.gave_up.lock().unwrap();
                if gave_up.insert(label.to_string()) {
                    eprintln!(
                        "prosa: watchdog recovery budget spent — {label} stays frozen \
                         (systematic WebKit failure this session, #114)"
                    );
                }
                return;
            }
        }

        // the replacement must land exactly where the frozen window was
        let scale = old.scale_factor().unwrap_or(1.0);
        let geometry = Geometry {
            position: old
                .outer_position()
                .ok()
                .map(|p| (p.x as f64 / scale, p.y as f64 / scale)),
            size: old
                .inner_size()
                .ok()
                .map(|s| (s.width as f64 / scale, s.height as f64 / scale)),
            maximized: old.is_maximized().unwrap_or(false),
            fullscreen: old.is_fullscreen().unwrap_or(false),
        };

        eprintln!(
            "prosa: watchdog recreating the webview of {label} \
             (dead UI↔WebContent channel, #114){}",
            if draft.is_some() {
                " with an unsaved draft"
            } else {
                ""
            }
        );

        // build before destroy: the app must never drop to zero windows
        // (all-windows-closed exits it), and the recovery stash is keyed by
        // the new label before its frontend can ask for it
        let had_draft = draft.is_some();
        let result = build_doc_window(
            app,
            path.as_deref().unwrap_or(""),
            Some(geometry),
            Some(super::Recovery {
                path: path.clone(),
                content: draft,
            }),
        );
        let new_label = match result {
            Ok(new_label) => new_label,
            Err(err) => {
                // a failed build eats no anti-storm budget — only an
                // actually recreated window counts (review MINOR)
                eprintln!("prosa: watchdog recovery failed: {err}");
                return;
            }
        };
        watchdog.recoveries.lock().unwrap().push(Instant::now());
        // preinsert the replacement's document state: until its frontend
        // reports, file routing must already see the file open in the NEW
        // window, or an external open flashes a duplicate window (review
        // MINOR)
        app.state::<crate::Docs>().0.lock().unwrap().insert(
            new_label,
            crate::DocState {
                path: path.clone(),
                dirty: had_draft,
                empty: false,
            },
        );
        // destroy, not close: close() waits for the dead frontend's
        // close-requested handler, which would never answer
        if let Err(err) = old.destroy() {
            eprintln!("prosa: failed to destroy the frozen window {label}: {err}");
        }
    }

    /// `Instant::now() - duration` panics near system sleep adjustments on
    /// some platforms; the checked form degrades to "now" instead.
    fn now_checked_sub(duration: Duration) -> Instant {
        Instant::now().checked_sub(duration).unwrap_or_else(Instant::now)
    }
}
