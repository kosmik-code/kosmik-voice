//! Config schema, defaults, validation and atomic JSON persistence for the editor.

use serde::Serialize;
use serde_json::{Map, Value, json};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

pub const LIMIT_USERS: usize = 50;
pub const LIMIT_PRESETS: usize = 20;
pub const LIMIT_PRESET_USERS: usize = 25;
pub const IMAGE_STATES: [&str; 4] = ["idle", "talking", "muted", "deafened"];
/// OBS canvas the preset is designed for (editor preview and OBS size guidance; the overlay ignores it).
pub const CANVASES: &[&str] = &["1920x1080", "2560x1440", "1280x720", "1080x1920"];
/// Overlay themes (.theme-<id> in public/overlay/overlay.css). Additive only: old configs must stay valid.
pub const THEMES: &[&str] = &["pixel-cafe", "clean", "neon", "comic", "glass"];

#[derive(Clone, Copy)]
enum Kind {
    Enum(&'static [&'static str]),
    Int(i64, i64),
    Num(f64, f64),
    Bool,
    Color,
    OptColor,
    Str(usize, usize),
}

#[derive(Clone, Copy)]
enum Def {
    S(&'static str),
    I(i64),
    F(f64),
    B(bool),
}

impl Def {
    fn value(self) -> Value {
        match self {
            Def::S(s) => json!(s),
            Def::I(i) => json!(i),
            Def::F(f) => json!(f),
            Def::B(b) => json!(b),
        }
    }
}

type Field = (&'static str, Kind, Def);

const LAYOUT: &[Field] = &[
    ("direction", Kind::Enum(&["row", "column", "grid"]), Def::S("row")),
    ("columns", Kind::Int(1, 12), Def::I(4)),
    ("alignX", Kind::Enum(&["left", "center", "right"]), Def::S("left")),
    ("alignY", Kind::Enum(&["top", "center", "bottom"]), Def::S("top")),
    ("offsetX", Kind::Int(-4000, 4000), Def::I(0)),
    ("offsetY", Kind::Int(-4000, 4000), Def::I(0)),
    ("gap", Kind::Int(0, 400), Def::I(24)),
    ("padding", Kind::Int(0, 400), Def::I(24)),
    ("size", Kind::Int(32, 1024), Def::I(160)),
    // "canvas": the source covers the whole OBS canvas. "box": sized for `room` people, moved in OBS.
    ("placement", Kind::Enum(&["canvas", "box"]), Def::S("canvas")),
    ("room", Kind::Int(1, 25), Def::I(4)),
];

const STYLE: &[Field] = &[
    ("shape", Kind::Enum(&["square", "rounded", "circle"]), Def::S("square")),
    ("frame", Kind::Bool, Def::B(true)),
    ("showNames", Kind::Bool, Def::B(true)),
    ("showRoles", Kind::Bool, Def::B(true)),
    ("nameSize", Kind::Int(10, 96), Def::I(22)),
    ("talkAnimation", Kind::Enum(&["bounce", "shake", "pulse", "none"]), Def::S("bounce")),
    ("talkGlow", Kind::Bool, Def::B(true)),
    ("talkColor", Kind::Color, Def::S("#6fc2b0")),
    ("idleDim", Kind::Num(0.0, 1.0), Def::F(0.65)),
    ("muteDim", Kind::Num(0.0, 1.0), Def::F(0.45)),
    ("hideWhenSilent", Kind::Bool, Def::B(false)),
    ("showMuteIcon", Kind::Bool, Def::B(true)),
    ("offlineText", Kind::Str(0, 24), Def::S("OFFLINE")),
    // Theme colours: "" = the theme's own colour.
    ("frameColor", Kind::OptColor, Def::S("")),
    ("boxColor", Kind::OptColor, Def::S("")),
    ("nameColor", Kind::OptColor, Def::S("")),
    ("nameBg", Kind::OptColor, Def::S("")),
    ("nameBorder", Kind::OptColor, Def::S("")),
    ("accentColor", Kind::OptColor, Def::S("")),
    ("nameStripe", Kind::Bool, Def::B(true)),
];

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ConfigError {
    pub path: String,
    pub message: String,
}

pub struct Validated {
    pub errors: Vec<ConfigError>,
    pub value: Option<Value>,
}

impl Validated {
    pub fn ok(&self) -> bool {
        self.errors.is_empty()
    }
}

// ---- small matchers (no regex engine) ----

pub fn is_user_id(s: &str) -> bool {
    (17..=20).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit())
}

fn is_preset_id(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 32
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

fn is_color(s: &str) -> bool {
    let b = s.as_bytes();
    (b.len() == 7 || b.len() == 9) && b[0] == b'#' && b[1..].iter().all(|c| c.is_ascii_hexdigit())
}

/// /^[a-z0-9][a-z0-9._-]{0,79}\.(png|gif|webp|jpe?g)$/i
pub fn is_image_name(s: &str) -> bool {
    let lower = s.to_ascii_lowercase();
    ["png", "gif", "webp", "jpg", "jpeg"].iter().any(|ext| {
        let Some(stem) = lower.strip_suffix(ext).and_then(|r| r.strip_suffix('.')) else { return false };
        let b = stem.as_bytes();
        !b.is_empty()
            && b.len() <= 80
            && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
            && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'-'))
    })
}

