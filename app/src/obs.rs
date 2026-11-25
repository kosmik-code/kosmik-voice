//! "Add to OBS": puts the overlay in OBS as a Browser source over OBS's own WebSocket server
//! (obs-websocket v5, built into OBS 28+). The port and password are read from OBS's settings on
//! this PC, so nothing has to be typed. One short connection per press; nothing stays connected.

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tokio_tungstenite::tungstenite::{self, Message, client::IntoClientRequest};

/// Port and password from OBS's own WebSocket settings on this PC.
#[derive(Debug, Clone, PartialEq)]
pub struct ObsSettings {
    pub enabled: bool,
    pub url: String,
    /// Stays in this process: never written by us or sent to the page.
    pub password: String,
}

/// Finds OBS's settings (swapped out in tests).
pub type FindObs = Arc<dyn Fn() -> Option<ObsSettings> + Send + Sync>;

/// %APPDATA%\obs-studio\plugin_config\obs-websocket\config.json
pub fn read_obs_settings(app_data: Option<&Path>) -> Option<ObsSettings> {
    let file = app_data?.join("obs-studio").join("plugin_config").join("obs-websocket").join("config.json");
    let c: Value = serde_json::from_str(&std::fs::read_to_string(file).ok()?).ok()?;
    let port = c["server_port"].as_u64().filter(|p| (1..=65535).contains(p)).unwrap_or(4455);
    let auth = c["auth_required"] != json!(false);
    Some(ObsSettings {
        enabled: c["server_enabled"] != json!(false),
        url: format!("ws://127.0.0.1:{port}"),
        password: if auth { c["server_password"].as_str().unwrap_or("").to_string() } else { String::new() },
    })
}

fn sha256_b64(s: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(Sha256::digest(s.as_bytes()))
}

/// obs-websocket auth string: base64(sha256(base64(sha256(password + salt)) + challenge)).
pub fn auth_string(password: &str, salt: &str, challenge: &str) -> String {
    sha256_b64(&(sha256_b64(&format!("{password}{salt}")) + challenge))
}

/// Why "Add to OBS" didn't work. `code` is what the editor shows a message for.
#[derive(Debug, Clone, PartialEq)]
pub struct ObsError {
    pub code: &'static str,
    pub message: String,
    /// obs-websocket request status (600 = not found).
    pub status: Option<i64>,
}

impl ObsError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        ObsError { code, message: message.into(), status: None }
    }
}

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

struct Session {
    ws: Ws,
    next_id: u64,
}

const TIMEOUT: Duration = Duration::from_secs(5);

impl Session {
    async fn recv(&mut self) -> Result<Value, ObsError> {
        loop {
            let msg = tokio::time::timeout(TIMEOUT, self.ws.next()).await.map_err(|_| ObsError::new("obs_failed", "OBS didn't answer"))?;
            match msg {
                Some(Ok(Message::Text(t))) => {
                    if let Ok(v) = serde_json::from_str::<Value>(t.as_str()) {
                        return Ok(v);
                    }
                }
                Some(Ok(Message::Close(frame))) => {
                    return Err(match frame.map(|f| u16::from(f.code)) {
                        Some(4009) => ObsError::new("obs_auth", "OBS rejected the WebSocket password"),
                        _ => ObsError::new("obs_closed", "OBS closed the connection"),
                    });
                }
                Some(Ok(_)) => {}
                None | Some(Err(_)) => return Err(ObsError::new("obs_closed", "OBS closed the connection")),
            }
        }
    }

    async fn send(&mut self, v: Value) -> Result<(), ObsError> {
        self.ws.send(Message::Text(v.to_string().into())).await.map_err(|_| ObsError::new("obs_closed", "OBS closed the connection"))
    }

