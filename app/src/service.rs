//! Keeps a live connection to the local Discord client and publishes voice snapshots.
//! States: setup_required | discord_closed | connecting | authorizing | auth_failed | ready | error.
//! auth_failed does not retry on its own: retrying would open a new Discord consent popup every time.

use crate::auth::{TokenFetch, authenticate};
use crate::config::now_ms;
use crate::ipc::{DiscordError, IpcClient, IpcEvent};
use crate::secrets::{SecretStore, truthy};
use crate::voice::VoiceRoom;
use futures_util::future::join_all;
use serde::Serialize;
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::sync::{Notify, broadcast, mpsc, watch};

const CHANNEL_EVENTS: [&str; 5] = ["VOICE_STATE_CREATE", "VOICE_STATE_UPDATE", "VOICE_STATE_DELETE", "SPEAKING_START", "SPEAKING_STOP"];

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Status {
    pub state: String,
    pub message: String,
}

impl Status {
    fn new(state: &str, message: &str) -> Self {
        Status { state: state.into(), message: message.into() }
    }
}

#[derive(Debug, Clone)]
pub enum ServiceEvent {
    Status(Status),
    Voice(Value),
}

enum Cmd {
    Restart(Option<String>),
    Stop,
}

/// Cuts the wait between connection tries short (Discord was just seen starting).
#[derive(Default)]
struct Wake {
    notify: Notify,
    /// True only while waiting out the retry delay: a nudge never interrupts a try in progress.
    between_tries: AtomicBool,
}

/// The server's view of the Discord service: current values, change events and restart.
#[derive(Clone)]
pub struct DiscordHandle {
    status: watch::Receiver<Status>,
    voice: watch::Receiver<Value>,
    events: broadcast::Sender<ServiceEvent>,
    cmd: mpsc::UnboundedSender<Cmd>,
    wake: Arc<Wake>,
}

impl DiscordHandle {
    pub fn status(&self) -> Status {
        self.status.borrow().clone()
    }
    pub fn snapshot(&self) -> Value {
        self.voice.borrow().clone()
    }
    pub fn subscribe(&self) -> broadcast::Receiver<ServiceEvent> {
        self.events.subscribe()
    }
    pub fn status_watch(&self) -> watch::Receiver<Status> {
        self.status.clone()
    }
    /// Reconnect, with a new application id when given (after the editor saved credentials).
    pub fn restart(&self, client_id: Option<String>) {
        let _ = self.cmd.send(Cmd::Restart(client_id));
    }
    pub fn stop(&self) {
        let _ = self.cmd.send(Cmd::Stop);
    }
    /// Discord is running but we aren't connected: try now instead of after the retry delay.
    /// Only while it was "closed", so an error or a refused authorization is never retried faster.
    pub fn nudge(&self) {
        if self.status.borrow().state == "discord_closed" && self.wake.between_tries.load(Ordering::SeqCst) {
            self.wake.notify.notify_one();
        }
    }
}

pub struct ServiceOptions {
    pub client_id: String,
    pub secrets: Arc<SecretStore>,
    pub pipe_paths: Vec<String>,
    pub retry: Duration,
    pub timeout: Duration,
    pub fetch: TokenFetch,
}

struct Publisher {
    status: watch::Sender<Status>,
    voice: watch::Sender<Value>,
    events: broadcast::Sender<ServiceEvent>,
}

impl Publisher {
    fn status(&self, state: &str, message: &str) {
        let s = Status::new(state, message);
        self.status.send_replace(s.clone());
        let _ = self.events.send(ServiceEvent::Status(s));
    }
    fn current(&self) -> String {
        self.status.borrow().state.clone()
    }
    fn voice(&self, room: &VoiceRoom) {
        let snap = room.snapshot();
        self.voice.send_replace(snap.clone());
        let _ = self.events.send(ServiceEvent::Voice(snap));
    }
}

/// What ended a session.
enum End {
    Retry,
    /// Stop until the editor asks again (auth failed, setup required).
    Halt,
}

struct Service {
    opts: ServiceOptions,
    out: Publisher,
    room: VoiceRoom,
    subscribed: Option<String>,
    wake: Arc<Wake>,
}