/// JavaScript string length (UTF-16 code units), which is what the limits were written against.
fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn js_num(f: f64) -> String {
    if f.fract() == 0.0 { format!("{}", f as i64) } else { format!("{f}") }
}

/// `value ?? fallback`: a missing key or JSON null.
fn present(v: Option<&Value>) -> Option<&Value> {
    v.filter(|v| !v.is_null())
}

fn fill(schema: &[Field], input: Option<&Map<String, Value>>) -> Map<String, Value> {
    schema
        .iter()
        .map(|(key, _, def)| {
            let v = present(input.and_then(|i| i.get(*key))).cloned().unwrap_or_else(|| def.value());
            (key.to_string(), v)
        })
        .collect()
}

/// Checks one field; returns the normalized value (whole numbers stored as integers).
fn check_field(errors: &mut Vec<ConfigError>, path: &str, value: &Value, kind: Kind) -> Value {
    let mut fail = |message: String| errors.push(ConfigError { path: path.to_string(), message });
    match kind {
        Kind::Enum(options) => {
            if !value.as_str().is_some_and(|s| options.contains(&s)) {
                fail(format!("must be one of {}", options.join(", ")));
            }
        }
        Kind::Int(a, b) => match value.as_f64() {
            Some(f) if value.is_number() && f.fract() == 0.0 && f >= a as f64 && f <= b as f64 => return json!(f as i64),
            _ => fail(format!("must be an integer between {a} and {b}")),
        },
        Kind::Num(a, b) => match value.as_f64() {
            Some(f) if value.is_number() && f.is_finite() && f >= a && f <= b => {
                return if f.fract() == 0.0 { json!(f as i64) } else { json!(f) };
            }
            _ => fail(format!("must be a number between {} and {}", js_num(a), js_num(b))),
        },
        Kind::Bool => {
            if !value.is_boolean() {
                fail("must be true or false".into());
            }
        }
        Kind::Color => {
            if !value.as_str().is_some_and(is_color) {
                fail("must be a hex color like #6fc2b0".into());
            }
        }
        Kind::OptColor => {
            if !value.as_str().is_some_and(|s| s.is_empty() || is_color(s)) {
                fail("must be a hex color like #6fc2b0".into());
            }
        }
        Kind::Str(a, b) => {
            if !value.as_str().is_some_and(|s| (a..=b).contains(&js_len(s))) {
                fail(format!("must be text of {a}-{b} characters"));
            }
        }
    }
    value.clone()
}

fn check_group(errors: &mut Vec<ConfigError>, path: &str, input: Option<&Value>, schema: &[Field]) -> Value {
    let obj = match input {
        None => None,
        Some(Value::Object(o)) => Some(o),
        Some(_) => {
            errors.push(ConfigError { path: path.into(), message: "must be an object".into() });
            return Value::Object(fill(schema, None));
        }
    };
    let mut value = fill(schema, obj);
    for (key, kind, _) in schema {
        let v = check_field(errors, &format!("{path}.{key}"), &value[*key], *kind);
        value.insert(key.to_string(), v);
    }
    Value::Object(value)
}

fn check_text(errors: &mut Vec<ConfigError>, path: &str, value: Option<&Value>, max: usize, required: bool) -> Value {
    match value {
        None => {}
        Some(Value::String(s)) if s.is_empty() => {}
        Some(v) => {
            if !v.as_str().is_some_and(|s| js_len(s) <= max) {
                errors.push(ConfigError { path: path.into(), message: format!("must be text of at most {max} characters") });
            }
            return v.clone();
        }
    }
    if required {
        errors.push(ConfigError { path: path.into(), message: "is required".into() });
    }
    json!("")
}

