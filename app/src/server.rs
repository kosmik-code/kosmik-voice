//! Local HTTP + WebSocket server. Loopback only; every request must carry a local Host and
//! every mutation a same-origin Origin, so web pages can neither drive nor read it.
//! Same routes and guards as src/server.js.

use crate::config::{ConfigStore, SaveError, is_image_name, validate_config};
use crate::secrets::SecretStore;
use crate::service::{DiscordHandle, ServiceEvent};
use axum::body::{Body, Bytes};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{FromRequest, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use std::borrow::Cow;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, watch};
use unicode_normalization::UnicodeNormalization;

const MAX_JSON: usize = 1024 * 1024;
const MAX_IMAGE: usize = 10 * 1024 * 1024;
/// Folders whose files make up the running overlay page. Their content hash is the overlay "build":
/// an open OBS source reloads itself when it changes.
const OVERLAY_DIRS: [&str; 2] = ["overlay", "shared"];

/// The editor and overlay pages: built into the program, or read from a folder while developing.
pub enum PublicFiles {
    Embedded(&'static include_dir::Dir<'static>),
    Disk(PathBuf),
}

impl PublicFiles {
    fn get(&self, rel: &str) -> Option<Cow<'static, [u8]>> {
        match self {
            PublicFiles::Embedded(dir) => dir.get_file(rel).map(|f| Cow::Borrowed(f.contents())),
            PublicFiles::Disk(root) => {
                let path = root.join(rel);
                path.is_file().then(|| std::fs::read(path).ok().map(Cow::Owned)).flatten()
            }
        }
    }

    /// Files directly inside `dir`, sorted by name.
    fn list(&self, dir: &str) -> Vec<(String, Vec<u8>)> {
        let mut out: Vec<(String, Vec<u8>)> = match self {
            PublicFiles::Embedded(root) => root
                .get_dir(dir)
                .map(|d| {
                    d.files()
                        .filter_map(|f| Some((f.path().file_name()?.to_string_lossy().into_owned(), f.contents().to_vec())))
                        .collect()
                })
                .unwrap_or_default(),
            PublicFiles::Disk(root) => std::fs::read_dir(root.join(dir))
                .map(|rd| {
                    rd.filter_map(|e| e.ok())
                        .filter(|e| e.path().is_file())
                        .filter_map(|e| Some((e.file_name().to_string_lossy().into_owned(), std::fs::read(e.path()).ok()?)))
                        .collect()
                })
                .unwrap_or_default(),
        };
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }

    /// Short content hash of the overlay files.
    pub fn overlay_build(&self) -> String {
        let mut hash = sha1_smol::Sha1::new();
        for dir in OVERLAY_DIRS {
            for (name, body) in self.list(dir) {
                hash.update(format!("{dir}/{name}\0").as_bytes());
                hash.update(&body);
                hash.update(b"\0");
            }
        }
        hash.digest().to_string()[..12].to_string()
    }
}

fn content_type(path: &str) -> &'static str {
    let ext = path.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "jpg" | "jpeg" => "image/jpeg",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    }
}

pub fn is_image(buf: &[u8]) -> bool {
    if buf.len() < 12 {
        return false;
    }
    (buf[0] == 0x89 && &buf[1..4] == b"PNG")
        || &buf[0..4] == b"GIF8"
        || (&buf[0..4] == b"RIFF" && &buf[8..12] == b"WEBP")
        || (buf[0] == 0xff && buf[1] == 0xd8 && buf[2] == 0xff)
}

/// A safe, lowercase file name for an upload, keeping its image extension; None for other files.
pub fn sanitize_image_name(raw: &str) -> Option<String> {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let (stem, ext) = match base.rfind('.') {
        Some(i) if i > 0 => (&base[..i], base[i..].to_lowercase()),
        _ => return None,
    };
    if ![".png", ".gif", ".webp", ".jpg", ".jpeg"].contains(&ext.as_str()) {
        return None;
    }
    let folded: String = stem.nfkd().filter(|c| !('\u{300}'..='\u{36f}').contains(c)).collect::<String>().to_lowercase();
    let mut slug = String::new();
    for c in folded.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            slug.push(c);
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug: String = slug.trim_matches('-').chars().take(60).collect();
    Some(format!("{}{ext}", if slug.is_empty() { "image" } else { &slug }))
}

/// decodeURIComponent: None on bad escapes or invalid UTF-8.
fn decode_uri(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// A URL path resolved inside the public folder ("editor/index.html"), or None.
fn safe_rel(url_path: &str) -> Option<String> {
    let decoded = decode_uri(url_path)?;
    if decoded.contains('\0') {
        return None;
    }
    let mut parts: Vec<&str> = Vec::new();
    for seg in decoded.split(['/', '\\']) {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            s => parts.push(s),
        }
    }
    if parts.iter().any(|p| p.contains(':')) {
        return None;
    }
    Some(parts.join("/"))
}

fn query_param(uri: &axum::http::Uri, key: &str) -> Option<String> {
    let q = uri.query()?;
    form_urlencoded::parse(q.as_bytes()).find(|(k, _)| k == key).map(|(_, v)| v.into_owned())
}

struct HttpError {
    status: StatusCode,
    body: Value,
}

impl HttpError {
    fn new(status: u16, msg: &str) -> Self {
        HttpError { status: StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR), body: json!({ "error": msg }) }
    }
    fn internal(e: impl std::fmt::Display) -> Self {
        crate::log::line(format!("[server] {e}"));
        HttpError::new(500, "internal error")
    }
}

type Res = Result<Response, HttpError>;

