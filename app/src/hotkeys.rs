//! Configurable global hotkeys: which key combination does what, saved in hotkeys.json in the data
//! folder. The tray app registers them with Windows (main.rs); this module keeps the choice, checks
//! it, and holds what Windows said about it, for the page to show. Same file in Kosmik Voice and
//! Kosmik Layouts; only the actions differ.

use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::watch;

/// Something a hotkey can do, and its key combination out of the box.
pub struct Action {
    pub id: &'static str,
    pub default: &'static str,
}

/// "Ctrl+Alt+Shift+H" style, case and spacing free. Ok("") = no hotkey. Errors are codes the page
/// shows a message for: "needs_modifier" (a plain key or Shift+key would fire while typing),
/// "unsupported_key" (only A-Z, 0-9 and F1-F24).
pub fn normalize(input: &str) -> Result<String, &'static str> {
    let input = input.trim();
    if input.is_empty() {
        return Ok(String::new());
    }
    let (mut ctrl, mut alt, mut shift) = (false, false, false);
    let mut key: Option<String> = None;
    for part in input.split('+').map(str::trim) {
        match part.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => ctrl = true,
            "alt" => alt = true,
            "shift" => shift = true,
            k => {
                if key.is_some() {
                    return Err("unsupported_key");
                }
                key = Some(key_name(k).ok_or("unsupported_key")?);
            }
        }
    }
    let key = key.ok_or("unsupported_key")?;
    // F13-F24 exist only for macro pads and Stream Decks, so they may go alone.
    let spare = key.strip_prefix('F').and_then(|n| n.parse::<u8>().ok()).is_some_and(|n| n >= 13);
    if !(ctrl || alt || spare) {
        return Err("needs_modifier");
    }
    let mut out: Vec<&str> = Vec::new();
    if ctrl {
        out.push("Ctrl");
    }
    if alt {
        out.push("Alt");
    }
    if shift {
        out.push("Shift");
    }
    out.push(&key);
    Ok(out.join("+"))
}

fn key_name(k: &str) -> Option<String> {
    let mut chars = k.chars();
    match (chars.next(), chars.next()) {
        (Some(c), None) if c.is_ascii_alphanumeric() => Some(c.to_ascii_uppercase().to_string()),
        (Some('f'), Some(_)) => k[1..].parse::<u8>().ok().filter(|n| (1..=24).contains(n)).map(|n| format!("F{n}")),
        _ => None,
    }
}

/// The form the global-shortcut plugin parses: "ctrl+alt+shift+KeyH".
pub fn plugin_form(canonical: &str) -> String {
    canonical
        .split('+')
        .map(|p| match p {
            "Ctrl" => "ctrl".to_string(),
            "Alt" => "alt".to_string(),
            "Shift" => "shift".to_string(),
            k if k.len() == 1 && k.as_bytes()[0].is_ascii_digit() => format!("Digit{k}"),
            k if k.len() == 1 => format!("Key{k}"),
            k => k.to_string(),
        })
        .collect::<Vec<_>>()
        .join("+")
}