fn check_user(errors: &mut Vec<ConfigError>, p: &str, u: &Value) -> Option<Value> {
    let Some(u) = u.as_object() else {
        errors.push(ConfigError { path: p.into(), message: "must be an object".into() });
        return None;
    };
    let id = u.get("id").cloned().unwrap_or(Value::Null);
    if !id.as_str().is_some_and(is_user_id) {
        errors.push(ConfigError { path: format!("{p}.id"), message: "must be a Discord user id (17-20 digits)".into() });
    }
    let raw_images = u.get("images");
    let images_obj = raw_images.and_then(Value::as_object);
    if raw_images.is_some() && images_obj.is_none() {
        errors.push(ConfigError { path: format!("{p}.images"), message: "must be an object".into() });
    }
    let mut images = Map::new();
    for state in IMAGE_STATES {
        let name = present(images_obj.and_then(|i| i.get(state))).cloned().unwrap_or(json!(""));
        if name != json!("") && !name.as_str().is_some_and(is_image_name) {
            errors.push(ConfigError { path: format!("{p}.images.{state}"), message: "must be an uploaded image file name".into() });
        }
        images.insert(state.into(), name);
    }
    let role_color = present(u.get("roleColor")).cloned().unwrap_or(json!(""));
    if role_color != json!("") && !role_color.as_str().is_some_and(is_color) {
        errors.push(ConfigError { path: format!("{p}.roleColor"), message: "must be a hex color like #6fc2b0".into() });
    }
    let display_name = check_text(errors, &format!("{p}.displayName"), u.get("displayName"), 40, false);
    let role = check_text(errors, &format!("{p}.role"), u.get("role"), 24, false);
    Some(json!({ "id": id, "displayName": display_name, "role": role, "roleColor": role_color, "images": images }))
}

fn check_preset(errors: &mut Vec<ConfigError>, p: &str, input: &Value, user_ids: &HashSet<String>) -> Option<Value> {
    let Some(input) = input.as_object() else {
        errors.push(ConfigError { path: p.into(), message: "must be an object".into() });
        return None;
    };
    let id = input.get("id").cloned().unwrap_or(Value::Null);
    if !id.as_str().is_some_and(is_preset_id) {
        errors.push(ConfigError { path: format!("{p}.id"), message: "must be lowercase letters, digits or dashes (max 32)".into() });
    }
    let or = |key: &str, def: Value| present(input.get(key)).cloned().unwrap_or(def);
    let name = check_text(errors, &format!("{p}.name"), input.get("name"), 40, true);
    let mode = or("mode", json!("reactive"));
    let theme = or("theme", json!("clean"));
    let canvas = or("canvas", json!(CANVASES[0]));
    let show_unlisted = or("showUnlisted", json!(true));
    let layout = check_group(errors, &format!("{p}.layout"), input.get("layout"), LAYOUT);
    let style = check_group(errors, &format!("{p}.style"), input.get("style"), STYLE);
    check_field(errors, &format!("{p}.mode"), &mode, Kind::Enum(&["reactive", "slots"]));
    check_field(errors, &format!("{p}.theme"), &theme, Kind::Enum(THEMES));
    check_field(errors, &format!("{p}.canvas"), &canvas, Kind::Enum(CANVASES));
    check_field(errors, &format!("{p}.showUnlisted"), &show_unlisted, Kind::Bool);
    let mut users: Vec<Value> = Vec::new();
    match present(input.get("users")) {
        None => {}
        Some(Value::Array(list)) if list.len() <= LIMIT_PRESET_USERS => {
            for (i, uid) in list.iter().enumerate() {
                if !uid.as_str().is_some_and(|s| user_ids.contains(s)) {
                    errors.push(ConfigError { path: format!("{p}.users[{i}]"), message: "unknown user id".into() });
                } else if users.contains(uid) {
                    errors.push(ConfigError { path: format!("{p}.users[{i}]"), message: "listed twice".into() });
                } else {
                    users.push(uid.clone());
                }
            }
        }
        Some(_) => errors.push(ConfigError {
            path: format!("{p}.users"),
            message: format!("must be a list of at most {LIMIT_PRESET_USERS} user ids"),
        }),
    }
    Some(json!({
        "id": id, "name": name, "mode": mode, "theme": theme, "canvas": canvas, "users": users,
        "showUnlisted": show_unlisted, "layout": layout, "style": style,
    }))
}