/// A handle that is never connected: for tests of the server and for headless checks.
pub fn detached(status: Status, voice: Value) -> (DiscordHandle, DetachedControls) {
    let (status_tx, status_rx) = watch::channel(status);
    let (voice_tx, voice_rx) = watch::channel(voice);
    let (events, _) = broadcast::channel(256);
    let (cmd, cmd_rx) = mpsc::unbounded_channel();
    let handle = DiscordHandle { status: status_rx, voice: voice_rx, events: events.clone(), cmd, wake: Arc::new(Wake::default()) };
    (handle, DetachedControls { out: Publisher { status: status_tx, voice: voice_tx, events }, cmd: cmd_rx })
}

pub struct DetachedControls {
    out: Publisher,
    cmd: mpsc::UnboundedReceiver<Cmd>,
}

impl DetachedControls {
    pub fn set_status(&self, state: &str, message: &str) {
        self.out.status(state, message);
    }
    pub fn set_voice(&self, snap: Value) {
        self.out.voice.send_replace(snap.clone());
        let _ = self.out.events.send(ServiceEvent::Voice(snap));
    }
    /// Restart requests received so far (the client id each one carried).
    pub fn restarts(&mut self) -> Vec<Option<String>> {
        let mut out = Vec::new();
        while let Ok(c) = self.cmd.try_recv() {
            if let Cmd::Restart(id) = c {
                out.push(id);
            }
        }
        out
    }
}

pub fn spawn(opts: ServiceOptions) -> DiscordHandle {
    let (status_tx, status_rx) = watch::channel(Status::new("connecting", ""));
    let (voice_tx, voice_rx) = watch::channel(VoiceRoom::default().snapshot());
    let (events, _) = broadcast::channel(256);
    let (cmd, cmd_rx) = mpsc::unbounded_channel();
    let wake = Arc::new(Wake::default());
    let handle = DiscordHandle { status: status_rx, voice: voice_rx, events: events.clone(), cmd, wake: wake.clone() };
    let svc = Service { opts, out: Publisher { status: status_tx, voice: voice_tx, events }, room: VoiceRoom::default(), subscribed: None, wake };
    tokio::spawn(svc.run(cmd_rx));
    handle
}

impl Service {
    async fn run(mut self, mut cmds: mpsc::UnboundedReceiver<Cmd>) {
        let mut running = true;
        loop {
            if !running {
                match cmds.recv().await {
                    Some(Cmd::Restart(id)) => {
                        if let Some(id) = id {
                            self.opts.client_id = id;
                        }
                        running = true;
                    }
                    Some(Cmd::Stop) => {}
                    None => return,
                }
                continue;
            }
            if self.opts.client_id.is_empty() {
                self.out.status("setup_required", "Set your Discord application id in the editor.");
                running = false;
                continue;
            }
            let end = tokio::select! {
                end = self.session() => Some(end),
                cmd = cmds.recv() => {
                    self.reset_room();
                    match cmd {
                        Some(Cmd::Restart(id)) => {
                            if let Some(id) = id { self.opts.client_id = id; }
                            None
                        }
                        Some(Cmd::Stop) => { running = false; None }
                        None => return,
                    }
                }
            };
            match end {
                None => {}
                Some(End::Halt) => running = false,
                Some(End::Retry) => {
                    self.wake.between_tries.store(true, Ordering::SeqCst);
                    let wake = self.wake.clone();
                    tokio::select! {
                        _ = tokio::time::sleep(self.opts.retry) => {}
                        _ = wake.notify.notified() => {}
                        cmd = cmds.recv() => match cmd {
                            Some(Cmd::Restart(id)) => if let Some(id) = id { self.opts.client_id = id; },
                            Some(Cmd::Stop) => running = false,
                            None => {
                                self.wake.between_tries.store(false, Ordering::SeqCst);
                                return;
                            }
                        },
                    }
                    self.wake.between_tries.store(false, Ordering::SeqCst);
                }
            }
        }
    }

    fn reset_room(&mut self) {
        self.subscribed = None;
        if self.room.has_channel() {
            self.room.set_channel(&Value::Null);
            self.out.voice(&self.room);
        }
    }

    fn lost(&mut self, reason: &str) -> End {
        self.reset_room();
        self.out.status("discord_closed", &format!("Lost connection to Discord: {reason}"));
        End::Retry
    }