fn reply(status: u16, content_type: Option<&str>, body: impl Into<Body>) -> Response {
    let mut res = Response::new(body.into());
    *res.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::OK);
    let h = res.headers_mut();
    h.insert("X-Content-Type-Options", HeaderValue::from_static("nosniff"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if let Some(ct) = content_type {
        if let Ok(v) = HeaderValue::from_str(ct) {
            h.insert(header::CONTENT_TYPE, v);
        }
        // Only our own editor may frame our pages (it embeds the overlay preview).
        if ct.starts_with("text/html") {
            h.insert("Content-Security-Policy", HeaderValue::from_static("frame-ancestors 'self'"));
        }
    }
    res
}

fn json_reply(status: u16, body: &Value) -> Response {
    reply(status, Some("application/json; charset=utf-8"), body.to_string())
}

/// Installs the pending update when the editor's "Install now" is pressed (the tray app's updater).
pub type Installer = Arc<dyn Fn() + Send + Sync>;

struct AppState {
    config: Mutex<ConfigStore>,
    secrets: Arc<SecretStore>,
    discord: DiscordHandle,
    assets_dir: PathBuf,
    public: PublicFiles,
    update: Mutex<Value>,
    installer: Mutex<Option<Installer>>,
    build: Mutex<String>,
    tx: broadcast::Sender<Arc<str>>,
    hosts: HashSet<String>,
    origins: HashSet<String>,
    port: u16,
    /// Overlays hidden from the tray, a hotkey or the editor. Not saved: a restart shows them again.
    hidden: watch::Sender<bool>,
    find_obs: crate::obs::FindObs,
    hotkeys: Arc<crate::hotkeys::Hotkeys>,
}

impl AppState {
    fn broadcast(&self, msg: Value) {
        let _ = self.tx.send(Arc::from(msg.to_string()));
    }

    fn current_config(&self) -> Value {
        self.config.lock().unwrap_or_else(|e| e.into_inner()).current().clone()
    }

    fn save_config(&self, next: Value) -> Result<Value, HttpError> {
        let saved = self.config.lock().unwrap_or_else(|e| e.into_inner()).save(next);
        match saved {
            Ok(saved) => {
                self.broadcast(json!({ "type": "config", "config": saved }));
                Ok(saved)
            }
            Err(SaveError::Invalid(errors)) => Err(HttpError { status: StatusCode::BAD_REQUEST, body: json!({ "errors": errors }) }),
            Err(SaveError::Io(e)) => Err(HttpError::internal(e)),
        }
    }

    fn discord_view(&self) -> Value {
        let mut v = json!({ "clientId": self.current_config()["discord"]["clientId"] });
        if let (Some(o), Value::Object(s)) = (v.as_object_mut(), self.secrets.status()) {
            o.extend(s);
        }
        v["status"] = serde_json::to_value(self.discord.status()).unwrap_or(Value::Null);
        v
    }

    fn set_hidden(&self, on: bool) {
        if self.hidden.send_replace(on) != on {
            crate::log::line(if on { "Overlays hidden" } else { "Overlays shown again" });
            self.broadcast(json!({ "type": "hidden", "hidden": on }));
        }
    }

    fn hello(&self) -> Value {
        json!({
            "type": "hello",
            "version": crate::VERSION,
            "hidden": *self.hidden.borrow(),
            "hotkeys": self.hotkeys.view(),
            "build": *self.build.lock().unwrap_or_else(|e| e.into_inner()),
            "update": *self.update.lock().unwrap_or_else(|e| e.into_inner()),
            "config": self.current_config(),
            "status": self.discord.status(),
            "voice": self.discord.snapshot(),
        })
    }
}

fn header_str(h: &HeaderMap, name: header::HeaderName) -> Option<String> {
    h.get(name).and_then(|v| v.to_str().ok()).map(str::to_lowercase)
}

/// Reads up to `limit` bytes. A bigger body is still read to the end (and dropped, up to a cap)
/// so the browser gets the 413 answer instead of a reset connection.
async fn read_body(req: Request, limit: usize) -> Result<Bytes, HttpError> {
    use futures_util::StreamExt;
    const DRAIN_CAP: usize = 64 * 1024 * 1024;
    let mut stream = req.into_body().into_data_stream();
    let mut buf = Vec::new();
    let mut total = 0usize;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| HttpError::new(400, "upload interrupted"))?;
        total += chunk.len();
        if total <= limit {
            buf.extend_from_slice(&chunk);
        } else if total > DRAIN_CAP {
            break;
        }
    }
    if total > limit {
        return Err(HttpError::new(413, "payload too large"));
    }
    Ok(Bytes::from(buf))
}

async fn read_json(req: Request) -> Result<Value, HttpError> {
    if !header_str(req.headers(), header::CONTENT_TYPE).is_some_and(|ct| ct.starts_with("application/json")) {
        return Err(HttpError::new(415, "expected application/json"));
    }
    let body = read_body(req, MAX_JSON).await?;
    serde_json::from_slice(&body).map_err(|_| HttpError::new(400, "invalid JSON"))
}

fn list_assets(dir: &Path) -> std::io::Result<Vec<Value>> {
    let mut names: Vec<(String, u64)> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            is_image_name(&name).then(|| (name, e.metadata().map(|m| m.len()).unwrap_or(0)))
        })
        .collect();
    names.sort();
    Ok(names.into_iter().map(|(name, size)| json!({ "name": name, "size": size })).collect())
}

fn unique_name(dir: &Path, name: &str) -> String {
    if !dir.join(name).exists() {
        return name.to_string();
    }
    let (stem, ext) = name.rsplit_once('.').map(|(s, e)| (s, format!(".{e}"))).unwrap_or((name, String::new()));
    (2..).map(|i| format!("{stem}-{i}{ext}")).find(|c| !dir.join(c).exists()).unwrap_or_default()
}

