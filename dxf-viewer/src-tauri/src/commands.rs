//! Commands called by the frontend (see src/host/tauri-host.ts).

use std::path::PathBuf;

use tauri::{AppHandle, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::state::{AppState, DocPayload, Rect};
use crate::windows::{adopt_into, create_window, open_in_windows, NewWindow};

/// Documents this window starts with.
#[tauri::command]
pub fn window_init(window: WebviewWindow, state: State<'_, AppState>) -> Vec<DocPayload> {
    let s = state.lock();
    s.windows
        .get(window.label())
        .map(|w| s.payloads(&w.docs))
        .unwrap_or_default()
}

/// Raw file contents; parsed in the page's worker.
#[tauri::command]
pub async fn read_doc(state: State<'_, AppState>, id: u64) -> Result<tauri::ipc::Response, String> {
    let path = state
        .lock()
        .docs
        .get(&id)
        .map(|d| d.path.clone())
        .ok_or_else(|| "The document is no longer open".to_string())?;
    let bytes = std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Open dialog: every picked file opens in its own window.
#[tauri::command]
pub async fn open_dialog(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    let picked = app
        .dialog()
        .file()
        .set_title("Open DXF drawings")
        .add_filter("DXF drawings", &["dxf", "DXF"])
        .add_filter("All files", &["*"])
        .set_parent(&window)
        .blocking_pick_files();
    let paths: Vec<PathBuf> = picked
        .unwrap_or_default()
        .into_iter()
        .filter_map(|f| f.into_path().ok())
        .collect();
    open_in_windows(&app, paths, Some(window.label()));
    Ok(())
}

/// A tab was closed. A window left without tabs closes too, unless it is the last one.
#[tauri::command]
pub fn close_doc(window: WebviewWindow, state: State<'_, AppState>, id: u64) {
    let close_window = {
        let mut s = state.lock();
        if let Some(w) = s.windows.get_mut(window.label()) {
            w.docs.retain(|d| *d != id);
        }
        s.docs.remove(&id);
        let empty = s
            .windows
            .get(window.label())
            .is_some_and(|w| w.docs.is_empty());
        empty && s.windows.len() > 1
    };
    if close_window {
        let _ = window.close();
    }
}

#[tauri::command]
pub fn report_layout(window: WebviewWindow, state: State<'_, AppState>, strip: Rect) {
    if let Some(w) = state.lock().windows.get_mut(window.label()) {
        w.strip = Some(strip);
    }
}

#[tauri::command]
pub fn reorder_docs(window: WebviewWindow, state: State<'_, AppState>, ids: Vec<u64>) {
    if let Some(w) = state.lock().windows.get_mut(window.label()) {
        let mut ordered: Vec<u64> = ids.into_iter().filter(|id| w.docs.contains(id)).collect();
        for id in &w.docs {
            if !ordered.contains(id) {
                ordered.push(*id);
            }
        }
        w.docs = ordered;
    }
}

/// Tab context menu: move the tab into a window of its own.
#[tauri::command]
pub async fn move_to_new_window(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    doc: DocPayload,
) -> Result<(), String> {
    {
        let mut s = state.lock();
        s.take_doc(doc.id);
        if let Some(d) = s.docs.get_mut(&doc.id) {
            d.view = doc.view;
        }
    }
    let scale = window.scale_factor().unwrap_or(1.0);
    let position = window
        .outer_position()
        .ok()
        .map(|p| tauri::PhysicalPosition::new(p.x + 40, p.y + 40));
    let size = window
        .inner_size()
        .ok()
        .map(|s| (s.width as f64 / scale, s.height as f64 / scale));
    create_window(
        &app,
        NewWindow {
            position,
            size,
            ..NewWindow::with_docs(vec![doc.id])
        },
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Moves the tabs of every other window into this one and closes the others.
#[tauri::command]
pub fn merge_all_windows(app: AppHandle, window: WebviewWindow, state: State<'_, AppState>) {
    let label = window.label().to_string();
    let (ids, others) = {
        let mut s = state.lock();
        let mut others: Vec<String> = s.mru.iter().filter(|l| **l != label).cloned().collect();
        let mut rest: Vec<String> = s
            .windows
            .keys()
            .filter(|l| **l != label && !others.contains(l))
            .cloned()
            .collect();
        rest.sort();
        others.extend(rest);
        let mut ids = Vec::new();
        for l in &others {
            if let Some(w) = s.windows.get_mut(l) {
                ids.append(&mut w.docs);
            }
        }
        (ids, others)
    };
    adopt_into(&app, &label, ids, None, None);
    for l in others {
        if let Some(w) = tauri::Manager::get_webview_window(&app, &l) {
            let _ = w.close();
        }
    }
    let _ = window.set_focus();
}