    async fn open(settings: &ObsSettings) -> Result<Session, ObsError> {
        let mut req = settings.url.as_str().into_client_request().map_err(|e| ObsError::new("obs_failed", e.to_string()))?;
        req.headers_mut().insert("Sec-WebSocket-Protocol", tungstenite::http::HeaderValue::from_static("obswebsocket.json"));
        let ws = match tokio::time::timeout(TIMEOUT, tokio_tungstenite::connect_async(req)).await {
            Ok(Ok((ws, _))) => ws,
            _ => return Err(ObsError::new("obs_closed", "OBS is not running or its WebSocket server is off")),
        };
        let mut s = Session { ws, next_id: 0 };
        let hello = s.recv().await?;
        let mut identify = json!({ "rpcVersion": 1, "eventSubscriptions": 0 });
        let auth = &hello["d"]["authentication"];
        if auth.is_object() {
            identify["authentication"] = json!(auth_string(&settings.password, auth["salt"].as_str().unwrap_or(""), auth["challenge"].as_str().unwrap_or("")));
        }
        s.send(json!({ "op": 1, "d": identify })).await?;
        let identified = s.recv().await?;
        if identified["op"] != 2 {
            return Err(ObsError::new("obs_failed", "OBS didn't accept the connection"));
        }
        Ok(s)
    }

    async fn call(&mut self, request_type: &str, data: Value) -> Result<Value, ObsError> {
        self.next_id += 1;
        let id = self.next_id.to_string();
        self.send(json!({ "op": 6, "d": { "requestType": request_type, "requestId": id, "requestData": data } })).await?;
        loop {
            let m = self.recv().await?;
            if m["op"] != 7 || m["d"]["requestId"] != json!(id) {
                continue;
            }
            let d = &m["d"];
            if d["requestStatus"]["result"] == json!(true) {
                return Ok(if d["responseData"].is_null() { json!({}) } else { d["responseData"].clone() });
            }
            let st = &d["requestStatus"];
            let what = st["comment"].as_str().filter(|c| !c.is_empty()).map(String::from).unwrap_or_else(|| format!("code {}", st["code"]));
            return Err(ObsError { code: "obs_failed", message: format!("{request_type} failed: {what}"), status: st["code"].as_i64() });
        }
    }

    async fn close(mut self) {
        let _ = self.ws.close(None).await;
    }
}

/// True when `url` is this overlay (`/overlay/<id>` on this app, by 127.0.0.1 or localhost), query ignored.
pub fn is_our_overlay(url: &str, port: u16, preset_id: &str) -> bool {
    let Some(rest) = url.strip_prefix("http://") else { return false };
    let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
    let path = path.split(['?', '#']).next().unwrap_or("");
    let host = host.to_ascii_lowercase();
    (host == format!("127.0.0.1:{port}") || host == format!("localhost:{port}")) && path == format!("overlay/{preset_id}")
}

pub struct AddRequest<'a> {
    pub port: u16,
    pub preset_id: &'a str,
    pub preset_name: &'a str,
    pub width: u32,
    pub height: u32,
}

/// Puts this overlay in OBS's current scene. A Browser source that already shows it is reused: its
/// size is updated (its address is left alone, so a "?demo=1" stays), and it's added to the current
/// scene if it isn't there. Otherwise a new one is created. Nothing else in OBS is touched.
pub async fn add_to_obs(settings: Option<ObsSettings>, r: AddRequest<'_>) -> Result<Value, ObsError> {
    let Some(settings) = settings else {
        return Err(ObsError::new("obs_not_found", "OBS's settings weren't found on this PC"));
    };
    if !settings.enabled {
        return Err(ObsError::new("obs_off", "OBS's WebSocket server is off"));
    }
    let mut s = Session::open(&settings).await?;
    let result = add_in_session(&mut s, &r).await;
    s.close().await;
    result
}

