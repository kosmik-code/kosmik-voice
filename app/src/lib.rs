//! Kosmik Voice backend: Discord local RPC, the config store and the local web server that serves
//! the editor and the OBS overlays. The tray app (main.rs) is a thin shell around `start`.

pub mod auth;
pub mod config;
pub mod hotkeys;
pub mod ipc;
pub mod log;
pub mod obs;
pub mod procs;
pub mod secrets;
pub mod server;
pub mod service;
pub mod update;
pub mod voice;

use include_dir::{Dir, include_dir};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

/// The editor and overlay pages, built into the program.
pub static PUBLIC: Dir<'static> = include_dir!("$CARGO_MANIFEST_DIR/../public");

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const DEFAULT_PORT: u16 = 7429;

/// What the global hotkeys can do, with their out-of-the-box keys (changeable in the editor).
pub static HOTKEYS: [hotkeys::Action; 1] = [hotkeys::Action { id: "hide", default: "Ctrl+Alt+Shift+H" }];

pub struct Options {
    pub port: u16,
    pub data_dir: PathBuf,
    /// Serve the pages from this folder instead of the built-in copy (development).
    pub public_dir: Option<PathBuf>,
    pub update_check: bool,
    /// The tray app's updater handles updates; skip the plain release check.
    pub app_updater: bool,
    pub pipe_paths: Vec<String>,
}

/// %APPDATA%\Kosmik Voice
pub fn default_data_dir() -> PathBuf {
    std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(".")).join("Kosmik Voice")
}

impl Options {
    /// Reads KV_PORT, KV_DATA_DIR, KV_PUBLIC_DIR and KV_UPDATE_CHECK.
    pub fn from_env() -> Self {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        Options {
            port: var("KV_PORT").and_then(|p| p.parse().ok()).unwrap_or(DEFAULT_PORT),
            data_dir: var("KV_DATA_DIR").map(PathBuf::from).unwrap_or_else(default_data_dir),
            public_dir: var("KV_PUBLIC_DIR").map(PathBuf::from),
            update_check: var("KV_UPDATE_CHECK").as_deref() != Some("0"),
            app_updater: false,
            pipe_paths: ipc::default_pipe_paths(),
        }
    }
}

pub struct App {
    pub url: String,
    pub data_dir: PathBuf,
    pub discord: service::DiscordHandle,
    pub server: Arc<server::ServerHandle>,
    pub hotkeys: Arc<hotkeys::Hotkeys>,
}

#[derive(Debug)]
pub enum StartError {
    PortBusy(u16),
    Other(String),
}

impl std::fmt::Display for StartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StartError::PortBusy(p) => write!(f, "port {p} is busy"),
            StartError::Other(m) => f.write_str(m),
        }
    }
}

/// Starts everything on the current Tokio runtime.
pub async fn start(opts: Options) -> Result<App, StartError> {
    let other = |e: std::io::Error| StartError::Other(e.to_string());
    std::fs::create_dir_all(&opts.data_dir).map_err(other)?;
    log::to_file(&opts.data_dir.join("kosmik-voice.log"));
    log::line(format!("Kosmik Voice {VERSION}, data in {}", opts.data_dir.display()));

    // Bind first: if another copy is running, stop before touching Discord.
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", opts.port)).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::AddrInUse || e.raw_os_error() == Some(10013) { StartError::PortBusy(opts.port) } else { other(e) }
    })?;

    let config = config::ConfigStore::load(&opts.data_dir).map_err(other)?;
    let hotkeys = hotkeys::Hotkeys::load(&opts.data_dir, &HOTKEYS);
    let client_id = config.current()["discord"]["clientId"].as_str().unwrap_or("").to_string();
    let secrets = Arc::new(secrets::SecretStore::new(&opts.data_dir));
    let http = reqwest::Client::builder().user_agent(format!("kosmik-voice/{VERSION}")).timeout(Duration::from_secs(20)).build().map_err(|e| StartError::Other(e.to_string()))?;

    let discord = service::spawn(service::ServiceOptions {
        client_id,
        secrets: secrets.clone(),
        pipe_paths: opts.pipe_paths,
        retry: Duration::from_secs(5),
        timeout: Duration::from_secs(15),
        fetch: auth::http_token_fetch(http.clone()),
    });
    let mut status = discord.status_watch();
    tokio::spawn(async move {
        let mut last = None;
        while status.changed().await.is_ok() {
            let s = status.borrow_and_update().clone();
            // Retries while Discord is closed repeat the same status: log it once.
            if last.as_ref() != Some(&s) {
                log::line(format!("[discord] {}{}", s.state, if s.message.is_empty() { String::new() } else { format!(": {}", s.message) }));
                last = Some(s);
            }
        }
    });
    // Discord closed: check every second whether it started, and connect right away when it does
    // (instead of at the next retry). Discord restarts itself for its own updates quite often.
    let d = discord.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            if d.status().state != "discord_closed" {
                continue;
            }
            if let Ok(Ok(running)) = tokio::task::spawn_blocking(procs::list_processes).await {
                if procs::discord_running(&running) {
                    d.nudge();
                }
            }
        }
    });

    let public = match opts.public_dir {
        Some(dir) => server::PublicFiles::Disk(dir),
        None => server::PublicFiles::Embedded(&PUBLIC),
    };
    let server = Arc::new(
        server::start_server(
            listener,
            server::ServerOptions {
                data_dir: opts.data_dir.clone(),
                public,
                config,
                secrets,
                discord: discord.clone(),
                find_obs: Arc::new(|| obs::read_obs_settings(std::env::var_os("APPDATA").map(PathBuf::from).as_deref())),
                hotkeys: hotkeys.clone(),
            },
        )
            .await
            .map_err(other)?,
    );
    log::line(format!("Editor:  {}/editor/", server.url));
    log::line(format!("Overlay: {}/overlay/<preset-id>", server.url));

    if !opts.update_check {
        server.set_update(serde_json::json!({ "state": "disabled" }));
    } else if !opts.app_updater {
        let srv = server.clone();
        tokio::spawn(async move {
            let u = update::check_for_update(&http, VERSION).await;
            if u["state"] == "available" {
                log::line(format!("Update available: version {}. Download it from {}", u["latest"]["version"].as_str().unwrap_or("?"), u["url"].as_str().unwrap_or("")));
            }
            srv.set_update(u);
        });
    }

    Ok(App { url: server.url.clone(), data_dir: opts.data_dir, discord, server, hotkeys })
}