pub struct Hotkeys {
    file: PathBuf,
    actions: &'static [Action],
    /// (action id, key combination or "" for none), in the order of `actions`.
    keys: watch::Sender<Vec<(String, String)>>,
    /// Action id -> why Windows refused it ("taken").
    errors: Mutex<Map<String, Value>>,
    /// While the page waits for a new combination, nothing is registered (so even the current one
    /// reaches the page). Ends by itself after `pause_limit` in case the page goes away.
    paused: watch::Sender<bool>,
    pause_gen: AtomicU64,
    pause_limit: Duration,
    /// Bumped whenever anything the page shows changes.
    changed: watch::Sender<u64>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Hotkeys {
    /// Reads hotkeys.json; missing or unusable entries get their default.
    pub fn load(dir: &Path, actions: &'static [Action]) -> Arc<Hotkeys> {
        let file = dir.join("hotkeys.json");
        let saved: Value = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
        let keys = actions
            .iter()
            .map(|a| {
                let key = saved.get(a.id).and_then(Value::as_str).and_then(|k| normalize(k).ok()).unwrap_or_else(|| a.default.to_string());
                (a.id.to_string(), key)
            })
            .collect();
        Arc::new(Hotkeys {
            file,
            actions,
            keys: watch::channel(keys).0,
            errors: Mutex::new(Map::new()),
            paused: watch::channel(false).0,
            pause_gen: AtomicU64::new(0),
            pause_limit: Duration::from_secs(30),
            changed: watch::channel(0).0,
        })
    }

    pub fn keys(&self) -> Vec<(String, String)> {
        self.keys.borrow().clone()
    }

    /// The key combination for an action ("" = none).
    pub fn key(&self, id: &str) -> String {
        self.keys.borrow().iter().find(|(a, _)| a == id).map(|(_, k)| k.clone()).unwrap_or_default()
    }

    pub fn keys_watch(&self) -> watch::Receiver<Vec<(String, String)>> {
        self.keys.subscribe()
    }

    pub fn paused_watch(&self) -> watch::Receiver<bool> {
        self.paused.subscribe()
    }

    pub fn changes(&self) -> watch::Receiver<u64> {
        self.changed.subscribe()
    }

    /// Changes one action's key ("" = none) and saves. Errors: "unknown_action", "needs_modifier",
    /// "unsupported_key", "in_use_here" (another action of this app has it), "io".
    pub fn set(&self, id: &str, key: &str) -> Result<String, &'static str> {
        if !self.actions.iter().any(|a| a.id == id) {
            return Err("unknown_action");
        }
        let key = normalize(key)?;
        let mut next = self.keys();
        if !key.is_empty() && next.iter().any(|(a, k)| a != id && *k == key) {
            return Err("in_use_here");
        }
        for (a, k) in next.iter_mut() {
            if a == id {
                *k = key.clone();
            }
        }
        let doc: Map<String, Value> = next.iter().map(|(a, k)| (a.clone(), json!(k))).collect();
        let tmp = self.file.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(&doc).unwrap_or_default() + "\n").and_then(|_| std::fs::rename(&tmp, &self.file)).map_err(|_| "io")?;
        lock(&self.errors).remove(id);
        self.keys.send_replace(next);
        self.changed.send_modify(|n| *n += 1);
        Ok(key)
    }

    /// What Windows said when the tray app registered it (None = fine).
    pub fn set_error(&self, id: &str, error: Option<&'static str>) {
        let mut errors = lock(&self.errors);
        let before = errors.get(id).cloned();
        match error {
            Some(e) => errors.insert(id.to_string(), json!(e)),
            None => errors.remove(id),
        };
        if errors.get(id) != before.as_ref() {
            drop(errors);
            self.changed.send_modify(|n| *n += 1);
        }
    }

    /// For the page: [{ id, key, default, error }] in action order.
    pub fn view(&self) -> Value {
        let errors = lock(&self.errors).clone();
        Value::Array(
            self.actions
                .iter()
                .map(|a| json!({ "id": a.id, "key": self.key(a.id), "default": a.default, "error": errors.get(a.id).cloned().unwrap_or(Value::Null) }))
                .collect(),
        )
    }

    pub fn paused(&self) -> bool {
        *self.paused.borrow()
    }

    /// Pause while the page waits for a new combination; resumes by itself after a while.
    pub fn pause(self: &Arc<Self>, on: bool) {
        let g = self.pause_gen.fetch_add(1, Ordering::SeqCst) + 1;
        self.paused.send_if_modified(|p| std::mem::replace(p, on) != on);
        if on {
            let me = Arc::downgrade(self);
            let limit = self.pause_limit;
            tokio::spawn(async move {
                tokio::time::sleep(limit).await;
                if let Some(me) = me.upgrade() {
                    if me.pause_gen.load(Ordering::SeqCst) == g {
                        me.paused.send_replace(false);
                    }
                }
            });
        }
    }

    #[cfg(test)]
    fn with_pause_limit(mut self: Arc<Self>, limit: Duration) -> Arc<Self> {
        Arc::get_mut(&mut self).expect("not shared yet").pause_limit = limit;
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    static ACTIONS: [Action; 2] = [Action { id: "hide", default: "Ctrl+Alt+Shift+H" }, Action { id: "next", default: "Ctrl+Alt+Shift+N" }];

    #[test]
    fn normalizes_and_refuses_keys_that_would_fire_while_typing() {
        assert_eq!(normalize(" shift + ctrl+alt+h "), Ok("Ctrl+Alt+Shift+H".into()));
        assert_eq!(normalize("control+F5"), Ok("Ctrl+F5".into()));
        assert_eq!(normalize("alt+7"), Ok("Alt+7".into()));
        assert_eq!(normalize("F13"), Ok("F13".into()), "macro-pad keys may go alone");
        assert_eq!(normalize(""), Ok(String::new()));
        assert_eq!(normalize("H"), Err("needs_modifier"));
        assert_eq!(normalize("Shift+H"), Err("needs_modifier"));
        assert_eq!(normalize("F5"), Err("needs_modifier"));
        assert_eq!(normalize("Ctrl+Space"), Err("unsupported_key"));
        assert_eq!(normalize("Ctrl+F25"), Err("unsupported_key"));
        assert_eq!(normalize("Ctrl+A+B"), Err("unsupported_key"));
        assert_eq!(normalize("Ctrl+Alt"), Err("unsupported_key"));
        assert_eq!(plugin_form("Ctrl+Alt+Shift+H"), "ctrl+alt+shift+KeyH");
        assert_eq!(plugin_form("Alt+7"), "alt+Digit7");
        assert_eq!(plugin_form("F13"), "F13");
        for k in ["Ctrl+Alt+Shift+H", "Alt+7", "Ctrl+F5", "F13", "Ctrl+Shift+Z", "Alt+0", "Ctrl+F24"] {
            let s: tauri_plugin_global_shortcut::Shortcut = plugin_form(k).parse().unwrap_or_else(|e| panic!("{k}: {e}"));
            assert_eq!(s, plugin_form(&normalize(k).unwrap()).parse().unwrap());
        }
    }

    #[test]
    fn defaults_saved_choices_and_conflicts() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("hotkeys.json"), r#"{ "hide": "alt+F9", "next": "nonsense" }"#).unwrap();
        let hk = Hotkeys::load(dir.path(), &ACTIONS);
        assert_eq!(hk.keys(), vec![("hide".into(), "Alt+F9".into()), ("next".into(), "Ctrl+Alt+Shift+N".into())], "unusable entries fall back to the default");

        let mut changes = hk.changes();
        assert_eq!(hk.set("next", "Alt+F9"), Err("in_use_here"));
        assert_eq!(hk.set("next", "Shift+N"), Err("needs_modifier"));
        assert_eq!(hk.set("nope", "Alt+1"), Err("unknown_action"));
        assert!(!changes.has_changed().unwrap(), "refused changes change nothing");
        hk.set_error("hide", Some("taken"));
        assert_eq!(hk.view()[0]["error"], "taken");
        assert_eq!(hk.set("hide", ""), Ok(String::new()), "off");
        assert_eq!(hk.view()[0], json!({ "id": "hide", "key": "", "default": "Ctrl+Alt+Shift+H", "error": null }), "a new choice clears the old error");
        assert!(changes.has_changed().unwrap());

        let again = Hotkeys::load(dir.path(), &ACTIONS);
        assert_eq!(again.key("hide"), "", "turned off stays off after a restart");
        assert_eq!(again.key("next"), "Ctrl+Alt+Shift+N");
    }

    #[tokio::test]
    async fn a_pause_ends_by_itself_if_the_page_goes_away() {
        let dir = tempfile::tempdir().unwrap();
        let hk = Hotkeys::load(dir.path(), &ACTIONS).with_pause_limit(Duration::from_millis(80));
        hk.pause(true);
        assert!(hk.paused());
        tokio::time::sleep(Duration::from_millis(40)).await;
        hk.pause(true); // still capturing: the clock starts again
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert!(hk.paused());
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert!(!hk.paused());
        hk.pause(true);
        hk.pause(false);
        assert!(!hk.paused());
    }
}