async fn api(st: Arc<AppState>, req: Request) -> Res {
    let path = req.uri().path().to_string();
    let method = req.method().clone();
    match (method.as_str(), path.as_str()) {
        ("GET", "/api/config") => Ok(json_reply(200, &st.current_config())),
        ("PUT", "/api/config") => {
            let next = read_json(req).await?;
            Ok(json_reply(200, &st.save_config(next)?))
        }
        ("GET", "/api/assets") => Ok(json_reply(200, &Value::Array(list_assets(&st.assets_dir).map_err(HttpError::internal)?))),
        ("POST", "/api/assets") => {
            let Some(name) = sanitize_image_name(&query_param(req.uri(), "name").unwrap_or_default()) else {
                return Err(HttpError::new(400, "only PNG, GIF, WebP or JPG images"));
            };
            let buf = read_body(req, MAX_IMAGE).await?;
            if !is_image(&buf) {
                return Err(HttpError::new(400, "file is not a PNG, GIF, WebP or JPG image"));
            }
            let final_name = unique_name(&st.assets_dir, &name);
            let file = std::fs::OpenOptions::new().write(true).create_new(true).open(st.assets_dir.join(&final_name));
            std::io::Write::write_all(&mut file.map_err(HttpError::internal)?, &buf).map_err(HttpError::internal)?;
            Ok(json_reply(201, &json!({ "name": final_name })))
        }
        ("DELETE", p) if p.starts_with("/api/assets/") => {
            let name = &p["/api/assets/".len()..];
            if !is_image_name(name) {
                return Err(HttpError::new(404, "not found"));
            }
            let config = st.current_config();
            let users: Vec<Value> = config["users"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|u| u["images"].as_object().is_some_and(|i| i.values().any(|v| v == name)))
                .map(|u| if u["displayName"].as_str().is_some_and(|d| !d.is_empty()) { u["displayName"].clone() } else { u["id"].clone() })
                .collect();
            if !users.is_empty() {
                return Err(HttpError { status: StatusCode::CONFLICT, body: json!({ "error": "image in use", "users": users }) });
            }
            std::fs::remove_file(st.assets_dir.join(name)).map_err(|_| HttpError::new(404, "not found"))?;
            Ok(reply(204, None, Body::empty()))
        }
        ("GET", "/api/discord") => Ok(json_reply(200, &st.discord_view())),
        ("PUT", "/api/discord") => {
            let body = read_json(req).await?;
            let client_id = body["clientId"].as_str().map(str::trim).unwrap_or("").to_string();
            let current = st.current_config();
            let mut next = current.clone();
            next["discord"]["clientId"] = json!(client_id);
            if client_id.is_empty() || !validate_config(&next).ok() {
                return Err(HttpError::new(400, "clientId must be your Discord application id (17-20 digits)"));
            }
            let changed_app = current["discord"]["clientId"] != json!(client_id);
            let secret = body["clientSecret"].as_str().map(str::trim).unwrap_or("").to_string();
            st.secrets
                .update(|s| {
                    if !secret.is_empty() {
                        s.insert("clientSecret".into(), json!(secret));
                    }
                    if changed_app || !secret.is_empty() {
                        s.remove("token");
                    }
                })
                .map_err(HttpError::internal)?;
            st.save_config(next)?;
            st.discord.restart(Some(client_id));
            Ok(json_reply(200, &st.discord_view()))
        }
        ("POST", "/api/update/install") => {
            let ready = st.update.lock().unwrap_or_else(|e| e.into_inner())["install"] == true;
            let installer = st.installer.lock().unwrap_or_else(|e| e.into_inner()).clone();
            match installer {
                Some(install) if ready => {
                    install();
                    Ok(reply(202, None, Body::empty()))
                }
                _ => Err(HttpError::new(409, "no update to install")),
            }
        }
        ("POST", "/api/overlay/hidden") => {
            let body = read_json(req).await?;
            let Some(on) = body["hidden"].as_bool() else { return Err(HttpError::new(400, "hidden must be true or false")) };
            st.set_hidden(on);
            Ok(json_reply(200, &json!({ "hidden": on })))
        }
        ("PUT", "/api/hotkeys") => {
            let body = read_json(req).await?;
            let (id, key) = (body["id"].as_str().unwrap_or(""), body["key"].as_str().unwrap_or(""));
            match st.hotkeys.set(id, key) {
                Ok(_) => Ok(json_reply(200, &st.hotkeys.view())),
                Err("io") => Err(HttpError::internal("could not save hotkeys.json")),
                Err(code) => Err(HttpError::new(400, code)),
            }
        }
        // While the editor waits for a new combination, the hotkeys are let go of, so even the
        // current one reaches the page.
        ("POST", "/api/hotkeys/pause") => {
            let body = read_json(req).await?;
            let Some(on) = body["paused"].as_bool() else { return Err(HttpError::new(400, "paused must be true or false")) };
            st.hotkeys.pause(on);
            Ok(json_reply(200, &json!({ "paused": on })))
        }
        ("POST", "/api/obs/add") => {
            let body = read_json(req).await?;
            let id = body["preset"].as_str().unwrap_or("").to_string();
            let size = |k: &str| body[k].as_u64().filter(|n| (1..=16384).contains(n)).map(|n| n as u32);
            let (Some(width), Some(height)) = (size("width"), size("height")) else {
                return Err(HttpError::new(400, "width and height must be whole numbers from 1 to 16384"));
            };
            // Only saved presets: an unsaved one has no overlay page yet.
            let config = st.current_config();
            let Some(preset) = config["presets"].as_array().into_iter().flatten().find(|p| p["id"] == json!(id)).cloned() else {
                return Err(HttpError { status: StatusCode::NOT_FOUND, body: json!({ "error": "unknown_preset", "message": "save the preset first" }) });
            };
            let find = st.find_obs.clone();
            let settings = tokio::task::spawn_blocking(move || find()).await.unwrap_or(None);
            let request = crate::obs::AddRequest { port: st.port, preset_id: &id, preset_name: preset["name"].as_str().unwrap_or(""), width, height };
            match crate::obs::add_to_obs(settings, request).await {
                Ok(done) => {
                    crate::log::line(format!("[obs] {} \"{}\" in scene \"{}\"", done["result"].as_str().unwrap_or(""), done["name"].as_str().unwrap_or(""), done["scene"].as_str().unwrap_or("")));
                    Ok(json_reply(200, &done))
                }
                Err(e) => {
                    crate::log::line(format!("[obs] Add to OBS: {}", e.message));
                    let status = if e.code == "obs_failed" { StatusCode::BAD_GATEWAY } else { StatusCode::CONFLICT };
                    Err(HttpError { status, body: json!({ "error": e.code, "message": e.message }) })
                }
            }
        }
        ("POST", "/api/discord/logout") => {
            st.secrets
                .update(|s| {
                    s.remove("token");
                })
                .map_err(HttpError::internal)?;
            let id = st.current_config()["discord"]["clientId"].as_str().unwrap_or("").to_string();
            st.discord.restart(Some(id));
            Ok(json_reply(200, &st.discord_view()))
        }
        _ => Err(HttpError::new(404, "not found")),
    }
}

