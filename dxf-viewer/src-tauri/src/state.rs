//! Shared application state: which documents exist and which window shows them.
//!
//! Lock discipline: never call window APIs (positions, sizes, create, close)
//! while holding the lock. From a non-main thread those calls block on the
//! main thread, which may itself be waiting for this lock in a window-event
//! handler.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

/// Pan/zoom state of a document view; travels with a tab between windows.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct ViewState {
    pub cx: f64,
    pub cy: f64,
    pub scale: f64,
}

/// A document as seen by the frontend.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DocPayload {
    pub id: u64,
    pub name: String,
    pub path: String,
    pub view: Option<ViewState>,
}

/// The vertical extent of a window's tab bar, in CSS pixels from the top of
/// its web content (the bar spans the full window width).
#[derive(Clone, Copy, Debug, Default, Deserialize)]
pub struct Rect {
    pub y: f64,
    pub height: f64,
}

pub struct Doc {
    pub name: String,
    pub path: PathBuf,
    pub view: Option<ViewState>,
}

#[derive(Default)]
pub struct WinState {
    /// Documents shown as tabs, in tab order.
    pub docs: Vec<u64>,
    /// The window's tab bar, reported by its frontend.
    pub strip: Option<Rect>,
}

/// An in-progress tab drag (see drag.rs).
pub struct Drag {
    /// Window whose web view captured the pointer.
    pub source: String,
    /// Window that follows the cursor.
    pub moving: String,
    pub doc: u64,
    /// The moving window was created by detaching a tab from `source`.
    pub created: bool,
    /// Tab index in `source` before a detach (to put it back on cancel).
    pub source_index: usize,
    /// Cursor minus the moving window's outer position, physical pixels.
    pub offset: (f64, f64),
    /// Moving window's position when the drag started.
    pub origin: (i32, i32),
    /// Drop zones of the other windows, most recently focused first.
    pub zones: Vec<Zone>,
    /// Window currently under the cursor, and the cursor x in its CSS pixels.
    pub target: Option<(String, f64)>,
}

/// Where a dragged tab can be dropped onto another window (physical pixels).
#[derive(Clone, Debug)]
pub struct Zone {
    pub label: String,
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    /// Bottom edge of the tab bar; the dragged window parks just below it.
    pub strip_bottom: f64,
    /// Top-left of the web content, for converting to CSS pixels.
    pub content_x: f64,
    pub scale: f64,
}

#[derive(Default)]
pub struct Inner {
    next_doc: u64,
    next_win: u64,
    pub docs: HashMap<u64, Doc>,
    pub windows: HashMap<String, WinState>,
    /// Window labels, most recently focused first (our best guess at z-order).
    pub mru: Vec<String>,
    pub drag: Option<Drag>,
}

impl Inner {
    pub fn add_doc(&mut self, path: PathBuf) -> u64 {
        self.next_doc += 1;
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string_lossy().into_owned());
        self.docs.insert(
            self.next_doc,
            Doc {
                name,
                path,
                view: None,
            },
        );
        self.next_doc
    }

    pub fn new_window_label(&mut self) -> String {
        self.next_win += 1;
        format!("w{}", self.next_win)
    }

    pub fn payload(&self, id: u64) -> Option<DocPayload> {
        self.docs.get(&id).map(|d| DocPayload {
            id,
            name: d.name.clone(),
            path: d.path.to_string_lossy().into_owned(),
            view: d.view,
        })
    }

    pub fn payloads(&self, ids: &[u64]) -> Vec<DocPayload> {
        ids.iter().filter_map(|id| self.payload(*id)).collect()
    }

    /// Detaches a document from whichever window holds it; returns (window, index).
    pub fn take_doc(&mut self, id: u64) -> Option<(String, usize)> {
        for (label, w) in self.windows.iter_mut() {
            if let Some(i) = w.docs.iter().position(|d| *d == id) {
                w.docs.remove(i);
                return Some((label.clone(), i));
            }
        }
        None
    }

    pub fn touch(&mut self, label: &str) {
        self.mru.retain(|l| l != label);
        self.mru.insert(0, label.to_string());
    }

    /// Windows without documents, most recently focused first.
    pub fn empty_windows(&self) -> Vec<String> {
        let mut out: Vec<String> = self
            .mru
            .iter()
            .filter(|l| self.windows.get(*l).is_some_and(|w| w.docs.is_empty()))
            .cloned()
            .collect();
        for (l, w) in &self.windows {
            if w.docs.is_empty() && !out.contains(l) {
                out.push(l.clone());
            }
        }
        out
    }
}

#[derive(Default)]
pub struct AppState(Mutex<Inner>);

impl AppState {
    pub fn lock(&self) -> MutexGuard<'_, Inner> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}
