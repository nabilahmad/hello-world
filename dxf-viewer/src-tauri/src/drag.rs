//! Dragging tabs between windows.
//!
//! The page that started the drag keeps the pointer captured and calls these
//! commands; the native side does the window work with global coordinates:
//!
//! * `drag_begin`: the window to move is the source itself (its only tab is
//!   dragged) or a new window created for a tab pulled out of a tab bar.
//! * `drag_move`: the moving window follows the cursor. Over another window's
//!   tab bar it parks just below that bar and the target shows where the tab
//!   will land.
//! * `drag_end`: dropped on a tab bar, the tab joins that window and the moving
//!   window closes; dropped anywhere else, the window stays where it is.
//! * `drag_cancel` (Escape) puts everything back.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewWindow};

use crate::state::{AppState, DocPayload, Drag, Rect, Zone};
use crate::windows::{adopt_into, create_window, NewWindow};

#[derive(Clone, Serialize)]
struct HoverEvent {
    x: f64,
    name: String,
}

/// Tab bar height used before a window has reported its layout (CSS px).
const DEFAULT_STRIP: f64 = 38.0;
/// Extra room below a tab bar that still counts as "on the tab bar" (CSS px).
const ZONE_SLACK: f64 = 18.0;
/// Gap between a target's tab bar and the parked window (CSS px).
const PARK_GAP: f64 = 10.0;

fn zone_for(app: &AppHandle, label: &str, strip: Option<Rect>, empty: bool) -> Option<Zone> {
    let w = app.get_webview_window(label)?;
    if !w.is_visible().unwrap_or(false) || w.is_minimized().unwrap_or(false) {
        return None;
    }
    let scale = w.scale_factor().ok()?;
    let outer = w.outer_position().ok()?;
    let inner = w.inner_position().ok()?;
    let size = w.outer_size().ok()?;
    let strip = strip.unwrap_or(Rect {
        y: 0.0,
        height: DEFAULT_STRIP,
    });
    let strip_bottom = inner.y as f64 + (strip.y + strip.height) * scale;
    // An empty window accepts a drop anywhere; otherwise only on its title/tab bar.
    let bottom = if empty {
        outer.y as f64 + size.height as f64
    } else {
        strip_bottom + ZONE_SLACK * scale
    };
    Some(Zone {
        label: label.to_string(),
        left: outer.x as f64,
        top: outer.y as f64,
        right: (outer.x + size.width as i32) as f64,
        bottom,
        strip_bottom,
        content_x: inner.x as f64,
        scale,
    })
}

#[tauri::command]
pub async fn drag_begin(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    doc: DocPayload,
    grab_x: f64,
    grab_y: f64,
    detach: bool,
) -> Result<bool, String> {
    // Needs global positions (not available on Wayland; see main.rs).
    let Ok(cursor) = app.cursor_position() else {
        return Ok(false);
    };
    let (Ok(outer), Ok(inner), Ok(scale)) = (
        window.outer_position(),
        window.inner_position(),
        window.scale_factor(),
    ) else {
        return Ok(false);
    };
    let source = window.label().to_string();
    let source_index = {
        let mut s = state.lock();
        if s.drag.is_some() {
            return Ok(false);
        }
        if let Some(d) = s.docs.get_mut(&doc.id) {
            d.view = doc.view;
        }
        let Some(w) = s.windows.get_mut(&source) else {
            return Ok(false);
        };
        let Some(i) = w.docs.iter().position(|d| *d == doc.id) else {
            return Ok(false);
        };
        if detach {
            w.docs.remove(i);
        }
        i
    };

    let (moving, offset, origin) = if detach {
        // The tab becomes the first tab of a new window of the same size, placed
        // so the tab sits under the cursor exactly where it was grabbed.
        let decor = ((inner.x - outer.x) as f64, (inner.y - outer.y) as f64);
        let offset = (decor.0 + grab_x * scale, decor.1 + grab_y * scale);
        let pos = PhysicalPosition::new(
            (cursor.x - offset.0).round() as i32,
            (cursor.y - offset.1).round() as i32,
        );
        let size = window
            .inner_size()
            .ok()
            .map(|s| (s.width as f64 / scale, s.height as f64 / scale));
        let opts = NewWindow {
            position: Some(pos),
            size,
            focus: false,
            on_top: true,
            ..NewWindow::with_docs(vec![doc.id])
        };
        match create_window(&app, opts) {
            Ok(w) => (w.label().to_string(), offset, (pos.x, pos.y)),
            Err(e) => {
                // Put the tab back.
                if let Some(w) = state.lock().windows.get_mut(&source) {
                    w.docs.insert(source_index.min(w.docs.len()), doc.id);
                }
                return Err(e.to_string());
            }
        }
    } else {
        (
            source.clone(),
            (cursor.x - outer.x as f64, cursor.y - outer.y as f64),
            (outer.x, outer.y),
        )
    };

    // Drop zones of every other window, most recently focused first.
    let candidates: Vec<(String, Option<Rect>, bool)> = {
        let s = state.lock();
        let mut order: Vec<String> = s.mru.clone();
        let mut rest: Vec<String> = s
            .windows
            .keys()
            .filter(|l| !order.contains(l))
            .cloned()
            .collect();
        rest.sort();
        order.extend(rest);
        order
            .into_iter()
            .filter(|l| *l != moving)
            .filter_map(|l| {
                s.windows
                    .get(&l)
                    .map(|w| (l.clone(), w.strip, w.docs.is_empty()))
            })
            .collect()
    };
    let zones: Vec<Zone> = candidates
        .into_iter()
        .filter_map(|(l, strip, empty)| zone_for(&app, &l, strip, empty))
        .collect();

    state.lock().drag = Some(Drag {
        source,
        moving,
        doc: doc.id,
        created: detach,
        source_index,
        offset,
        origin,
        zones,
        target: None,
    });
    Ok(true)
}

