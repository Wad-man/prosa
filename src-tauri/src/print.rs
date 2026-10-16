//! Printing (#24 → #135). Three commands behind two menu entries:
//!
//! - `print_document` — macOS/Linux: the system print sheet
//!   (`WebviewWindow::print()`, wry drives NSPrintOperation on macOS and
//!   the webkit2gtk print dialog on Linux; both can save a PDF too).
//! - `print_to_pdf` — Windows «Сохранить в PDF…» (Ctrl+Shift+P): silent
//!   `ICoreWebView2_7::PrintToPdf` with no print dialog; the frontend
//!   hands over the path from a Save dialog. Settings: A4 portrait,
//!   2 cm margins, backgrounds on, no header/footer. The completion is
//!   reported back over a channel, so the command thread never pumps the
//!   main-thread message loop.
//! - `show_print_ui` — Windows «Печать…» (Ctrl+P, #135): the browser-style
//!   print dialog (printer picker, preview) over the same @media print
//!   CSS — the print copy in #print-root.
//!
//! The approach (hidden #print-root re-rendered from the source, silent
//! WebView2 PDF) follows Markpad 2.8.4 (BSD-3, © 2023 Alec Ames) as
//! recorded by the scout in RESEARCH-MDVIEW-MARKPAD-2026-10-12.md; the
//! code below is written against the same COM API surface.

use std::sync::mpsc;

#[tauri::command]
pub fn print_document(window: tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        window.print().map_err(|e| e.to_string())
    }
    #[cfg(windows)]
    {
        let _ = window;
        Err("silent PDF is used on Windows".into())
    }
}

#[tauri::command]
pub async fn print_to_pdf(window: tauri::WebviewWindow, path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::time::Duration;
        use webview2_com::{
            Microsoft::Web::WebView2::Win32::{ICoreWebView2Environment6, ICoreWebView2_7},
            PrintToPdfCompletedHandler,
        };
        use windows_core::{HSTRING, Interface};

        let (sender, receiver) = mpsc::sync_channel(1);
        window
            .with_webview(move |platform_webview| unsafe {
                let result = (|| -> Result<(), String> {
                    let controller = platform_webview.controller();
                    let webview = controller
                        .CoreWebView2()
                        .map_err(|e| format!("failed to access WebView2: {e}"))?
                        .cast::<ICoreWebView2_7>()
                        .map_err(|e| format!("WebView2 runtime cannot print: {e}"))?;
                    let settings = platform_webview
                        .environment()
                        .cast::<ICoreWebView2Environment6>()
                        .map_err(|e| format!("WebView2 runtime has no print settings: {e}"))?
                        .CreatePrintSettings()
                        .map_err(|e| format!("failed to create print settings: {e}"))?;

                    // A4 portrait, 2 cm margins, paper-true colors, clean
                    // edges (the page geometry is set here, not in @page —
                    // CSS margins would double with the COM ones)
                    settings.SetPageWidth(8.2677) // 210 mm
                        .map_err(|e| format!("failed to apply print settings: {e}"))?;
                    settings.SetPageHeight(11.6929) // 297 mm
                        .map_err(|e| format!("failed to apply print settings: {e}"))?;
                    settings.SetMarginTop(0.7874) // 20 mm
                        .map_err(|e| format!("failed to apply print settings: {e}"))?;
                    settings.SetMarginBottom(0.7874)
                        .map_err(|e| format!("failed to apply print settings: {e}"))?;
                    settings.SetMarginLeft(0.7874)
                        .map_err(|e| format!("failed to apply print settings: {e}"))?;
                    settings.SetMarginRight(0.7874)
                        .map_err(|e| format!("failed to apply print settings: {e}"))?;
                    settings
                        .SetShouldPrintBackgrounds(true)
                        .map_err(|e| format!("failed to enable backgrounds: {e}"))?;
                    settings
                        .SetShouldPrintHeaderAndFooter(false)
                        .map_err(|e| format!("failed to disable headers: {e}"))?;

                    let callback_sender = sender.clone();
                    let completion =
                        PrintToPdfCompletedHandler::create(Box::new(move |status, succeeded| {
                            let result = status
                                .map_err(|e| format!("PDF export failed: {e}"))
                                .and_then(|_| {
                                    if succeeded {
                                        Ok(())
                                    } else {
                                        Err("WebView2 did not create the PDF file".to_string())
                                    }
                                });
                            let _ = callback_sender.try_send(result);
                            Ok(())
                        }));

                    webview
                        .PrintToPdf(&HSTRING::from(path.as_str()), &settings, &completion)
                        .map_err(|e| format!("could not start PDF export: {e}"))
                })();

                if let Err(error) = result {
                    // try_send: a second write must never block the UI
                    // thread the closure runs on (review M6)
                    let _ = sender.try_send(Err(error));
                }
            })
            .map_err(|e| format!("failed to schedule PDF export: {e}"))?;

        tauri::async_runtime::spawn_blocking(move || {
            receiver.recv_timeout(Duration::from_secs(120))
        })
        .await
        .map_err(|e| format!("PDF export task failed: {e}"))?
        .map_err(|e| match e {
            std::sync::mpsc::RecvTimeoutError::Timeout => {
                "the PDF export did not finish within 120 s".to_string()
            }
            std::sync::mpsc::RecvTimeoutError::Disconnected => {
                "the print worker dropped the result".to_string()
            }
        })?
    }
    #[cfg(not(windows))]
    {
        let _ = (window, path);
        Err("silent PDF export is only available on Windows".into())
    }
}

/// #135: the real print dialog on Windows — the browser-style print
/// preview (printer picker, page range, copies; the same UI Edge's Ctrl+P
/// opens) printing whatever the @media print CSS shows, i.e. the print
/// copy the frontend prepared in #print-root. macOS/Linux keep their
/// system print sheet (`print_document`).
#[tauri::command]
pub async fn show_print_ui(window: tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::time::Duration;
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            ICoreWebView2_16, COREWEBVIEW2_PRINT_DIALOG_KIND_BROWSER,
        };
        use windows_core::Interface;

        let (sender, receiver) = mpsc::sync_channel(1);
        window
            .with_webview(move |platform_webview| unsafe {
                // both outcomes travel the channel — a success that stays
                // unreported would turn into the timeout error below
                let result = (|| -> Result<(), String> {
                    let webview = platform_webview
                        .controller()
                        .CoreWebView2()
                        .map_err(|e| format!("failed to access WebView2: {e}"))?
                        .cast::<ICoreWebView2_16>()
                        .map_err(|e| format!("WebView2 runtime cannot print: {e}"))?;
                    webview
                        .ShowPrintUI(COREWEBVIEW2_PRINT_DIALOG_KIND_BROWSER)
                        .map_err(|e| format!("failed to open the print dialog: {e}"))
                })();
                let _ = sender.try_send(result);
            })
            .map_err(|e| format!("failed to schedule the print dialog: {e}"))?;

        tauri::async_runtime::spawn_blocking(move || {
            receiver.recv_timeout(Duration::from_secs(10))
        })
        .await
        .map_err(|e| format!("print dialog task failed: {e}"))?
        .map_err(|e| match e {
            std::sync::mpsc::RecvTimeoutError::Timeout => {
                "the print dialog did not open within 10 s".to_string()
            }
            std::sync::mpsc::RecvTimeoutError::Disconnected => {
                "the print worker dropped the result".to_string()
            }
        })?
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        Err("the system print sheet is used on this platform".into())
    }
}