async fn add_in_session(s: &mut Session, r: &AddRequest<'_>) -> Result<Value, ObsError> {
    let program = s.call("GetCurrentProgramScene", json!({})).await?;
    let scene = program["currentProgramSceneName"].as_str().or(program["sceneName"].as_str()).unwrap_or("").to_string();
    let size = json!({ "width": r.width, "height": r.height });

    let browsers = s.call("GetInputList", json!({ "inputKind": "browser_source" })).await?;
    for input in browsers["inputs"].as_array().into_iter().flatten() {
        let Some(name) = input["inputName"].as_str() else { continue };
        let settings = s.call("GetInputSettings", json!({ "inputName": name })).await?;
        if !is_our_overlay(settings["inputSettings"]["url"].as_str().unwrap_or(""), r.port, r.preset_id) {
            continue;
        }
        s.call("SetInputSettings", json!({ "inputName": name, "inputSettings": size, "overlay": true })).await?;
        let in_scene = match s.call("GetSceneItemId", json!({ "sceneName": scene, "sourceName": name })).await {
            Ok(_) => true,
            Err(e) if e.status == Some(600) => false,
            Err(e) => return Err(e),
        };
        if !in_scene {
            s.call("CreateSceneItem", json!({ "sceneName": scene, "sourceName": name, "sceneItemEnabled": true })).await?;
        }
        return Ok(json!({ "result": "updated", "name": name, "scene": scene, "addedToScene": !in_scene }));
    }

    // Source names are shared by inputs and scenes in OBS.
    let mut taken: Vec<String> = Vec::new();
    let all = s.call("GetInputList", json!({})).await?;
    taken.extend(all["inputs"].as_array().into_iter().flatten().filter_map(|i| i["inputName"].as_str().map(String::from)));
    let scenes = s.call("GetSceneList", json!({})).await?;
    taken.extend(scenes["scenes"].as_array().into_iter().flatten().filter_map(|i| i["sceneName"].as_str().map(String::from)));
    let name = source_name(r.preset_name, &taken);
    let url = format!("http://127.0.0.1:{}/overlay/{}", r.port, r.preset_id);
    s.call(
        "CreateInput",
        json!({
            "sceneName": scene,
            "inputName": name,
            "inputKind": "browser_source",
            "inputSettings": { "url": url, "width": r.width, "height": r.height },
            "sceneItemEnabled": true,
        }),
    )
    .await?;
    Ok(json!({ "result": "created", "name": name, "scene": scene, "addedToScene": true }))
}

/// "Kosmik Voice", or "Kosmik Voice · <preset>" / "(2)"... when that name is taken.
pub fn source_name(preset_name: &str, taken: &[String]) -> String {
    let free = |n: &str| !taken.iter().any(|t| t == n);
    let base = "Kosmik Voice".to_string();
    if free(&base) {
        return base;
    }
    let named = if preset_name.trim().is_empty() { base } else { format!("Kosmik Voice · {}", preset_name.trim()) };
    if free(&named) {
        return named;
    }
    (2..).map(|i| format!("{named} ({i})")).find(|n| free(n)).unwrap_or(named)
}

#[cfg(test)]
pub mod fake {
    //! An in-process OBS that speaks obs-websocket v5, with password auth and the few requests "Add to OBS" uses.
    use super::*;
    use std::sync::Mutex;
    use tokio::net::TcpListener;

    #[derive(Default)]
    pub struct World {
        pub program: String,
        pub scenes: Vec<String>,
        /// (name, kind, settings)
        pub inputs: Vec<(String, String, Value)>,
        /// (scene, source)
        pub items: Vec<(String, String)>,
        pub requests: Vec<String>,
    }

