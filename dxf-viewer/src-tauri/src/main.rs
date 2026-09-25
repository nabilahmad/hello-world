// Hide the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod drag;
mod state;
mod windows;

use serde::Serialize;
use tauri::{DragDropEvent, Emitter, Manager, WindowEvent};

use state::AppState;
use windows::{create_window, file_args, open_in_window, open_in_windows, NewWindow};

#[derive(Clone, Serialize)]
struct FileDrag {
    active: bool,
}

fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    let app = window.app_handle();
    let label = window.label();
    match event {
        WindowEvent::Focused(true) => app.state::<AppState>().lock().touch(label),
        WindowEvent::Destroyed => {
            let state = app.state::<AppState>();
            let mut s = state.lock();
            if let Some(w) = s.windows.remove(label) {
                for id in w.docs {
                    s.docs.remove(&id);
                }
            }
            s.mru.retain(|l| l != label);
            if s.drag
                .as_ref()
                .is_some_and(|d| d.source == label || d.moving == label)
            {
                s.drag = None;
            } else if let Some(d) = s.drag.as_mut() {
                d.zones.retain(|z| z.label != label);
            }
        }
        // Files dropped from the file manager open as tabs of this window.
        WindowEvent::DragDrop(DragDropEvent::Enter { .. }) => {
            let _ = app.emit_to(label, "file-drag", FileDrag { active: true });
        }
        WindowEvent::DragDrop(DragDropEvent::Leave) => {
            let _ = app.emit_to(label, "file-drag", FileDrag { active: false });
        }
        WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) => {
            let _ = app.emit_to(label, "file-drag", FileDrag { active: false });
            open_in_window(app, label, paths.clone());
        }
        _ => {}
    }
}

/// Tab dragging between windows needs global window and cursor positions,
/// which Wayland does not expose, so prefer XWayland unless the user picked
/// a GDK backend explicitly.
#[cfg(target_os = "linux")]
fn prefer_x11() {
    if std::env::var_os("GDK_BACKEND").is_none() && std::env::var_os("WAYLAND_DISPLAY").is_some() {
        std::env::set_var("GDK_BACKEND", "x11,wayland");
    }
}

fn main() {
    #[cfg(target_os = "linux")]
    prefer_x11();

    let startup_files = file_args(
        std::env::args_os()
            .skip(1)
            .map(|a| a.to_string_lossy().into_owned()),
        std::env::current_dir().ok(),
    );

    tauri::Builder::default()
        // A second launch (e.g. double-clicking another file) forwards its
        // arguments here, so all windows live in one process and tabs can move
        // between them.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let files = file_args(argv.into_iter().skip(1), Some(cwd.into()));
            if files.is_empty() {
                let _ = create_window(app, NewWindow::with_docs(Vec::new()));
            } else {
                open_in_windows(app, files, None);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::window_init,
            commands::read_doc,
            commands::open_dialog,
            commands::close_doc,
            commands::report_layout,
            commands::reorder_docs,
            commands::move_to_new_window,
            commands::merge_all_windows,
            drag::drag_begin,
            drag::drag_move,
            drag::drag_end,
            drag::drag_cancel,
        ])
        .on_window_event(on_window_event)
        .setup(move |app| {
            let handle = app.handle();
            if startup_files.is_empty() {
                create_window(handle, NewWindow::with_docs(Vec::new()))?;
            } else {
                open_in_windows(handle, startup_files.clone(), None);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to start DXF Viewer")
        .run(|_app, _event| {
            // macOS delivers files opened from Finder as an event, not as arguments.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = _event {
                let files = urls
                    .into_iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .collect();
                open_in_windows(_app, files, None);
            }
        });
}
