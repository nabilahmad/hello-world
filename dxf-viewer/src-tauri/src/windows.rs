//! Creating windows and routing opened files to them.

use std::path::PathBuf;

use serde::Serialize;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

use crate::state::{AppState, DocPayload, WinState};

const DEFAULT_SIZE: (f64, f64) = (1100.0, 760.0);
/// Offset between cascaded windows, physical pixels.
const CASCADE: i32 = 36;

/// Payload of the `docs-adopt` event: documents to add as tabs.
#[derive(Clone, Serialize)]
pub struct AdoptEvent {
    pub docs: Vec<DocPayload>,
    /// Drop position in CSS pixels (tabs dragged in from another window).
    pub x: Option<f64>,
    /// Explicit tab index (a cancelled detach goes back where it came from).
    pub index: Option<usize>,
}

pub struct NewWindow {
    pub docs: Vec<u64>,
    pub position: Option<PhysicalPosition<i32>>,
    /// Inner size in logical pixels.
    pub size: Option<(f64, f64)>,
    pub focus: bool,
    pub on_top: bool,
}

impl NewWindow {
    pub fn with_docs(docs: Vec<u64>) -> Self {
        NewWindow {
            docs,
            position: None,
            size: None,
            focus: true,
            on_top: false,
        }
    }
}

pub fn create_window(app: &AppHandle, opts: NewWindow) -> tauri::Result<WebviewWindow> {
    let state = app.state::<AppState>();
    let label = {
        let mut s = state.lock();
        let label = s.new_window_label();
        s.windows.insert(
            label.clone(),
            WinState {
                docs: opts.docs.clone(),
                strip: None,
            },
        );
        if opts.focus {
            s.touch(&label);
        }
        label
    };
    let (w, h) = opts.size.unwrap_or(DEFAULT_SIZE);
    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("DXF Viewer")
        .inner_size(w, h)
        .min_inner_size(420.0, 300.0)
        .focused(opts.focus)
        .always_on_top(opts.on_top)
        .visible(false);
    let window = match builder.build() {
        Ok(w) => w,
        Err(e) => {
            state.lock().windows.remove(&label);
            return Err(e);
        }
    };
    if let Some(p) = opts.position {
        let _ = window.set_position(p);
    }
    window.show()?;
    if opts.focus {
        let _ = window.set_focus();
    }
    Ok(window)
}

/// Adds documents to a window and tells its frontend to show them.
///
/// The documents are recorded in the window's state first, so a window whose
/// page is still loading picks them up from `window_init` instead.
pub fn adopt_into(
    app: &AppHandle,
    label: &str,
    ids: Vec<u64>,
    x: Option<f64>,
    index: Option<usize>,
) {
    let event = {
        let state = app.state::<AppState>();
        let mut s = state.lock();
        let Some(w) = s.windows.get_mut(label) else {
            return;
        };
        w.docs.retain(|d| !ids.contains(d));
        let at = index.unwrap_or(w.docs.len()).min(w.docs.len());
        w.docs.splice(at..at, ids.iter().copied());
        AdoptEvent {
            docs: s.payloads(&ids),
            x,
            index,
        }
    };
    let _ = app.emit_to(label, "docs-adopt", event);
}

/// Opens each file in its own window. The first file reuses an empty window
/// (the one the Open dialog was used from, or the start-up window) if any.
pub fn open_in_windows(app: &AppHandle, paths: Vec<PathBuf>, from: Option<&str>) {
    let paths: Vec<PathBuf> = paths.into_iter().filter(|p| p.is_file()).collect();
    if paths.is_empty() {
        return;
    }
    let (reuse, ids) = {
        let state = app.state::<AppState>();
        let mut s = state.lock();
        let reuse = from
            .filter(|l| s.windows.get(*l).is_some_and(|w| w.docs.is_empty()))
            .map(String::from)
            .or_else(|| s.empty_windows().into_iter().next());
        let ids: Vec<u64> = paths.into_iter().map(|p| s.add_doc(p)).collect();
        (reuse, ids)
    };
    let mut rest = &ids[..];
    if let Some(label) = reuse {
        if let Some(w) = app.get_webview_window(&label) {
            adopt_into(app, &label, vec![rest[0]], None, None);
            rest = &rest[1..];
            let _ = w.set_focus();
        }
    }
    let base = from
        .and_then(|l| app.get_webview_window(l))
        .and_then(|w| w.outer_position().ok());
    for (i, id) in rest.iter().enumerate() {
        let k = CASCADE * (i as i32 + 1);
        let position = base.map(|p| PhysicalPosition::new(p.x + k, p.y + k));
        if let Err(e) = create_window(
            app,
            NewWindow {
                position,
                ..NewWindow::with_docs(vec![*id])
            },
        ) {
            eprintln!("failed to open window: {e}");
        }
    }
}

/// Opens files as tabs of an existing window (files dropped onto it).
pub fn open_in_window(app: &AppHandle, label: &str, paths: Vec<PathBuf>) {
    let ids: Vec<u64> = {
        let state = app.state::<AppState>();
        let mut s = state.lock();
        paths
            .into_iter()
            .filter(|p| p.is_file())
            .map(|p| s.add_doc(p))
            .collect()
    };
    if !ids.is_empty() {
        adopt_into(app, label, ids, None, None);
    }
}

/// Command-line / single-instance arguments → existing file paths.
pub fn file_args(args: impl IntoIterator<Item = String>, cwd: Option<PathBuf>) -> Vec<PathBuf> {
    args.into_iter()
        .filter(|a| !a.starts_with('-'))
        .map(|a| {
            let p = PathBuf::from(&a);
            match (&cwd, p.is_relative()) {
                (Some(dir), true) => dir.join(p),
                _ => p,
            }
        })
        .filter(|p| p.is_file())
        .collect()
}