/// Moves the dragged window and updates the drop target. Runs on the main thread.
fn update(app: &AppHandle, state: &AppState) {
    let Ok(cursor) = app.cursor_position() else {
        return;
    };
    let (moving, offset, hit, previous, name) = {
        let mut s = state.lock();
        let name = match s.drag.as_ref() {
            Some(d) => s
                .docs
                .get(&d.doc)
                .map(|x| x.name.clone())
                .unwrap_or_default(),
            None => return,
        };
        let d = s.drag.as_mut().unwrap();
        let hit = d
            .zones
            .iter()
            .find(|z| {
                cursor.x >= z.left && cursor.x < z.right && cursor.y >= z.top && cursor.y < z.bottom
            })
            .cloned();
        let previous = d.target.take().map(|t| t.0);
        d.target = hit
            .as_ref()
            .map(|z| (z.label.clone(), (cursor.x - z.content_x) / z.scale));
        (d.moving.clone(), d.offset, hit, previous, name)
    };
    if let Some(prev) = previous {
        if hit.as_ref().map(|z| &z.label) != Some(&prev) {
            let _ = app.emit_to(prev.as_str(), "drop-leave", ());
        }
    }
    let x = cursor.x - offset.0;
    let y = match &hit {
        Some(z) => {
            let _ = app.emit_to(
                z.label.as_str(),
                "drop-hover",
                HoverEvent {
                    x: (cursor.x - z.content_x) / z.scale,
                    name,
                },
            );
            z.strip_bottom + PARK_GAP * z.scale
        }
        None => cursor.y - offset.1,
    };
    if let Some(w) = app.get_webview_window(&moving) {
        let _ = w.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
    }
}

#[tauri::command]
pub fn drag_move(app: AppHandle, state: State<'_, AppState>) {
    update(&app, &state);
}

#[tauri::command]
pub fn drag_end(app: AppHandle, state: State<'_, AppState>) {
    update(&app, &state);
    let Some(d) = state.lock().drag.take() else {
        return;
    };
    let moving = app.get_webview_window(&d.moving);
    match d.target {
        Some((target, x)) => {
            let _ = app.emit_to(target.as_str(), "drop-leave", ());
            let ids = state
                .lock()
                .windows
                .get_mut(&d.moving)
                .map(|w| std::mem::take(&mut w.docs))
                .unwrap_or_default();
            adopt_into(&app, &target, ids, Some(x), None);
            if let Some(w) = moving {
                let _ = w.close();
            }
            if let Some(w) = app.get_webview_window(&target) {
                let _ = w.set_focus();
            }
        }
        None => {
            if let Some(w) = moving {
                if d.created {
                    let _ = w.set_always_on_top(false);
                }
                let _ = w.set_focus();
            }
        }
    }
}

#[tauri::command]
pub fn drag_cancel(app: AppHandle, state: State<'_, AppState>) {
    let Some(d) = state.lock().drag.take() else {
        return;
    };
    if let Some((target, _)) = &d.target {
        let _ = app.emit_to(target.as_str(), "drop-leave", ());
    }
    let moving = app.get_webview_window(&d.moving);
    if d.created {
        if let Some(w) = state.lock().windows.get_mut(&d.moving) {
            w.docs.retain(|x| *x != d.doc);
        }
        adopt_into(&app, &d.source, vec![d.doc], None, Some(d.source_index));
        if let Some(w) = moving {
            let _ = w.close();
        }
    } else if let Some(w) = moving {
        let _ = w.set_position(PhysicalPosition::new(d.origin.0, d.origin.1));
    }
}
