//! Reload the pages when they change on disk.
//!
//! The pages are read off disk at runtime (pages.rs), so an edit to one
//! is already live on the next reload. This makes the reload happen by
//! itself: a watcher on the pages folder collects the changes for a
//! moment, then emits one `pages-changed` event with the paths, relative
//! to that folder and with forward slashes. shell.js decides what to do
//! with it: swap a stylesheet in place, reload the frame, or reload the
//! whole shell if the player's own files moved.
//!
//! Only when the pages come from a checkout. An installed copy reads
//! the folder the installer put beside it or the bundled resources, and
//! nothing edits those, so watching them would be a thread for nothing.

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

use notify::{RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

use crate::pages::Pages;

/// How long to keep collecting after the first change before emitting.
/// An editor's save is often two or three filesystem events; a build
/// tool writing several files is more. A quarter second gathers them
/// into one reload rather than three.
const SETTLE: Duration = Duration::from_millis(250);

/// Sources whose folder nobody edits by hand.
fn is_static(source: &str) -> bool {
    source == "bundled resources" || source == "pages beside the executable"
}

/// Files that are noise: editors' swap and temp files, and folders that
/// are not pages at all.
fn is_noise(rel: &str) -> bool {
    rel.ends_with('~')
        || rel.ends_with(".swp")
        || rel.ends_with(".tmp")
        || rel.contains("/.")
        || rel.starts_with('.')
}

fn relative(dir: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(dir).ok()?;
    let text = rel.to_string_lossy().replace('\\', "/");
    if text.is_empty() || is_noise(&text) {
        return None;
    }
    Some(text)
}

/// Start watching, if the pages are the kind that get edited. Returns
/// what it decided, for the startup print.
pub fn start(app: &AppHandle, pages: &Pages) -> String {
    let dir: PathBuf = match &pages.dir {
        Some(dir) => dir.clone(),
        None => return "nothing to watch".into(),
    };
    if is_static(&pages.source) {
        return format!("not watching ({})", pages.source);
    }

    let handle = app.clone();
    let root = dir.clone();
    std::thread::Builder::new()
        .name("pages-watch".into())
        .spawn(move || {
            let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
            let mut watcher = match notify::recommended_watcher(tx) {
                Ok(w) => w,
                Err(err) => {
                    println!("999: watch     failed to start: {}", err);
                    return;
                }
            };
            if let Err(err) = watcher.watch(&root, RecursiveMode::Recursive) {
                println!("999: watch     failed on {}: {}", root.to_string_lossy(), err);
                return;
            }

            // Block for the first change, then drain everything that
            // arrives inside the settle window, then emit once.
            while let Ok(first) = rx.recv() {
                let mut changed: Vec<String> = Vec::new();
                let mut take = |ev: notify::Result<notify::Event>| {
                    if let Ok(ev) = ev {
                        for p in ev.paths {
                            if let Some(rel) = relative(&root, &p) {
                                if !changed.contains(&rel) {
                                    changed.push(rel);
                                }
                            }
                        }
                    }
                };
                take(first);
                while let Ok(more) = rx.recv_timeout(SETTLE) {
                    take(more);
                }
                if changed.is_empty() {
                    continue;
                }
                changed.sort();
                println!("999: watch     changed {}", changed.join(", "));
                let _ = handle.emit("pages-changed", changed);
            }
        })
        .ok();

    format!("watching {}", dir.to_string_lossy())
}