    async fn session(&mut self) -> End {
        // While Discord is closed, retries keep saying so instead of flickering through "connecting".
        if self.out.current() != "discord_closed" {
            self.out.status("connecting", "");
        }
        let mut conn = match IpcClient::connect(&self.opts.client_id, &self.opts.pipe_paths, self.opts.timeout).await {
            Ok(c) => c,
            Err(e) => {
                let state = if matches!(e, DiscordError::NotRunning(_)) { "discord_closed" } else { "error" };
                self.out.status(state, e.message());
                return End::Retry;
            }
        };
        let ipc = &conn.client;
        self.out.status("authorizing", "Approve the request in Discord if it asks.");
        let setup = async {
            authenticate(ipc, &self.opts.client_id, &self.opts.secrets, &self.opts.fetch, now_ms).await?;
            ipc.subscribe("VOICE_CHANNEL_SELECT", json!({})).await?;
            let channel = ipc.request("GET_SELECTED_VOICE_CHANNEL", json!({}), None).await?;
            Ok::<Value, DiscordError>(channel)
        }
        .await;
        let result = match setup {
            Ok(channel) => self.follow(ipc, &channel).await,
            Err(e) => Err(e),
        };
        if let Err(e) = result {
            if let DiscordError::Closed(reason) = &e {
                return self.lost(reason);
            }
            let auth_failed = self.out.current() == "authorizing" && matches!(e, DiscordError::Rpc { .. } | DiscordError::Token(_));
            if auth_failed || matches!(e, DiscordError::Setup(_)) {
                self.out.status(if auth_failed { "auth_failed" } else { "setup_required" }, e.message());
                self.subscribed = None;
                return End::Halt;
            }
            self.out.status("error", e.message());
            self.reset_room();
            return End::Retry;
        }
        self.out.status("ready", "");

        loop {
            match conn.events.recv().await {
                Some(IpcEvent::Dispatch(evt, data)) => {
                    if evt == "VOICE_CHANNEL_SELECT" {
                        // Events are handled one at a time, so fast channel hops never interleave subscriptions.
                        let res = async {
                            let channel = if truthy(&data["channel_id"]) {
                                conn.client.request("GET_SELECTED_VOICE_CHANNEL", json!({}), None).await?
                            } else {
                                Value::Null
                            };
                            self.follow(&conn.client, &channel).await
                        }
                        .await;
                        match res {
                            Err(DiscordError::Closed(reason)) => return self.lost(&reason),
                            Err(e) => self.out.status("error", e.message()),
                            Ok(()) => {}
                        }
                    } else if self.room.apply(&evt, &data) {
                        self.out.voice(&self.room);
                    }
                }
                Some(IpcEvent::Close(reason)) => return self.lost(&reason),
                None => return self.lost("connection closed"),
            }
        }
    }

