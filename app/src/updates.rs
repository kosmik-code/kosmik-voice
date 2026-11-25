//! Updates for the installed app. Tauri's updater reads latest.json from the newest GitHub release
//! and only accepts an installer signed with the key whose public half is in tauri.conf.json.
//! Installing (from the tray or the editor's banner) runs the installer without questions and it
//! starts the app again; settings in the data folder are untouched.
//!   KV_UPDATE_URL  use this latest.json instead (testing)

use kosmik_voice::{log, server::ServerHandle, update::REPO};
use serde_json::json;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::{AppHandle, Wry};
use tauri_plugin_updater::{Update, Updater, UpdaterExt};

const FIRST_CHECK: Duration = Duration::from_secs(10);
const EVERY: Duration = Duration::from_secs(6 * 60 * 60);
/// Written just before installing, so the restarted app doesn't open another editor tab.
pub const UPDATED_FLAG: &str = "updated.flag";

pub struct Labels {
    /// "{version}" is replaced.
    pub install: &'static str,
    pub installing: &'static str,
}

pub struct Updates {
    app: AppHandle,
    server: Arc<ServerHandle>,
    menu: Menu<Wry>,
    item: MenuItem<Wry>,
    labels: Labels,
    flag: PathBuf,
    pending: Mutex<Option<Update>>,
    in_menu: AtomicBool,
    installing: AtomicBool,
}

impl Updates {
    pub fn new(app: AppHandle, server: Arc<ServerHandle>, menu: Menu<Wry>, labels: Labels, data_dir: PathBuf) -> tauri::Result<Arc<Self>> {
        let item = MenuItem::with_id(&app, "update", "", true, None::<&str>)?;
        Ok(Arc::new(Updates {
            app,
            server,
            menu,
            item,
            labels,
            flag: data_dir.join(UPDATED_FLAG),
            pending: Mutex::new(None),
            in_menu: AtomicBool::new(false),
            installing: AtomicBool::new(false),
        }))
    }

    /// Checks shortly after start, then every few hours: the app runs for days at a time.
    pub fn watch(self: &Arc<Self>) {
        let me = self.clone();
        let install = self.clone();
        self.server.set_installer(Arc::new(move || install.install()));
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(FIRST_CHECK).await;
            loop {
                me.check().await;
                tokio::time::sleep(EVERY).await;
            }
        });
    }

    fn updater(&self) -> Result<Updater, String> {
        let mut b = self.app.updater_builder();
        if let Some(url) = std::env::var("KV_UPDATE_URL").ok().filter(|u| !u.is_empty()) {
            b = b.endpoints(vec![url.parse::<tauri::Url>().map_err(|e| e.to_string())?]).map_err(|e| e.to_string())?;
        }
        b.build().map_err(|e| e.to_string())
    }

    fn pending(&self) -> Option<Update> {
        self.pending.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    async fn check(&self) {
        if self.installing.load(Ordering::SeqCst) {
            return;
        }
        let found = match self.updater() {
            Ok(u) => u.check().await.map_err(|e| e.to_string()),
            Err(e) => Err(e),
        };
        match found {
            Ok(Some(update)) => self.offer(update, None),
            Ok(None) if self.pending().is_none() => self.server.set_update(json!({ "state": "current", "via": "app" })),
            Ok(None) => {}
            Err(e) => {
                log::line(format!("[update] check failed: {e}"));
                if self.pending().is_none() {
                    self.server.set_update(json!({ "state": "unknown", "via": "app" }));
                }
            }
        }
    }

    fn offer(&self, update: Update, error: Option<String>) {
        let version = update.version.clone();
        if error.is_none() && self.pending().is_none_or(|p| p.version != version) {
            log::line(format!("Update available: version {version}"));
        }
        *self.pending.lock().unwrap_or_else(|e| e.into_inner()) = Some(update);
        let mut state = json!({
            "state": "available",
            "via": "app",
            "install": true,
            "behind": null,
            "url": format!("https://github.com/{REPO}/releases/tag/v{version}"),
            "latest": { "version": version },
        });
        if let Some(e) = error {
            state["error"] = json!(e);
        }
        self.server.set_update(state);
        let _ = self.item.set_text(self.labels.install.replace("{version}", &version));
        let _ = self.item.set_enabled(true);
        if !self.in_menu.swap(true, Ordering::SeqCst) {
            let _ = self.menu.insert(&self.item, 0);
        }
    }

    /// Downloads, checks the signature and runs the installer, which closes this copy and starts the new one.
    pub fn install(self: &Arc<Self>) {
        let Some(update) = self.pending() else { return };
        if self.installing.swap(true, Ordering::SeqCst) {
            return;
        }
        log::line(format!("[update] installing version {}", update.version));
        self.server.set_update(json!({ "state": "installing", "via": "app", "latest": { "version": update.version } }));
        let _ = self.item.set_text(self.labels.installing);
        let _ = self.item.set_enabled(false);
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            let _ = std::fs::write(&me.flag, "");
            // On success this doesn't return: the installer takes over and the process exits.
            let result = update.download_and_install(|_, _| {}, || {}).await;
            let _ = std::fs::remove_file(&me.flag);
            let e = result.err().map(|e| e.to_string()).unwrap_or_else(|| "the installer did not start".into());
            log::line(format!("[update] install failed: {e}"));
            me.installing.store(false, Ordering::SeqCst);
            me.offer(update, Some(e));
        });
    }
}