fn serve_bytes(rel: &str, body: Cow<'static, [u8]>) -> Response {
    let body = match body {
        Cow::Borrowed(b) => Body::from(Bytes::from_static(b)),
        Cow::Owned(v) => Body::from(v),
    };
    reply(200, Some(content_type(rel)), body)
}

async fn route(st: Arc<AppState>, req: Request) -> Res {
    let host = header_str(req.headers(), header::HOST).unwrap_or_default();
    let origin = header_str(req.headers(), header::ORIGIN);
    let path = req.uri().path().to_string();
    let is_upgrade = req.headers().contains_key(header::UPGRADE);

    if is_upgrade {
        // OBS browser sources load our own pages, so a browser always sends our origin.
        let ok = path == "/ws" && st.hosts.contains(&host) && origin.as_ref().is_none_or(|o| st.origins.contains(o));
        if !ok {
            return Ok(reply(403, None, Body::empty()));
        }
        let ws = WebSocketUpgrade::from_request(req, &()).await.map_err(|_| HttpError::new(400, "bad websocket request"))?;
        let st2 = st.clone();
        return Ok(ws.on_upgrade(move |socket| ws_session(st2, socket)).into_response());
    }

    if !st.hosts.contains(&host) {
        return Err(HttpError::new(403, "forbidden host"));
    }
    let read_only = req.method() == Method::GET || req.method() == Method::HEAD;
    if !read_only && !origin.as_ref().is_some_and(|o| st.origins.contains(o)) {
        return Err(HttpError::new(403, "forbidden origin"));
    }
    if path.starts_with("/api/") {
        return api(st, req).await;
    }
    if !read_only {
        return Err(HttpError::new(405, "method not allowed"));
    }
    if path == "/" {
        let mut res = reply(302, None, "");
        res.headers_mut().insert(header::LOCATION, HeaderValue::from_static("/editor/"));
        return Ok(res);
    }
    if let Some(name) = path.strip_prefix("/assets/") {
        if is_image_name(name) {
            if let Ok(body) = std::fs::read(st.assets_dir.join(name)) {
                return Ok(serve_bytes(name, Cow::Owned(body)));
            }
        }
        return Err(HttpError::new(404, "not found"));
    }
    // /overlay/<preset> renders the same page; the preset id is read client-side.
    if let Some(id) = path.strip_prefix("/overlay/") {
        if id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') {
            if let Some(body) = st.public.get("overlay/index.html") {
                return Ok(serve_bytes("overlay/index.html", body));
            }
        }
    }
    let mut p = path.clone();
    if p.ends_with('/') {
        p.push_str("index.html");
    }
    if let Some(rel) = safe_rel(&p) {
        if let Some(body) = st.public.get(&rel) {
            return Ok(serve_bytes(&rel, body));
        }
    }
    Err(HttpError::new(404, "not found"))
}

async fn handle(State(st): State<Arc<AppState>>, req: Request) -> Response {
    match route(st, req).await {
        Ok(r) => r,
        Err(e) => json_reply(e.status.as_u16(), &e.body),
    }
}

async fn ws_session(st: Arc<AppState>, mut socket: WebSocket) {
    let mut rx = st.tx.subscribe();
    if socket.send(Message::Text(st.hello().to_string().into())).await.is_err() {
        return;
    }
    loop {
        tokio::select! {
            msg = rx.recv() => match msg {
                Ok(text) => if socket.send(Message::Text(text.as_ref().into())).await.is_err() { return },
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    if socket.send(Message::Text(st.hello().to_string().into())).await.is_err() { return }
                }
                Err(broadcast::error::RecvError::Closed) => return,
            },
            incoming = socket.recv() => match incoming {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => return,
                _ => {}
            },
        }
    }
}

pub struct ServerOptions {
    pub data_dir: PathBuf,
    pub public: PublicFiles,
    pub config: ConfigStore,
    pub secrets: Arc<SecretStore>,
    pub discord: DiscordHandle,
    pub find_obs: crate::obs::FindObs,
    pub hotkeys: Arc<crate::hotkeys::Hotkeys>,
}