    async fn follow(&mut self, ipc: &IpcClient, channel: &Value) -> Result<(), DiscordError> {
        let next = channel["id"].as_str().map(str::to_string);
        if self.subscribed.is_some() && self.subscribed != next {
            let old = self.subscribed.take().unwrap_or_default();
            join_all(CHANNEL_EVENTS.iter().map(|e| ipc.unsubscribe(e, json!({ "channel_id": old })))).await;
        }
        self.room.set_channel(channel);
        if let Some(id) = &next {
            if self.subscribed.as_ref() != Some(id) {
                for r in join_all(CHANNEL_EVENTS.iter().map(|e| ipc.subscribe(e, json!({ "channel_id": id })))).await {
                    r?;
                }
                self.subscribed = Some(id.clone());
            }
        }
        self.out.voice(&self.room);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::fake::{self, Handlers, wait_for};
    use std::sync::Mutex;

    const CLIENT: &str = "123456789012345678";
    const A: &str = "111111111111111111";
    const B: &str = "222222222222222222";

    fn member(id: &str) -> Value {
        json!({ "nick": null, "mute": false, "voice_state": { "mute": false, "deaf": false, "self_mute": false, "self_deaf": false }, "user": { "id": id, "username": "u", "avatar": null } })
    }

    fn no_fetch() -> TokenFetch {
        Arc::new(|_| Box::pin(async { Err("no network in tests".to_string()) }))
    }

    fn opts(dir: &tempfile::TempDir, pipes: Vec<String>, retry_ms: u64) -> ServiceOptions {
        ServiceOptions {
            client_id: CLIENT.into(),
            secrets: Arc::new(SecretStore::new(dir.path())),
            pipe_paths: pipes,
            retry: Duration::from_millis(retry_ms),
            timeout: Duration::from_secs(2),
            fetch: no_fetch(),
        }
    }

    /// Collects every status and snapshot the service publishes.
    fn record(h: &DiscordHandle) -> (Arc<Mutex<Vec<Status>>>, Arc<Mutex<Vec<Value>>>) {
        let (statuses, snaps) = (Arc::new(Mutex::new(Vec::new())), Arc::new(Mutex::new(Vec::new())));
        let mut rx = h.subscribe();
        let (s, v) = (statuses.clone(), snaps.clone());
        tokio::spawn(async move {
            while let Ok(ev) = rx.recv().await {
                match ev {
                    ServiceEvent::Status(st) => s.lock().unwrap().push(st),
                    ServiceEvent::Voice(snap) => v.lock().unwrap().push(snap),
                }
            }
        });
        (statuses, snaps)
    }

    #[tokio::test]
    async fn follows_the_selected_channel_tracks_speaking_and_resubscribes_on_switch() {
        let selected = Arc::new(Mutex::new(json!({ "id": "c1", "name": "General", "guild_id": "g", "voice_states": [member(A)] })));
        let sel = selected.clone();
        let f = fake::start(
            Handlers::default()
                .on("AUTHENTICATE", |m, p| p.reply(m, json!({ "user": { "id": A } })))
                .on("GET_SELECTED_VOICE_CHANNEL", move |m, p| p.reply(m, sel.lock().unwrap().clone())),
        );
        let dir = tempfile::tempdir().unwrap();
        let secrets = json!({ "clientSecret": "s", "token": { "accessToken": "t", "refreshToken": "r", "expiresAt": now_ms() + 1_000_000_000 } });
        std::fs::write(dir.path().join("secrets.json"), secrets.to_string()).unwrap();
        let h = spawn(opts(&dir, vec![f.pipe.clone()], 50));
        let (_st, snaps) = record(&h);
        let last = || snaps.lock().unwrap().last().cloned().unwrap_or(Value::Null);

        wait_for(|| h.status().state == "ready" && last()["channel"]["id"] == "c1").await;
        let mut subs: Vec<String> = f
            .commands()
            .iter()
            .filter(|c| c["cmd"] == "SUBSCRIBE")
            .map(|c| format!("{}:{}", c["evt"].as_str().unwrap(), c["args"]["channel_id"].as_str().unwrap_or("-")))
            .collect();
        subs.sort();
        assert_eq!(
            subs,
            ["SPEAKING_START:c1", "SPEAKING_STOP:c1", "VOICE_CHANNEL_SELECT:-", "VOICE_STATE_CREATE:c1", "VOICE_STATE_DELETE:c1", "VOICE_STATE_UPDATE:c1"]
        );

        let peer = f.peer();
        peer.dispatch("SPEAKING_START", json!({ "user_id": A, "channel_id": "c1" }));
        wait_for(|| last()["members"][0]["speaking"] == true).await;

        *selected.lock().unwrap() = json!({ "id": "c2", "name": "Squad", "voice_states": [member(B)] });
        peer.dispatch("VOICE_CHANNEL_SELECT", json!({ "channel_id": "c2" }));
        wait_for(|| last()["channel"]["id"] == "c2").await;
        assert_eq!(last()["members"].as_array().unwrap().iter().map(|m| m["id"].clone()).collect::<Vec<_>>(), vec![json!(B)]);
        let unsubs: Vec<Value> = f.commands().iter().filter(|c| c["cmd"] == "UNSUBSCRIBE").map(|c| c["args"]["channel_id"].clone()).collect();
        assert_eq!(unsubs.len(), 5);
        assert!(unsubs.iter().all(|id| id == "c1"));

        *selected.lock().unwrap() = Value::Null;
        peer.dispatch("VOICE_CHANNEL_SELECT", json!({ "channel_id": null }));
        wait_for(|| last()["channel"].is_null()).await;
        h.stop();
    }

    #[tokio::test]
    async fn setup_required_without_a_client_id_and_retries_while_discord_is_closed() {
        let dir = tempfile::tempdir().unwrap();
        let mut o = opts(&dir, vec![], 50);
        o.client_id = String::new();
        let none = spawn(o);
        wait_for(|| none.status().state == "setup_required").await;

        let h = spawn(opts(&dir, vec![fake::pipe_name()], 30));
        let (statuses, _) = record(&h);
        wait_for(|| statuses.lock().unwrap().iter().filter(|s| s.state == "discord_closed").count() >= 2).await;
        h.stop();
    }

    #[tokio::test]
    async fn a_nudge_connects_as_soon_as_discord_appears_and_retries_stay_quiet() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("secrets.json"), json!({ "clientSecret": "s" }).to_string()).unwrap();
        let pipe = fake::pipe_name();
        let h = spawn(opts(&dir, vec![pipe.clone()], 60_000)); // next try only a minute away
        let (statuses, _) = record(&h);
        wait_for(|| h.status().state == "discord_closed").await;
        statuses.lock().unwrap().clear(); // the first try says "connecting"; later ones shouldn't
        h.nudge(); // Discord still closed: one quick try, still "discord_closed", no "connecting"
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(statuses.lock().unwrap().iter().all(|s| s.state == "discord_closed"), "{:?}", statuses.lock().unwrap());
        let f = fake::start_on(pipe, Handlers::default()); // Discord opens
        h.nudge();
        wait_for(|| f.handshakes() == 1).await;
        h.stop();
    }

    #[tokio::test]
    async fn an_authorization_failure_stops_instead_of_prompting_again() {
        let f = fake::start(Handlers::default().on("AUTHORIZE", |m, p| p.fail(m, 5000, "OAuth2 Error: invalid_request: Missing \"redirect_uri\" in request.")));
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("secrets.json"), json!({ "clientSecret": "s" }).to_string()).unwrap();
        let h = spawn(opts(&dir, vec![f.pipe.clone()], 20));
        wait_for(|| h.status().state == "auth_failed").await;
        let msg = h.status().message;
        assert!(msg.contains("Missing \"redirect_uri\" in request. Add http://127.0.0.1 under OAuth2 > Redirects"), "{msg}");
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert_eq!(f.handshakes(), 1, "no automatic reconnect after an auth failure");
        assert_eq!(f.count("AUTHORIZE"), 1);
        h.restart(None);
        wait_for(|| f.count("AUTHORIZE") == 2).await;
        h.stop();
    }

    #[tokio::test]
    async fn when_discord_closes_the_pipe_its_code_and_message_reach_the_status() {
        let slot: Arc<Mutex<Option<fake::Peer>>> = Arc::new(Mutex::new(None));
        let s = slot.clone();
        let f = fake::start(Handlers::default().on("AUTHORIZE", move |_, p| {
            *s.lock().unwrap() = Some(p.clone());
            p.send(crate::ipc::OP_CLOSE, json!({ "code": 4006, "message": "Not authenticated or invalid scope" }));
        }));
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("secrets.json"), json!({ "clientSecret": "s" }).to_string()).unwrap();
        let h = spawn(opts(&dir, vec![f.pipe.clone()], 5000));
        let (statuses, _) = record(&h);
        wait_for(|| statuses.lock().unwrap().iter().any(|s| s.state == "discord_closed" || s.state == "error")).await;
        let all = statuses.lock().unwrap().clone();
        assert!(all.iter().any(|s| s.message.contains("4006") && s.message.contains("Not authenticated or invalid scope")), "{all:?}");
        h.stop();
    }

    #[tokio::test]
    async fn restart_with_a_new_client_id_reconnects_with_it() {
        let f = fake::start(Handlers::default().on("AUTHENTICATE", |m, p| p.reply(m, json!({}))).on("GET_SELECTED_VOICE_CHANNEL", |m, p| p.reply(m, Value::Null)));
        let dir = tempfile::tempdir().unwrap();
        let secrets = json!({ "clientSecret": "s", "token": { "accessToken": "t", "expiresAt": now_ms() + 1_000_000_000 } });
        std::fs::write(dir.path().join("secrets.json"), secrets.to_string()).unwrap();
        let h = spawn(opts(&dir, vec![f.pipe.clone()], 50));
        wait_for(|| h.status().state == "ready").await;
        h.restart(Some("999999999999999999".into()));
        wait_for(|| f.handshakes() == 2 && h.status().state == "ready").await;
        let ids: Vec<Value> = f.received.lock().unwrap().iter().filter(|(op, _)| *op == 0).map(|(_, m)| m["client_id"].clone()).collect();
        assert_eq!(ids, vec![json!(CLIENT), json!("999999999999999999")]);
        h.stop();
    }
}