pub fn default_preset(id: &str, name: &str) -> Value {
    json!({
        "id": id, "name": name, "mode": "reactive", "theme": "clean", "canvas": CANVASES[0], "users": [],
        "showUnlisted": true, "layout": Value::Object(fill(LAYOUT, None)), "style": Value::Object(fill(STYLE, None)),
    })
}

pub fn default_config() -> Value {
    json!({ "version": 1, "discord": { "clientId": "" }, "users": [], "presets": [default_preset("main", "Principal")] })
}

/// Validate and normalize a config. Never panics.
pub fn validate_config(input: &Value) -> Validated {
    let fail = |message: &str| Validated { errors: vec![ConfigError { path: String::new(), message: message.into() }], value: None };
    let Some(obj) = input.as_object() else { return fail("config must be an object") };
    let (Some(in_users), Some(in_presets)) = (obj.get("users").and_then(Value::as_array), obj.get("presets").and_then(Value::as_array))
    else {
        return fail("config needs users and presets lists");
    };
    let mut errors = Vec::new();
    if in_users.len() > LIMIT_USERS {
        errors.push(ConfigError { path: "users".into(), message: format!("at most {LIMIT_USERS} users") });
    }
    if in_presets.is_empty() || in_presets.len() > LIMIT_PRESETS {
        errors.push(ConfigError { path: "presets".into(), message: format!("between 1 and {LIMIT_PRESETS} presets") });
    }
    let client_id = present(obj.get("discord").and_then(Value::as_object).and_then(|d| d.get("clientId"))).cloned().unwrap_or(json!(""));
    if client_id != json!("") && !client_id.as_str().is_some_and(is_user_id) {
        errors.push(ConfigError { path: "discord.clientId".into(), message: "must be a Discord application id (17-20 digits)".into() });
    }

    let mut seen_users = HashSet::new();
    let mut users = Vec::new();
    for (i, u) in in_users.iter().enumerate() {
        let user = check_user(&mut errors, &format!("users[{i}]"), u);
        if let Some(id) = user.as_ref().and_then(|u| u["id"].as_str()).filter(|id| is_user_id(id)) {
            if !seen_users.insert(id.to_string()) {
                errors.push(ConfigError { path: format!("users[{i}].id"), message: "duplicate user id".into() });
            }
        }
        users.push(user.unwrap_or(Value::Null));
    }

    let mut seen_presets = HashSet::new();
    let mut presets = Vec::new();
    for (i, pr) in in_presets.iter().enumerate() {
        let preset = check_preset(&mut errors, &format!("presets[{i}]"), pr, &seen_users);
        if let Some(id) = preset.as_ref().and_then(|p| p["id"].as_str()) {
            if !seen_presets.insert(id.to_string()) {
                errors.push(ConfigError { path: format!("presets[{i}].id"), message: "duplicate preset id".into() });
            }
        }
        presets.push(preset.unwrap_or(Value::Null));
    }

    let value = errors.is_empty().then(|| json!({ "version": 1, "discord": { "clientId": client_id }, "users": users, "presets": presets }));
    Validated { errors, value }
}

/// Writes `value` as pretty JSON through a temporary file, so a crash never leaves half a file.
pub fn write_json_atomic(file: &Path, value: &Value) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = file.with_extension("json.tmp");
    let mut text = serde_json::to_string_pretty(value).map_err(std::io::Error::other)?;
    text.push('\n');
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, file)
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[derive(Debug)]
pub enum SaveError {
    Invalid(Vec<ConfigError>),
    Io(std::io::Error),
}

impl std::fmt::Display for SaveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SaveError::Invalid(errors) => {
                let list: Vec<String> = errors.iter().map(|e| format!("{} {}", e.path, e.message)).collect();
                write!(f, "invalid config: {}", list.join("; "))
            }
            SaveError::Io(e) => write!(f, "{e}"),
        }
    }
}

/// Loads and saves config.json. Invalid input never reaches disk.
pub struct ConfigStore {
    dir: PathBuf,
    file: PathBuf,
    current: Value,
}