pub struct ServerHandle {
    pub url: String,
    pub port: u16,
    state: Arc<AppState>,
    task: tokio::task::JoinHandle<()>,
    side_tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl ServerHandle {
    pub fn set_update(&self, next: Value) {
        *self.state.update.lock().unwrap_or_else(|e| e.into_inner()) = next.clone();
        self.state.broadcast(json!({ "type": "update", "update": next }));
    }

    /// Hide (or show again) every overlay at once.
    pub fn set_hidden(&self, on: bool) {
        self.state.set_hidden(on);
    }

    pub fn hidden(&self) -> bool {
        *self.state.hidden.borrow()
    }

    /// Follows hiding from any side (tray, hotkey, editor).
    pub fn hidden_watch(&self) -> watch::Receiver<bool> {
        self.state.hidden.subscribe()
    }

    pub fn set_installer(&self, install: Installer) {
        *self.state.installer.lock().unwrap_or_else(|e| e.into_inner()) = Some(install);
    }

    pub fn close(&self) {
        self.task.abort();
        for t in &self.side_tasks {
            t.abort();
        }
    }
}

impl Drop for ServerHandle {
    fn drop(&mut self) {
        self.close();
    }
}

/// Serves on an already bound loopback listener (binding first lets the caller report a busy port).
pub async fn start_server(listener: TcpListener, opts: ServerOptions) -> std::io::Result<ServerHandle> {
    let assets_dir = opts.data_dir.join("assets");
    std::fs::create_dir_all(&assets_dir)?;
    let port = listener.local_addr()?.port();
    let hosts: HashSet<String> = [format!("127.0.0.1:{port}"), format!("localhost:{port}")].into();
    let origins = hosts.iter().map(|h| format!("http://{h}")).collect();
    let (tx, _) = broadcast::channel(256);
    let build = opts.public.overlay_build();
    let dev = matches!(opts.public, PublicFiles::Disk(_));
    let state = Arc::new(AppState {
        config: Mutex::new(opts.config),
        secrets: opts.secrets,
        discord: opts.discord,
        assets_dir,
        public: opts.public,
        update: Mutex::new(json!({ "state": "checking" })),
        installer: Mutex::new(None),
        build: Mutex::new(build),
        tx,
        hosts,
        origins,
        port,
        hidden: watch::channel(false).0,
        find_obs: opts.find_obs,
        hotkeys: opts.hotkeys,
    });

    let mut side_tasks = Vec::new();
    // Discord status and voice go out to every page as they change.
    let st = state.clone();
    let mut events = state.discord.subscribe();
    side_tasks.push(tokio::spawn(async move {
        loop {
            match events.recv().await {
                Ok(ServiceEvent::Status(s)) => st.broadcast(json!({ "type": "status", "status": s })),
                Ok(ServiceEvent::Voice(v)) => st.broadcast(json!({ "type": "voice", "voice": v })),
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    st.broadcast(json!({ "type": "status", "status": st.discord.status() }));
                    st.broadcast(json!({ "type": "voice", "voice": st.discord.snapshot() }));
                }
                Err(broadcast::error::RecvError::Closed) => return,
            }
        }
    }));
    // Hotkey choices (and whether Windows accepted them) go out to the editor.
    let st = state.clone();
    let mut hk = state.hotkeys.changes();
    side_tasks.push(tokio::spawn(async move {
        while hk.changed().await.is_ok() {
            st.broadcast(json!({ "type": "hotkeys", "hotkeys": st.hotkeys.view() }));
        }
    }));
    // While developing from a folder, edited overlay files reload open overlays.
    if dev {
        let st = state.clone();
        side_tasks.push(tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(700)).await;
                let next = st.public.overlay_build();
                let changed = {
                    let mut b = st.build.lock().unwrap_or_else(|e| e.into_inner());
                    let changed = *b != next;
                    *b = next.clone();
                    changed
                };
                if changed {
                    st.broadcast(json!({ "type": "build", "build": next }));
                }
            }
        }));
    }

    let app = axum::Router::new().fallback(handle).with_state(state.clone());
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Ok(ServerHandle { url: format!("http://127.0.0.1:{port}"), port, state, task, side_tasks })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::{Status, detached};
    use futures_util::StreamExt;
    use tokio_tungstenite::tungstenite;

    const USER: &str = "123456789012345678";
    const PNG: [u8; 40] = {
        let mut b = [0u8; 40];
        let head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
        let mut i = 0;
        while i < 8 {
            b[i] = head[i];
            i += 1;
        }
        b
    };

    struct Ctx {
        url: String,
        dir: tempfile::TempDir,
        public: tempfile::TempDir,
        srv: ServerHandle,
        ctl: crate::service::DetachedControls,
        http: reqwest::Client,
        /// Where this test's OBS is (None = not on this PC).
        obs: Arc<Mutex<Option<crate::obs::ObsSettings>>>,
    }

    async fn setup() -> Ctx {
        let dir = tempfile::tempdir().unwrap();
        let public = tempfile::tempdir().unwrap();
        for d in ["overlay", "editor", "shared"] {
            std::fs::create_dir(public.path().join(d)).unwrap();
        }
        std::fs::write(public.path().join("overlay/index.html"), "<h1>overlay</h1>").unwrap();
        std::fs::write(public.path().join("editor/index.html"), "<h1>editor</h1>").unwrap();
        std::fs::write(public.path().join("editor/app.js"), "x").unwrap();
        std::fs::write(dir.path().join("outside.txt"), "nope").unwrap();
        let config = ConfigStore::load(dir.path()).unwrap();
        let secrets = Arc::new(SecretStore::new(dir.path()));
        secrets.write(json!({ "clientSecret": "TOPSECRET", "token": { "accessToken": "TOKEN123", "refreshToken": "R", "expiresAt": 1 } }).as_object().unwrap()).unwrap();
        let (discord, ctl) = detached(
            Status { state: "ready".into(), message: String::new() },
            json!({ "channel": { "id": "c1", "name": "General", "guildId": null }, "members": [] }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let obs: Arc<Mutex<Option<crate::obs::ObsSettings>>> = Arc::new(Mutex::new(None));
        let slot = obs.clone();
        let srv = start_server(
            listener,
            ServerOptions {
                data_dir: dir.path().to_path_buf(),
                public: PublicFiles::Disk(public.path().to_path_buf()),
                config,
                secrets,
                discord,
                find_obs: Arc::new(move || slot.lock().unwrap().clone()),
                hotkeys: crate::hotkeys::Hotkeys::load(dir.path(), &crate::HOTKEYS),
            },
        )
        .await
        .unwrap();
        Ctx { url: srv.url.clone(), dir, public, srv, ctl, http: reqwest::Client::new(), obs }
    }

    impl Ctx {
        fn req(&self, method: Method, p: &str) -> reqwest::RequestBuilder {
            self.http.request(method, format!("{}{p}", self.url)).header("Origin", &self.url)
        }
        fn json(&self, method: Method, p: &str, body: &Value) -> reqwest::RequestBuilder {
            self.req(method, p).header("Content-Type", "application/json").body(body.to_string())
        }
    }

    /// A raw HTTP/1.1 request, for headers reqwest won't let us forge (Host).
    async fn raw(url: &str, request: &str) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let addr = url.trim_start_matches("http://");
        let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
        s.write_all(request.as_bytes()).await.unwrap();
        let mut out = Vec::new();
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), s.read_to_end(&mut out)).await;
        String::from_utf8_lossy(&out).into_owned()
    }

    #[tokio::test]
    async fn serves_overlay_and_editor_pages_on_loopback() {
        let c = setup().await;
        assert!(c.url.starts_with("http://127.0.0.1:"));
        let r = c.http.get(format!("{}/overlay/main", c.url)).send().await.unwrap();
        assert_eq!(r.headers()["content-security-policy"], "frame-ancestors 'self'");
        assert_eq!(r.headers()["x-content-type-options"], "nosniff");
        assert_eq!(r.text().await.unwrap(), "<h1>overlay</h1>");
        assert_eq!(c.http.get(format!("{}/editor/", c.url)).send().await.unwrap().text().await.unwrap(), "<h1>editor</h1>");
        let js = c.http.get(format!("{}/editor/app.js", c.url)).send().await.unwrap();
        assert_eq!(js.headers()["content-type"], "text/javascript; charset=utf-8");
        let no_redirect = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap();
        let r = no_redirect.get(format!("{}/", c.url)).send().await.unwrap();
        assert_eq!((r.status().as_u16(), r.headers()["location"].to_str().unwrap()), (302, "/editor/"));
    }

    #[tokio::test]
    async fn static_and_asset_routes_refuse_traversal() {
        let c = setup().await;
        for p in ["/editor/../../outside.txt", "/%2e%2e/outside.txt", "/editor/..%5c..%5coutside.txt", "/assets/..%2foutside.txt", "/assets/../config.json", "/%ff"] {
            let r = raw(&c.url, &format!("GET {p} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n", c.url.trim_start_matches("http://"))).await;
            assert!(r.starts_with("HTTP/1.1 404"), "{p}: {r}");
            assert!(!r.contains("nope"));
        }
    }

    #[tokio::test]
    async fn rejects_a_foreign_host_on_every_route() {
        let c = setup().await;
        for p in ["/editor/", "/api/config", "/overlay/main"] {
            let r = raw(&c.url, &format!("GET {p} HTTP/1.1\r\nHost: evil.example:80\r\nConnection: close\r\n\r\n")).await;
            assert!(r.starts_with("HTTP/1.1 403"), "{p}: {r}");
            assert!(r.contains("forbidden host"));
        }
        let host = c.url.trim_start_matches("http://").replace("127.0.0.1", "localhost");
        let r = raw(&c.url, &format!("GET /api/config HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n")).await;
        assert!(r.starts_with("HTTP/1.1 200"), "{r}");
    }

    #[tokio::test]
    async fn config_round_trip_and_invalid_saves_leave_it_unchanged() {
        let c = setup().await;
        let mut cfg: Value = c.req(Method::GET, "/api/config").send().await.unwrap().json().await.unwrap();
        cfg["presets"][0]["name"] = json!("Stream");
        cfg["users"] = json!([{ "id": USER, "displayName": "Kos" }]);
        let r = c.json(Method::PUT, "/api/config", &cfg).send().await.unwrap();
        assert_eq!(r.status(), 200);
        let saved: Value = r.json().await.unwrap();
        assert_eq!(saved["users"][0]["images"]["idle"], "");

        let mut bad = saved.clone();
        bad["presets"][0]["layout"]["size"] = json!(5);
        let r = c.json(Method::PUT, "/api/config", &bad).send().await.unwrap();
        assert_eq!(r.status(), 400);
        let body: Value = r.json().await.unwrap();
        assert_eq!(body["errors"][0]["path"], "presets[0].layout.size");
        let now: Value = c.req(Method::GET, "/api/config").send().await.unwrap().json().await.unwrap();
        assert_eq!(now, saved);
        let file: Value = serde_json::from_str(&std::fs::read_to_string(c.dir.path().join("config.json")).unwrap()).unwrap();
        assert_eq!(file, saved);
    }

    #[tokio::test]
    async fn mutations_need_a_same_origin_origin_and_json() {
        let c = setup().await;
        let cfg: Value = c.req(Method::GET, "/api/config").send().await.unwrap().json().await.unwrap();
        let r = c.http.put(format!("{}/api/config", c.url)).header("Content-Type", "application/json").body(cfg.to_string()).send().await.unwrap();
        assert_eq!(r.status(), 403);
        let r = c.http.put(format!("{}/api/config", c.url)).header("Origin", "https://evil.example").header("Content-Type", "application/json").body(cfg.to_string()).send().await.unwrap();
        assert_eq!(r.status(), 403);
        let r = c.req(Method::PUT, "/api/config").header("Content-Type", "text/plain").body(cfg.to_string()).send().await.unwrap();
        assert_eq!(r.status(), 415);
        let r = c.req(Method::PUT, "/api/config").header("Content-Type", "application/json").body("{nope").send().await.unwrap();
        assert_eq!(r.status(), 400);
        let r = c.req(Method::POST, "/editor/").send().await.unwrap();
        assert_eq!(r.status(), 405);
    }

    #[tokio::test]
    async fn asset_upload_names_magic_bytes_size_cap_serving_and_delete_guard() {
        let c = setup().await;
        let up = |name: &str, body: Vec<u8>| c.req(Method::POST, &format!("/api/assets?name={name}")).header("Content-Type", "image/png").body(body);
        let r = up("Mi%20Foto%C3%B1.PNG", PNG.to_vec()).send().await.unwrap();
        assert_eq!(r.status(), 201);
        assert_eq!(r.json::<Value>().await.unwrap()["name"], "mi-foton.png");
        let r = up("Mi%20Foto%C3%B1.PNG", PNG.to_vec()).send().await.unwrap();
        assert_eq!(r.json::<Value>().await.unwrap()["name"], "mi-foton-2.png");
        assert_eq!(up("x.exe", PNG.to_vec()).send().await.unwrap().status(), 400);
        assert_eq!(up("fake.png", b"not an image at all".to_vec()).send().await.unwrap().status(), 400);
        assert_eq!(up("big.png", vec![0x89; MAX_IMAGE + 1]).send().await.unwrap().status(), 413);

        let list: Value = c.req(Method::GET, "/api/assets").send().await.unwrap().json().await.unwrap();
        assert_eq!(list, json!([{ "name": "mi-foton-2.png", "size": 40 }, { "name": "mi-foton.png", "size": 40 }]));
        let img = c.http.get(format!("{}/assets/mi-foton.png", c.url)).send().await.unwrap();
        assert_eq!(img.headers()["content-type"], "image/png");
        assert_eq!(img.bytes().await.unwrap().len(), 40);

        let mut cfg: Value = c.req(Method::GET, "/api/config").send().await.unwrap().json().await.unwrap();
        cfg["users"] = json!([{ "id": USER, "displayName": "Kos", "images": { "talking": "mi-foton.png" } }]);
        assert_eq!(c.json(Method::PUT, "/api/config", &cfg).send().await.unwrap().status(), 200);
        let r = c.req(Method::DELETE, "/api/assets/mi-foton.png").send().await.unwrap();
        assert_eq!(r.status(), 409);
        assert_eq!(r.json::<Value>().await.unwrap(), json!({ "error": "image in use", "users": ["Kos"] }));
        assert_eq!(c.req(Method::DELETE, "/api/assets/mi-foton-2.png").send().await.unwrap().status(), 204);
        assert_eq!(c.req(Method::DELETE, "/api/assets/mi-foton-2.png").send().await.unwrap().status(), 404);
    }

    #[tokio::test]
    async fn discord_settings_never_expose_secrets_and_restart_on_save() {
        let mut c = setup().await;
        let view = c.req(Method::GET, "/api/discord").send().await.unwrap().text().await.unwrap();
        assert!(!view.contains("TOPSECRET") && !view.contains("TOKEN123"), "{view}");
        let v: Value = serde_json::from_str(&view).unwrap();
        assert_eq!((v["hasClientSecret"].clone(), v["hasToken"].clone(), v["status"]["state"].clone()), (json!(true), json!(true), json!("ready")));

        let r = c.json(Method::PUT, "/api/discord", &json!({ "clientId": "12" })).send().await.unwrap();
        assert_eq!(r.status(), 400);
        let r = c.json(Method::PUT, "/api/discord", &json!({ "clientId": format!(" {USER} "), "clientSecret": " NEW " })).send().await.unwrap();
        assert_eq!(r.status(), 200);
        let v: Value = r.json().await.unwrap();
        assert_eq!((v["clientId"].clone(), v["hasToken"].clone()), (json!(USER), json!(false)));
        let s: Value = serde_json::from_str(&std::fs::read_to_string(c.dir.path().join("secrets.json")).unwrap()).unwrap();
        assert_eq!(s["clientSecret"], "NEW");
        assert_eq!(c.ctl.restarts(), vec![Some(USER.to_string())]);

        let r = c.req(Method::POST, "/api/discord/logout").send().await.unwrap();
        assert_eq!(r.status(), 200);
        assert_eq!(c.ctl.restarts(), vec![Some(USER.to_string())]);
    }

    async fn ws(c: &Ctx, origin: Option<&str>) -> Result<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>, tungstenite::Error> {
        use tungstenite::client::IntoClientRequest;
        let mut req = format!("{}/ws", c.url.replace("http", "ws")).into_client_request().unwrap();
        if let Some(o) = origin {
            req.headers_mut().insert("Origin", o.parse().unwrap());
        }
        tokio_tungstenite::connect_async(req).await.map(|(s, _)| s)
    }

    async fn next_json(s: &mut tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>) -> Value {
        loop {
            let m = tokio::time::timeout(std::time::Duration::from_secs(3), s.next()).await.unwrap().unwrap().unwrap();
            if let tungstenite::Message::Text(t) = m {
                return serde_json::from_str(t.as_str()).unwrap();
            }
        }
    }

    #[tokio::test]
    async fn hiding_reaches_every_overlay_and_new_ones_start_hidden() {
        let c = setup().await;
        let mut s = ws(&c, None).await.unwrap();
        assert_eq!(next_json(&mut s).await["hidden"], false);
        let mut hidden = c.srv.hidden_watch();
        let r = c.json(Method::POST, "/api/overlay/hidden", &json!({ "hidden": true })).send().await.unwrap();
        assert_eq!(r.status(), 200);
        assert_eq!(next_json(&mut s).await, json!({ "type": "hidden", "hidden": true }));
        assert!(hidden.has_changed().unwrap() && *hidden.borrow_and_update(), "the tray follows the editor");
        let mut late = ws(&c, None).await.unwrap();
        assert_eq!(next_json(&mut late).await["hidden"], true, "an overlay (re)loaded while hidden stays hidden");

        c.srv.set_hidden(false); // tray or hotkey
        assert_eq!(next_json(&mut s).await, json!({ "type": "hidden", "hidden": false }));
        assert!(!c.srv.hidden());
        assert_eq!(c.json(Method::POST, "/api/overlay/hidden", &json!({ "hidden": "yes" })).send().await.unwrap().status(), 400);
        let foreign = c.http.post(format!("{}/api/overlay/hidden", c.url)).header("Origin", "https://evil.example").header("Content-Type", "application/json").body(r#"{"hidden":true}"#);
        assert_eq!(foreign.send().await.unwrap().status(), 403);
        assert!(!c.srv.hidden());
    }

    #[tokio::test]
    async fn hotkeys_can_be_changed_and_the_editor_hears_about_it() {
        let c = setup().await;
        let mut s = ws(&c, None).await.unwrap();
        assert_eq!(next_json(&mut s).await["hotkeys"], json!([{ "id": "hide", "key": "Ctrl+Alt+Shift+H", "default": "Ctrl+Alt+Shift+H", "error": null }]));
        let put = |body: Value| c.json(Method::PUT, "/api/hotkeys", &body).send();
        let r = put(json!({ "id": "hide", "key": "shift+h" })).await.unwrap();
        assert_eq!((r.status().as_u16(), r.json::<Value>().await.unwrap()["error"].clone()), (400, json!("needs_modifier")));
        let r = put(json!({ "id": "hide", "key": "alt+f9" })).await.unwrap();
        assert_eq!(r.status(), 200);
        assert_eq!(r.json::<Value>().await.unwrap()[0]["key"], "Alt+F9");
        assert_eq!(next_json(&mut s).await["hotkeys"][0]["key"], "Alt+F9");
        let saved: Value = serde_json::from_str(&std::fs::read_to_string(c.dir.path().join("hotkeys.json")).unwrap()).unwrap();
        assert_eq!(saved, json!({ "hide": "Alt+F9" }));

        let pause = c.json(Method::POST, "/api/hotkeys/pause", &json!({ "paused": true })).send().await.unwrap();
        assert_eq!(pause.status(), 200);
        let foreign = c.http.put(format!("{}/api/hotkeys", c.url)).header("Origin", "https://evil.example").header("Content-Type", "application/json").body(r#"{"id":"hide","key":""}"#);
        assert_eq!(foreign.send().await.unwrap().status(), 403);
    }

    #[tokio::test]
    async fn add_to_obs_creates_the_browser_source_and_explains_failures() {
        let c = setup().await;
        let add = |body: Value| c.json(Method::POST, "/api/obs/add", &body).send();
        let r = add(json!({ "preset": "main", "width": 1920, "height": 1080 })).await.unwrap();
        assert_eq!(r.status(), 409);
        assert_eq!(r.json::<Value>().await.unwrap()["error"], "obs_not_found");

        let obs = crate::obs::fake::start("pw", crate::obs::fake::World { program: "Live".into(), scenes: vec!["Live".into()], ..Default::default() }).await;
        *c.obs.lock().unwrap() = Some(crate::obs::ObsSettings { enabled: true, url: obs.url.clone(), password: "pw".into() });
        assert_eq!(add(json!({ "preset": "nope", "width": 10, "height": 10 })).await.unwrap().status(), 404);
        assert_eq!(add(json!({ "preset": "main", "width": 0, "height": 10 })).await.unwrap().status(), 400);
        let r = add(json!({ "preset": "main", "width": 1920, "height": 1080 })).await.unwrap();
        assert_eq!(r.status(), 200);
        assert_eq!(r.json::<Value>().await.unwrap(), json!({ "result": "created", "name": "Kosmik Voice", "scene": "Live", "addedToScene": true }));
        let w = obs.world.lock().unwrap();
        assert_eq!(w.inputs[0].2["url"], json!(format!("http://127.0.0.1:{}/overlay/main", c.srv.port)));
    }

    #[tokio::test]
    async fn websocket_hello_live_broadcasts_and_foreign_origins_refused() {
        let c = setup().await;
        let mut s = ws(&c, Some(&c.url)).await.unwrap();
        let hello = next_json(&mut s).await;
        assert_eq!(hello["type"], "hello");
        assert_eq!(hello["version"], crate::VERSION);
        assert_eq!(hello["status"]["state"], "ready");
        assert_eq!(hello["voice"]["channel"]["id"], "c1");
        assert_eq!(hello["update"]["state"], "checking");
        assert_eq!(hello["config"]["presets"][0]["id"], "main");
        assert_eq!(hello["build"].as_str().unwrap().len(), 12);

        c.ctl.set_voice(json!({ "channel": null, "members": [] }));
        assert_eq!(next_json(&mut s).await, json!({ "type": "voice", "voice": { "channel": null, "members": [] } }));
        c.ctl.set_status("discord_closed", "x");
        assert_eq!(next_json(&mut s).await["status"]["state"], "discord_closed");
        let cfg: Value = c.req(Method::GET, "/api/config").send().await.unwrap().json().await.unwrap();
        c.json(Method::PUT, "/api/config", &cfg).send().await.unwrap();
        assert_eq!(next_json(&mut s).await["type"], "config");
        c.srv.set_update(json!({ "state": "current" }));
        assert_eq!(next_json(&mut s).await, json!({ "type": "update", "update": { "state": "current" } }));
        s.close(None).await.unwrap();

        assert!(ws(&c, None).await.is_ok(), "no Origin (OBS, tools) is allowed");
        assert!(ws(&c, Some("https://evil.example")).await.is_err());
    }

    #[tokio::test]
    async fn install_runs_only_with_an_installable_update_and_from_our_own_pages() {
        let c = setup().await;
        let hits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let install = |c: &Ctx| c.req(Method::POST, "/api/update/install").send();
        assert_eq!(install(&c).await.unwrap().status(), 409, "no installer yet");
        let h = hits.clone();
        c.srv.set_installer(Arc::new(move || {
            h.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }));
        assert_eq!(install(&c).await.unwrap().status(), 409, "nothing to install");
        c.srv.set_update(json!({ "state": "available", "via": "app", "install": true, "latest": { "version": "9.0.0" } }));
        let foreign = reqwest::Client::new().post(format!("{}/api/update/install", c.url)).header("Origin", "https://evil.example").send().await.unwrap();
        assert_eq!(foreign.status(), 403);
        assert_eq!(install(&c).await.unwrap().status(), 202);
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn editing_an_overlay_file_broadcasts_a_new_build_but_identical_content_does_not() {
        let c = setup().await;
        let mut s = ws(&c, Some(&c.url)).await.unwrap();
        let first = next_json(&mut s).await["build"].clone();
        std::fs::write(c.public.path().join("overlay/index.html"), "<h1>overlay</h1>").unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(900)).await;
        std::fs::write(c.public.path().join("overlay/index.html"), "<h1>overlay v2</h1>").unwrap();
        let msg = next_json(&mut s).await;
        assert_eq!(msg["type"], "build");
        assert_ne!(msg["build"], first);
        s.close(None).await.ok();
    }

    #[tokio::test]
    async fn a_refused_upgrade_followed_by_a_reset_does_not_break_the_server() {
        let c = setup().await;
        for _ in 0..3 {
            let addr = c.url.trim_start_matches("http://").to_string();
            let mut s = tokio::net::TcpStream::connect(&addr).await.unwrap();
            use tokio::io::AsyncWriteExt;
            s.write_all(format!("GET /ws HTTP/1.1\r\nHost: {addr}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nOrigin: https://evil.example\r\nSec-WebSocket-Key: x\r\nSec-WebSocket-Version: 13\r\n\r\n").as_bytes()).await.unwrap();
            drop(s);
        }
        assert_eq!(c.req(Method::GET, "/api/config").send().await.unwrap().status(), 200);
    }

    #[test]
    fn sanitize_image_names() {
        assert_eq!(sanitize_image_name("Café Ñandú.JPEG").as_deref(), Some("cafe-nandu.jpeg"));
        assert_eq!(sanitize_image_name("C:\\fakepath\\me.png").as_deref(), Some("me.png"));
        assert_eq!(sanitize_image_name("!!!.gif").as_deref(), Some("image.gif"));
        assert_eq!(sanitize_image_name(".png"), None);
        assert_eq!(sanitize_image_name("a.svg"), None);
        assert_eq!(sanitize_image_name(&format!("{}.png", "a".repeat(90))).unwrap().len(), 64);
    }

    #[test]
    fn embedded_files_resolve_with_forward_slashes() {
        let p = PublicFiles::Embedded(&crate::PUBLIC);
        assert!(p.get("editor/index.html").is_some());
        assert!(p.get("overlay/overlay.js").is_some());
        assert!(!p.list("shared").is_empty());
        assert_eq!(p.overlay_build(), PublicFiles::Disk(PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../public"))).overlay_build());
    }
}