    pub struct FakeObs {
        pub url: String,
        pub world: Arc<Mutex<World>>,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for FakeObs {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    fn reply(world: &mut World, t: &str, d: &Value) -> Result<Value, (i64, String)> {
        world.requests.push(t.to_string());
        let input = |w: &World, n: &str| w.inputs.iter().position(|i| i.0 == n);
        match t {
            "GetCurrentProgramScene" => Ok(json!({ "currentProgramSceneName": world.program, "sceneName": world.program })),
            "GetSceneList" => Ok(json!({ "scenes": world.scenes.iter().map(|s| json!({ "sceneName": s })).collect::<Vec<_>>() })),
            "GetInputList" => {
                let kind = d["inputKind"].as_str();
                Ok(json!({ "inputs": world.inputs.iter().filter(|i| kind.is_none_or(|k| k == i.1)).map(|i| json!({ "inputName": i.0, "inputKind": i.1 })).collect::<Vec<_>>() }))
            }
            "GetInputSettings" => {
                let i = input(world, d["inputName"].as_str().unwrap_or("")).ok_or((600, "No source was found".to_string()))?;
                Ok(json!({ "inputSettings": world.inputs[i].2 }))
            }
            "SetInputSettings" => {
                let i = input(world, d["inputName"].as_str().unwrap_or("")).ok_or((600, "No source was found".to_string()))?;
                for (k, v) in d["inputSettings"].as_object().unwrap() {
                    world.inputs[i].2[k] = v.clone();
                }
                Ok(json!({}))
            }
            "GetSceneItemId" => {
                let key = (d["sceneName"].as_str().unwrap_or("").to_string(), d["sourceName"].as_str().unwrap_or("").to_string());
                world.items.iter().position(|i| *i == key).map(|p| json!({ "sceneItemId": p + 1 })).ok_or((600, "No scene items were found".to_string()))
            }
            "CreateSceneItem" => {
                world.items.push((d["sceneName"].as_str().unwrap().to_string(), d["sourceName"].as_str().unwrap().to_string()));
                Ok(json!({ "sceneItemId": world.items.len() }))
            }
            "CreateInput" => {
                let name = d["inputName"].as_str().unwrap().to_string();
                if input(world, &name).is_some() || world.scenes.contains(&name) {
                    return Err((601, "A source already exists by that input name".into()));
                }
                world.inputs.push((name.clone(), d["inputKind"].as_str().unwrap().to_string(), d["inputSettings"].clone()));
                world.items.push((d["sceneName"].as_str().unwrap().to_string(), name));
                Ok(json!({ "inputUuid": "x", "sceneItemId": world.items.len() }))
            }
            _ => Err((204, "unknown request".into())),
        }
    }

    pub async fn start(password: &str, world: World) -> FakeObs {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let world = Arc::new(Mutex::new(world));
        let (w, password) = (world.clone(), password.to_string());
        let task = tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                let (w, password) = (w.clone(), password.clone());
                tokio::spawn(async move {
                    // Like OBS, confirm the obswebsocket.json subprotocol (the client insists on it).
                    let confirm = |_: &tungstenite::handshake::server::Request, mut res: tungstenite::handshake::server::Response| {
                        res.headers_mut().insert("Sec-WebSocket-Protocol", tungstenite::http::HeaderValue::from_static("obswebsocket.json"));
                        Ok(res)
                    };
                    let Ok(mut ws) = tokio_tungstenite::accept_hdr_async(tcp, confirm).await else { return };
                    let (salt, challenge) = ("c2FsdA==", "Y2hhbGxlbmdl");
                    let mut hello = json!({ "op": 0, "d": { "obsWebSocketVersion": "5.5.0", "rpcVersion": 1 } });
                    if !password.is_empty() {
                        hello["d"]["authentication"] = json!({ "salt": salt, "challenge": challenge });
                    }
                    let _ = ws.send(Message::Text(hello.to_string().into())).await;
                    while let Some(Ok(Message::Text(t))) = ws.next().await {
                        let m: Value = serde_json::from_str(t.as_str()).unwrap();
                        if m["op"] == 1 {
                            if !password.is_empty() && m["d"]["authentication"] != json!(auth_string(&password, salt, challenge)) {
                                let _ = ws.close(Some(tungstenite::protocol::CloseFrame { code: 4009u16.into(), reason: "Authentication failed.".into() })).await;
                                return;
                            }
                            let _ = ws.send(Message::Text(json!({ "op": 2, "d": { "negotiatedRpcVersion": 1 } }).to_string().into())).await;
                        } else if m["op"] == 6 {
                            let d = &m["d"];
                            let t = d["requestType"].as_str().unwrap_or("");
                            let r = reply(&mut w.lock().unwrap(), t, &d["requestData"]);
                            let status = match &r {
                                Ok(_) => json!({ "result": true, "code": 100 }),
                                Err((code, comment)) => json!({ "result": false, "code": code, "comment": comment }),
                            };
                            let out = json!({ "op": 7, "d": { "requestType": t, "requestId": d["requestId"], "requestStatus": status, "responseData": r.ok() } });
                            let _ = ws.send(Message::Text(out.to_string().into())).await;
                        }
                    }
                });
            }
        });
        FakeObs { url, world, task }
    }
}

#[cfg(test)]
mod tests {
    use super::fake::{World, start};
    use super::*;

    fn settings(url: &str, password: &str) -> Option<ObsSettings> {
        Some(ObsSettings { enabled: true, url: url.into(), password: password.into() })
    }

    fn req<'a>(width: u32, height: u32) -> AddRequest<'a> {
        AddRequest { port: 7429, preset_id: "main", preset_name: "Main", width, height }
    }

