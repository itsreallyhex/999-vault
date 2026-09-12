//! The pages, served from disk.
//!
//! Nothing from `src/` is compiled into the binary. The window loads
//! `nine://localhost/shell.html` and this module answers it by reading
//! the file out of a folder found at startup, the same way the archive
//! and the scripts are found: a rule, not a path frozen at build time.
//!
//! That is what lets one build do both jobs. Installed, it opens like
//! any app and reads its pages from the bundled copy. Pointed at the
//! checkout (`pages_dir` in config.toml, or a dev build sitting inside
//! the checkout), an edit to a page is a reload in the window, with no
//! rebuild. Only a change on the Rust side needs cargo again.
//!
//! Every response is `Cache-Control: no-store`, for the same reason
//! web/serve.py sends it: a page cached mid-edit reads as a bug.

use std::borrow::Cow;
use std::path::PathBuf;

use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Manager, Runtime, UriSchemeContext};

use crate::{data, paths};

/// The scheme. On Windows the pages see it as `http://nine.localhost`.
pub const SCHEME: &str = "nine";

/// Overrides everything else.
pub const ENV_PAGES: &str = "NINE_PAGES_DIR";

/// Where the pages were found, resolved once at startup.
pub struct Pages {
    pub dir: Option<PathBuf>,
    pub source: String,
}

/// The folder holding shell.html, js/ and css/, and the rule that found it.
///
/// A checkout above the executable beats the bundled copy, so a dev
/// build inside the repo reads live files without being told to. An
/// installed build has no checkout above it and falls through to what
/// the installer put beside it, unless config.toml says otherwise.
pub fn pages_dir(app: &AppHandle) -> Option<(PathBuf, String)> {
    paths::first_of(vec![
        (paths::from_env(ENV_PAGES), ENV_PAGES),
        (data::from_config(app, "pages_dir"), "config.toml"),
        (paths::exe_dir().map(|dir| dir.join("pages")), "pages beside the executable"),
        (paths::walk_up_for("desktop/src"), "desktop/src above the executable"),
        (paths::resource_dir(app).map(|dir| dir.join("pages")), "bundled resources"),
    ])
}

pub fn resolve(app: &AppHandle) -> Pages {
    match pages_dir(app) {
        Some((dir, source)) => Pages { dir: Some(dir), source },
        None => Pages { dir: None, source: "not found".into() },
    }
}

/// Content-Type by extension. The registry is not consulted, which is
/// the whole reason web/serve.py exists: on this machine it can answer
/// text/plain for .js, and the webview refuses a module served that way.
fn mime(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn reply(status: StatusCode, mime: &str, body: Vec<u8>) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, "no-store")
        .body(Cow::Owned(body))
        .expect("a response with two headers cannot fail to build")
}

fn text(status: StatusCode, message: String) -> Response<Cow<'static, [u8]>> {
    reply(status, "text/plain; charset=utf-8", message.into_bytes())
}

/// The protocol handler. One file per request, straight off disk.
pub fn serve<R: Runtime>(ctx: UriSchemeContext<'_, R>, request: Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let pages = ctx.app_handle().state::<Pages>();

    let Some(dir) = pages.dir.as_ref() else {
        return text(
            StatusCode::NOT_FOUND,
            "999: the pages folder was not found. Set pages_dir in the config file, or NINE_PAGES_DIR.".into(),
        );
    };

    // The query is dropped: `?x` on a module URL is a cache buster, and
    // there is nothing to bust here anyway.
    let mut path = request.uri().path().trim_start_matches('/').to_string();
    if path.is_empty() {
        path = "shell.html".into();
    }

    // Only the owner types into this, but a path that climbs out of the
    // folder is never what a page link means.
    if path.split(['/', '\\']).any(|part| part == "..") {
        return text(StatusCode::FORBIDDEN, "999: no".into());
    }

    let file = dir.join(&path);
    match std::fs::read(&file) {
        Ok(bytes) => reply(StatusCode::OK, mime(&path), bytes),
        Err(_) => text(StatusCode::NOT_FOUND, format!("999: not found: {}", file.to_string_lossy())),
    }
}