impl ConfigStore {
    pub fn load(dir: &Path) -> std::io::Result<Self> {
        std::fs::create_dir_all(dir)?;
        let mut store = ConfigStore { dir: dir.to_path_buf(), file: dir.join("config.json"), current: Value::Null };
        let raw = match std::fs::read_to_string(&store.file) {
            Ok(raw) => raw,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                store.save(default_config()).map_err(|e| std::io::Error::other(e.to_string()))?;
                return Ok(store);
            }
            Err(e) => return Err(e),
        };
        let parsed: Value = serde_json::from_str(raw.trim_start_matches('\u{feff}')).unwrap_or(Value::Null);
        let result = validate_config(&parsed);
        match result.value {
            Some(v) => store.current = v,
            None => {
                // Keep the user's file for manual recovery instead of overwriting it silently.
                std::fs::rename(&store.file, store.dir.join(format!("config.broken-{}.json", now_ms())))?;
                store.save(default_config()).map_err(|e| std::io::Error::other(e.to_string()))?;
            }
        }
        Ok(store)
    }

    pub fn current(&self) -> &Value {
        &self.current
    }

    pub fn save(&mut self, input: Value) -> Result<Value, SaveError> {
        let result = validate_config(&input);
        let Some(value) = result.value else { return Err(SaveError::Invalid(result.errors)) };
        write_json_atomic(&self.file, &value).map_err(SaveError::Io)?;
        self.current = value.clone();
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const USER: &str = "123456789012345678";

    fn paths(v: &Validated) -> Vec<&str> {
        v.errors.iter().map(|e| e.path.as_str()).collect()
    }

    #[test]
    fn default_config_is_valid_and_fills_preset_defaults() {
        let r = validate_config(&default_config());
        assert!(r.ok(), "{:?}", r.errors);
        let v = r.value.unwrap();
        assert_eq!(v["presets"][0]["layout"]["size"], 160);
        assert_eq!(v["presets"][0]["layout"]["placement"], "canvas");
        assert_eq!(v["presets"][0]["style"]["idleDim"], 0.65);
        assert_eq!(v["presets"][0]["canvas"], "1920x1080");
        assert_eq!(v["presets"][0]["style"]["nameStripe"], true);
    }

    #[test]
    fn partial_preset_gets_defaults_and_image_slots_are_optional() {
        let r = validate_config(&json!({
            "users": [{ "id": USER }],
            "presets": [{ "id": "p", "name": "P", "layout": { "size": 200 }, "users": [USER] }],
        }));
        assert!(r.ok(), "{:?}", r.errors);
        let v = r.value.unwrap();
        assert_eq!(v["presets"][0]["layout"]["size"], 200);
        assert_eq!(v["presets"][0]["layout"]["gap"], 24);
        assert_eq!(v["users"][0]["images"], json!({ "idle": "", "talking": "", "muted": "", "deafened": "" }));
        assert_eq!(v["discord"]["clientId"], "");
    }

    #[test]
    fn rejects_invalid_values_with_a_path_per_error() {
        let r = validate_config(&json!({
            "discord": { "clientId": "abc" },
            "users": [{ "id": "12", "displayName": "x".repeat(41), "images": { "idle": "../evil.png" }, "roleColor": "red" }],
            "presets": [{
                "id": "Bad Id", "name": "", "mode": "weird", "theme": "nope", "canvas": "800x600", "showUnlisted": "yes",
                "layout": { "size": 5000, "columns": 2.5 }, "style": { "idleDim": 3, "talkColor": "green", "offlineText": "x".repeat(30), "frameColor": "#12" },
            }],
        }));
        assert!(!r.ok());
        assert!(r.value.is_none());
        let expected = [
            "discord.clientId", "users[0].id", "users[0].images.idle", "users[0].roleColor", "users[0].displayName",
            "presets[0].id", "presets[0].name", "presets[0].layout.columns", "presets[0].layout.size",
            "presets[0].style.talkColor", "presets[0].style.idleDim", "presets[0].style.offlineText", "presets[0].style.frameColor",
            "presets[0].mode", "presets[0].theme", "presets[0].canvas", "presets[0].showUnlisted",
        ];
        assert_eq!(paths(&r), expected);
        let msg = |p: &str| r.errors.iter().find(|e| e.path == p).unwrap().message.clone();
        assert_eq!(msg("presets[0].layout.size"), "must be an integer between 32 and 1024");
        assert_eq!(msg("presets[0].style.idleDim"), "must be a number between 0 and 1");
        assert_eq!(msg("presets[0].mode"), "must be one of reactive, slots");
        assert_eq!(msg("presets[0].name"), "is required");
        assert_eq!(msg("presets[0].style.offlineText"), "must be text of 0-24 characters");
        assert_eq!(msg("users[0].displayName"), "must be text of at most 40 characters");
    }

    #[test]
    fn rejects_duplicates_and_unknown_preset_users() {
        let r = validate_config(&json!({
            "users": [{ "id": USER }, { "id": USER }],
            "presets": [
                { "id": "a", "name": "A", "users": ["999999999999999999", USER, USER] },
                { "id": "a", "name": "B" },
            ],
        }));
        assert_eq!(paths(&r), ["users[1].id", "presets[0].users[0]", "presets[0].users[2]", "presets[1].id"]);
        assert_eq!(r.errors[1].message, "unknown user id");
        assert_eq!(r.errors[2].message, "listed twice");
    }

    #[test]
    fn rejects_unknown_top_level_shape() {
        assert_eq!(validate_config(&json!(null)).errors[0].message, "config must be an object");
        assert_eq!(validate_config(&json!({ "users": [] })).errors[0].message, "config needs users and presets lists");
        assert_eq!(paths(&validate_config(&json!({ "users": [], "presets": [] }))), ["presets"]);
        assert_eq!(paths(&validate_config(&json!({ "users": [], "presets": [{ "id": "a", "name": "A", "layout": null }] }))), ["presets[0].layout"]);
    }

    #[test]
    fn theme_canvas_and_box_placement_are_checked() {
        for theme in THEMES {
            let r = validate_config(&json!({ "users": [], "presets": [{ "id": "a", "name": "A", "theme": theme }] }));
            assert!(r.ok(), "{theme}");
        }
        for canvas in CANVASES {
            assert!(validate_config(&json!({ "users": [], "presets": [{ "id": "a", "name": "A", "canvas": canvas }] })).ok());
        }
        let r = validate_config(&json!({ "users": [], "presets": [{ "id": "a", "name": "A", "layout": { "placement": "box", "room": 26 } }] }));
        assert_eq!(paths(&r), ["presets[0].layout.room"]);
        let r = validate_config(&json!({ "users": [], "presets": [{ "id": "a", "name": "A", "style": { "boxColor": "#00000000", "nameStripe": false } }] }));
        assert!(r.ok());
    }

    #[test]
    fn image_names_match_the_uploaded_pattern() {
        for ok in ["a.png", "me-talking.GIF", "x.y_z.jpeg", "0.webp", "a.JPG"] {
            assert!(is_image_name(ok), "{ok}");
        }
        for bad in ["", ".png", "-a.png", "a.bmp", "../a.png", "a b.png", "Ñ.png", &format!("{}.png", "a".repeat(81))] {
            assert!(!is_image_name(bad), "{bad}");
        }
    }

    #[test]
    fn store_creates_defaults_saves_atomically_and_keeps_broken_files() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = ConfigStore::load(dir.path()).unwrap();
        assert!(dir.path().join("config.json").exists());
        assert_eq!(store.current()["presets"][0]["id"], "main");

        let mut next = store.current().clone();
        next["presets"][0]["name"] = json!("Renamed");
        store.save(next).unwrap();
        let on_disk: Value = serde_json::from_str(&std::fs::read_to_string(dir.path().join("config.json")).unwrap()).unwrap();
        assert_eq!(on_disk["presets"][0]["name"], "Renamed");

        let before = std::fs::read_to_string(dir.path().join("config.json")).unwrap();
        assert!(matches!(store.save(json!({ "users": [], "presets": [] })), Err(SaveError::Invalid(_))));
        assert_eq!(std::fs::read_to_string(dir.path().join("config.json")).unwrap(), before);

        std::fs::write(dir.path().join("config.json"), "{ not json").unwrap();
        let store = ConfigStore::load(dir.path()).unwrap();
        assert_eq!(store.current()["presets"][0]["name"], "Principal");
        let broken = std::fs::read_dir(dir.path()).unwrap().filter_map(|e| e.ok()).any(|e| e.file_name().to_string_lossy().starts_with("config.broken-"));
        assert!(broken);
    }
}
