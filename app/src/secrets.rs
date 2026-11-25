//! secrets.json: the Discord client secret and tokens. Never sent to the browser.

use crate::config::write_json_atomic;
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub struct SecretStore {
    file: PathBuf,
    lock: Mutex<()>,
}

impl SecretStore {
    pub fn new(dir: &Path) -> Self {
        SecretStore { file: dir.join("secrets.json"), lock: Mutex::new(()) }
    }

    pub fn read(&self) -> Map<String, Value> {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        self.read_unlocked()
    }

    fn read_unlocked(&self) -> Map<String, Value> {
        std::fs::read_to_string(&self.file)
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(raw.trim_start_matches('\u{feff}')).ok())
            .and_then(|v| match v {
                Value::Object(m) => Some(m),
                _ => None,
            })
            .unwrap_or_default()
    }

    pub fn write(&self, data: &Map<String, Value>) -> std::io::Result<()> {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        write_json_atomic(&self.file, &Value::Object(data.clone()))
    }

    /// Read, change and write under one lock.
    pub fn update(&self, f: impl FnOnce(&mut Map<String, Value>)) -> std::io::Result<Map<String, Value>> {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut data = self.read_unlocked();
        f(&mut data);
        write_json_atomic(&self.file, &Value::Object(data.clone()))?;
        Ok(data)
    }

    /// Public view: never returns the secret or the tokens themselves.
    pub fn status(&self) -> Value {
        let s = self.read();
        let has_secret = s.get("clientSecret").is_some_and(truthy);
        let has_token = s.get("token").and_then(|t| t.get("accessToken")).is_some_and(truthy);
        json!({ "hasClientSecret": has_secret, "hasToken": has_token })
    }
}

/// JavaScript truthiness for JSON values.
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// A string field that is set and non-empty.
pub fn str_field<'a>(m: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    m.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}
