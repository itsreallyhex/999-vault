//! The one request sync makes.
//!
//! The pages never talk to the sync server. They hand the body of a
//! sync request to `sync_request`, and this sends it to the address and
//! with the token saved in Settings, which is why the token never
//! reaches the webview: the page can learn that one is set, and that
//! is all. It is also why the server needs no CORS and the app's
//! content security policy needs no hole.
//!
//! What goes out is what the page built: the owner's playlists, the
//! songs in them and their order, and the listening history, to the
//! server the owner runs. Nothing else, and nothing at all until both
//! an address and a token are saved.
//!
//! The reply is handed back whatever its status, so the page can tell
//! a refused token from a reset server. Only a failure to reach the
//! server at all is an error here.

use std::io::Read;
use std::time::Duration;

use serde::Serialize;
use tauri::AppHandle;

use crate::settings;

/// A first pull can be every record there is. 64 MB is far beyond a
/// real playlist library and still a ceiling.
const MAX_REPLY: u64 = 64 * 1024 * 1024;

#[derive(Serialize)]
pub struct Reply {
    pub status: u16,
    pub body: String,
}

/// Whether `url` is an address sync may be pointed at: https, or plain
/// http to this machine for trying a server out. No spaces, no
/// credentials in the address, no query.
pub fn url_ok(url: &str) -> bool {
    let https = url.starts_with("https://") && url.len() > "https://".len();
    let local = url.starts_with("http://127.0.0.1")
        || url.starts_with("http://localhost")
        || url.starts_with("http://[::1]");
    (https || local)
        && !url.chars().any(|c| c.is_whitespace() || c.is_control() || c == '?' || c == '#' || c == '@')
}

/// Send one sync request. `body` is the JSON the page built.
#[tauri::command]
pub async fn sync_request(app: AppHandle, body: String) -> Result<Reply, String> {
    let (url, token) = settings::sync_target(&app)
        .ok_or("Sync is off: save a server address and a token in Settings")?;

    tauri::async_runtime::spawn_blocking(move || {
        // No cookie jar and no referrer, and one fixed user agent.
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(10))
            .timeout(Duration::from_secs(120))
            .user_agent("999-vault")
            .build();

        let sent = agent
            .post(&format!("{}/v1/sync", url))
            .set("Authorization", &format!("Bearer {}", token))
            .set("Content-Type", "application/json")
            .send_string(&body);

        let response = match sent {
            Ok(response) => response,
            // A 4xx or 5xx is an answer. The page reads the status.
            Err(ureq::Error::Status(_, response)) => response,
            Err(ureq::Error::Transport(t)) => {
                return Err(match t.kind() {
                    ureq::ErrorKind::Dns => "The sync server's address could not be found".to_string(),
                    ureq::ErrorKind::ConnectionFailed => "Could not connect to the sync server".to_string(),
                    _ => format!("Could not reach the sync server: {}", t),
                });
            }
        };

        let status = response.status();
        let mut text = String::new();
        response
            .into_reader()
            .take(MAX_REPLY)
            .read_to_string(&mut text)
            .map_err(|err| format!("The sync server's reply stopped short: {}", err))?;

        Ok(Reply { status, body: text })
    })
    .await
    .map_err(|err| format!("sync thread failed: {}", err))?
}

#[cfg(test)]
mod tests {
    use super::url_ok;

    #[test]
    fn accepts_https_and_local_http_only() {
        assert!(url_ok("https://sync.example.com"));
        assert!(url_ok("https://sync.example.com:8443/base"));
        assert!(url_ok("http://127.0.0.1:8099"));
        assert!(url_ok("http://localhost:8080"));
        assert!(!url_ok("http://sync.example.com"));
        assert!(!url_ok("https://"));
        assert!(!url_ok("ftp://sync.example.com"));
        assert!(!url_ok("sync.example.com"));
        assert!(!url_ok(""));
    }

    #[test]
    fn refuses_odd_addresses() {
        assert!(!url_ok("https://sync.example.com/a b"));
        assert!(!url_ok("https://user@sync.example.com"));
        assert!(!url_ok("https://sync.example.com/?x=1"));
        assert!(!url_ok("https://sync.example.com/#top"));
    }
}