    #[test]
    fn reads_obs_settings_and_recognises_our_overlay_urls() {
        let app_data = tempfile::tempdir().unwrap();
        let dir = app_data.path().join("obs-studio/plugin_config/obs-websocket");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("config.json"), r#"{"server_enabled":true,"server_port":4460,"auth_required":true,"server_password":"s3cret"}"#).unwrap();
        assert_eq!(read_obs_settings(Some(app_data.path())), Some(ObsSettings { enabled: true, url: "ws://127.0.0.1:4460".into(), password: "s3cret".into() }));
        assert_eq!(read_obs_settings(Some(&app_data.path().join("missing"))), None);

        assert!(is_our_overlay("http://127.0.0.1:7429/overlay/main", 7429, "main"));
        assert!(is_our_overlay("http://LOCALHOST:7429/overlay/main?demo=1", 7429, "main"));
        assert!(!is_our_overlay("http://127.0.0.1:7429/overlay/main-2", 7429, "main"));
        assert!(!is_our_overlay("http://127.0.0.1:7430/overlay/main", 7429, "main"));
        assert!(!is_our_overlay("https://example.com/overlay/main", 7429, "main"));

        let taken = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(source_name("Main", &taken(&[])), "Kosmik Voice");
        assert_eq!(source_name("Main", &taken(&["Kosmik Voice"])), "Kosmik Voice · Main");
        assert_eq!(source_name("Main", &taken(&["Kosmik Voice", "Kosmik Voice · Main"])), "Kosmik Voice · Main (2)");
    }

    #[tokio::test]
    async fn creates_the_source_once_then_updates_it_and_adds_it_to_another_scene() {
        let obs = start("pw", World { program: "Live".into(), scenes: vec!["Live".into(), "Kosmik Voice".into()], ..Default::default() }).await;
        let first = add_to_obs(settings(&obs.url, "pw"), req(1920, 1080)).await.unwrap();
        assert_eq!(first, json!({ "result": "created", "name": "Kosmik Voice · Main", "scene": "Live", "addedToScene": true }), "a scene already uses the plain name");
        {
            let w = obs.world.lock().unwrap();
            assert_eq!(w.inputs[0].1, "browser_source");
            assert_eq!(w.inputs[0].2, json!({ "url": "http://127.0.0.1:7429/overlay/main", "width": 1920, "height": 1080 }));
        }

        // Pressed again with another size: same source, new size, nothing duplicated.
        let again = add_to_obs(settings(&obs.url, "pw"), req(640, 360)).await.unwrap();
        assert_eq!(again["result"], "updated");
        assert_eq!(again["addedToScene"], false);

        // From another scene (and the user had added "?demo=1"): reused and added to that scene too.
        {
            let mut w = obs.world.lock().unwrap();
            w.program = "Gaming".into();
            w.scenes.push("Gaming".into());
            w.inputs[0].2["url"] = json!("http://localhost:7429/overlay/main?demo=1");
        }
        let other = add_to_obs(settings(&obs.url, "pw"), req(640, 360)).await.unwrap();
        assert_eq!(other, json!({ "result": "updated", "name": "Kosmik Voice · Main", "scene": "Gaming", "addedToScene": true }));
        let w = obs.world.lock().unwrap();
        assert_eq!(w.inputs.len(), 1);
        assert_eq!(w.inputs[0].2, json!({ "url": "http://localhost:7429/overlay/main?demo=1", "width": 640, "height": 360 }));
        assert_eq!(w.items, vec![("Live".to_string(), "Kosmik Voice · Main".to_string()), ("Gaming".to_string(), "Kosmik Voice · Main".to_string())]);
    }

    #[tokio::test]
    async fn explains_why_it_could_not_add() {
        let none = add_to_obs(None, req(10, 10)).await.unwrap_err();
        assert_eq!(none.code, "obs_not_found");
        let off = add_to_obs(Some(ObsSettings { enabled: false, url: "ws://127.0.0.1:1".into(), password: String::new() }), req(10, 10)).await.unwrap_err();
        assert_eq!(off.code, "obs_off");
        let closed = add_to_obs(settings("ws://127.0.0.1:1", ""), req(10, 10)).await.unwrap_err();
        assert_eq!(closed.code, "obs_closed");
        let obs = start("pw", World { program: "Live".into(), scenes: vec!["Live".into()], ..Default::default() }).await;
        let wrong = add_to_obs(settings(&obs.url, "nope"), req(10, 10)).await.unwrap_err();
        assert_eq!(wrong.code, "obs_auth");
        assert!(obs.world.lock().unwrap().requests.is_empty(), "nothing done with a wrong password");
    }
}
