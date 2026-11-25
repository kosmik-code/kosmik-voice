//! Discord client local IPC (the transport StreamKit uses).
//! Frame: [op i32 LE][length i32 LE][UTF-8 JSON]. Ops: 0 HANDSHAKE, 1 FRAME, 2 CLOSE, 3 PING, 4 PONG.

use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt, WriteHalf};
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};
use tokio::sync::{mpsc, oneshot};

pub const OP_HANDSHAKE: i32 = 0;
pub const OP_FRAME: i32 = 1;
pub const OP_CLOSE: i32 = 2;
pub const OP_PING: i32 = 3;
pub const OP_PONG: i32 = 4;
const MAX_FRAME: usize = 16 * 1024 * 1024;

/// Everything that can go wrong talking to Discord, in the categories the service cares about.
#[derive(Debug, Clone, PartialEq)]
pub enum DiscordError {
    /// No discord-ipc pipe answered: Discord isn't running.
    NotRunning(String),
    /// Discord answered a request with an ERROR event.
    Rpc { code: Option<i64>, message: String },
    /// The pipe closed (by Discord, or ours).
    Closed(String),
    /// The OAuth token endpoint refused.
    Token(String),
    /// Something the streamer has to set up in the editor first.
    Setup(String),
    /// Timeouts, network errors and anything else.
    Other(String),
}

impl DiscordError {
    pub fn message(&self) -> &str {
        match self {
            DiscordError::NotRunning(m)
            | DiscordError::Closed(m)
            | DiscordError::Token(m)
            | DiscordError::Setup(m)
            | DiscordError::Other(m) => m,
            DiscordError::Rpc { message, .. } => message,
        }
    }

    pub fn with_message(self, message: String) -> Self {
        match self {
            DiscordError::Rpc { code, .. } => DiscordError::Rpc { code, message },
            DiscordError::NotRunning(_) => DiscordError::NotRunning(message),
            DiscordError::Closed(_) => DiscordError::Closed(message),
            DiscordError::Token(_) => DiscordError::Token(message),
            DiscordError::Setup(_) => DiscordError::Setup(message),
            DiscordError::Other(_) => DiscordError::Other(message),
        }
    }
}

impl std::fmt::Display for DiscordError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

pub fn encode_frame(op: i32, data: &Value) -> Vec<u8> {
    let body = serde_json::to_vec(data).unwrap_or_default();
    let mut out = Vec::with_capacity(8 + body.len());
    out.extend_from_slice(&op.to_le_bytes());
    out.extend_from_slice(&(body.len() as i32).to_le_bytes());
    out.extend_from_slice(&body);
    out
}

#[derive(Default)]
pub struct FrameDecoder {
    buf: Vec<u8>,
}

impl FrameDecoder {
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<(i32, Value)>, String> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        let mut start = 0;
        while self.buf.len() - start >= 8 {
            let head = &self.buf[start..];
            let op = i32::from_le_bytes(head[0..4].try_into().unwrap());
            let len = i32::from_le_bytes(head[4..8].try_into().unwrap());
            if len < 0 || len as usize > MAX_FRAME {
                return Err(format!("frame too large ({len} bytes)"));
            }
            let len = len as usize;
            if head.len() < 8 + len {
                break;
            }
            let data = serde_json::from_slice(&head[8..8 + len]).map_err(|e| format!("invalid frame: {e}"))?;
            out.push((op, data));
            start += 8 + len;
        }
        self.buf.drain(..start);
        Ok(out)
    }
}

pub fn default_pipe_paths() -> Vec<String> {
    (0..10).map(|i| format!(r"\\.\pipe\discord-ipc-{i}")).collect()
}

/// Events from the reader: DISPATCH frames, and the close (always the last one).
#[derive(Debug)]
pub enum IpcEvent {
    Dispatch(String, Value),
    Close(String),
}

type Reply = oneshot::Sender<Result<Value, DiscordError>>;

struct State {
    closed: Option<String>,
    pending: HashMap<String, Reply>,
    ready: Option<oneshot::Sender<Result<Value, String>>>,
}

struct Inner {
    state: Mutex<State>,
    writer: tokio::sync::Mutex<Option<WriteHalf<NamedPipeClient>>>,
    events: mpsc::UnboundedSender<IpcEvent>,
    reader: Mutex<Option<tokio::task::AbortHandle>>,
}

impl Inner {
    fn shutdown(&self, reason: &str) {
        let (pending, ready) = {
            let mut st = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if st.closed.is_some() {
                return;
            }
            st.closed = Some(reason.to_string());
            (std::mem::take(&mut st.pending), st.ready.take())
        };
        if let Some(ready) = ready {
            let _ = ready.send(Err(reason.to_string()));
        }
        for (_, reply) in pending {
            let _ = reply.send(Err(DiscordError::Closed(reason.to_string())));
        }
        if let Ok(mut w) = self.writer.try_lock() {
            w.take();
        }
        if let Some(reader) = self.reader.lock().unwrap_or_else(|e| e.into_inner()).take() {
            reader.abort();
        }
        let _ = self.events.send(IpcEvent::Close(reason.to_string()));
    }

    async fn write(&self, frame: Vec<u8>) -> Result<(), String> {
        let mut w = self.writer.lock().await;
        let Some(pipe) = w.as_mut() else { return Err("connection closed".into()) };
        pipe.write_all(&frame).await.map_err(|e| e.to_string())
    }

    fn on_frame(&self, op: i32, data: Value, pongs: &mpsc::UnboundedSender<Value>) -> Option<String> {
        match op {
            OP_PING => {
                let _ = pongs.send(data);
            }
            OP_CLOSE => {
                let code = js_text(&data["code"]).unwrap_or_else(|| "no code".into());
                let message = js_text(&data["message"]).filter(|m| !m.is_empty()).unwrap_or_else(|| "no message".into());
                return Some(format!("Discord closed the connection ({code}): {message}"));
            }
            OP_FRAME => {
                let cmd = data["cmd"].as_str().unwrap_or("");
                let evt = data["evt"].as_str();
                if cmd == "DISPATCH" && evt == Some("READY") {
                    if let Some(ready) = self.state.lock().unwrap_or_else(|e| e.into_inner()).ready.take() {
                        let _ = ready.send(Ok(data["data"].clone()));
                    }
                    return None;
                }
                if let Some(nonce) = data["nonce"].as_str() {
                    let reply = self.state.lock().unwrap_or_else(|e| e.into_inner()).pending.remove(nonce);
                    if let Some(reply) = reply {
                        let result = if evt == Some("ERROR") {
                            let message = data["data"]["message"].as_str().filter(|m| !m.is_empty()).unwrap_or("RPC error");
                            Err(DiscordError::Rpc { code: data["data"]["code"].as_i64(), message: message.to_string() })
                        } else {
                            Ok(data["data"].clone())
                        };
                        let _ = reply.send(result);
                        return None;
                    }
                }
                if cmd == "DISPATCH" {
                    if let Some(evt) = evt {
                        let _ = self.events.send(IpcEvent::Dispatch(evt.to_string(), data["data"].clone()));
                    }
                }
            }
            _ => {}
        }
        None
    }
}

/// A value as JavaScript's template literal would print it (strings without quotes).
fn js_text(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
}

/// An open, handshaken connection. Dropping it closes the pipe.
pub struct IpcClient {
    inner: Arc<Inner>,
    timeout: Duration,
}

pub struct Connected {
    pub client: IpcClient,
    pub events: mpsc::UnboundedReceiver<IpcEvent>,
    /// The READY payload (contains the Discord user).
    pub ready: Value,
}

fn open_pipe(path: &str) -> Option<NamedPipeClient> {
    ClientOptions::new().open(path).ok()
}

impl IpcClient {
    pub async fn connect(client_id: &str, pipe_paths: &[String], timeout: Duration) -> Result<Connected, DiscordError> {
        let Some(pipe) = pipe_paths.iter().find_map(|p| open_pipe(p)) else {
            return Err(DiscordError::NotRunning("Discord is not running (no IPC pipe answered)".into()));
        };
        let (mut read, write) = tokio::io::split(pipe);
        let (events_tx, events) = mpsc::unbounded_channel();
        let (ready_tx, ready_rx) = oneshot::channel();
        let inner = Arc::new(Inner {
            state: Mutex::new(State { closed: None, pending: HashMap::new(), ready: Some(ready_tx) }),
            writer: tokio::sync::Mutex::new(Some(write)),
            events: events_tx,
            reader: Mutex::new(None),
        });

        // PONGs go through their own task so the reader never waits on the writer.
        let (pong_tx, mut pong_rx) = mpsc::unbounded_channel::<Value>();
        let pong_inner = Arc::downgrade(&inner);
        tokio::spawn(async move {
            while let Some(data) = pong_rx.recv().await {
                let Some(inner) = pong_inner.upgrade() else { break };
                let _ = inner.write(encode_frame(OP_PONG, &data)).await;
            }
        });

        let reader_inner = inner.clone();
        let reader = tokio::spawn(async move {
            let inner = reader_inner;
            let mut decoder = FrameDecoder::default();
            let mut buf = vec![0u8; 64 * 1024];
            let reason = loop {
                match read.read(&mut buf).await {
                    Ok(0) | Err(_) => break "connection closed".to_string(),
                    Ok(n) => match decoder.push(&buf[..n]) {
                        Err(e) => break e,
                        Ok(frames) => {
                            if let Some(reason) = frames.into_iter().find_map(|(op, data)| inner.on_frame(op, data, &pong_tx)) {
                                break reason;
                            }
                        }
                    },
                }
            };
            // Detach first so shutdown doesn't abort this very task mid-way.
            inner.reader.lock().unwrap_or_else(|e| e.into_inner()).take();
            inner.shutdown(&reason);
        });
        *inner.reader.lock().unwrap_or_else(|e| e.into_inner()) = Some(reader.abort_handle());
        if inner.state.lock().unwrap_or_else(|e| e.into_inner()).closed.is_some() {
            reader.abort();
        }

        let client = IpcClient { inner, timeout };
        if let Err(e) = client.inner.write(encode_frame(OP_HANDSHAKE, &json!({ "v": 1, "client_id": client_id }))).await {
            client.inner.shutdown(&e);
        }
        match tokio::time::timeout(timeout, ready_rx).await {
            Ok(Ok(Ok(ready))) => Ok(Connected { client, events, ready }),
            Ok(Ok(Err(reason))) => Err(DiscordError::Closed(reason)),
            Ok(Err(_)) => Err(DiscordError::Closed("connection closed".into())),
            Err(_) => {
                client.inner.shutdown("handshake timed out");
                Err(DiscordError::Other("handshake timed out".into()))
            }
        }
    }

    pub async fn request(&self, cmd: &str, args: Value, evt: Option<&str>) -> Result<Value, DiscordError> {
        let nonce = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        {
            let mut st = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
            if st.closed.is_some() {
                return Err(DiscordError::Closed("connection closed".into()));
            }
            st.pending.insert(nonce.clone(), tx);
        }
        let mut payload = json!({ "cmd": cmd, "args": args, "nonce": nonce });
        if let Some(evt) = evt {
            payload["evt"] = json!(evt);
        }
        if let Err(e) = self.inner.write(encode_frame(OP_FRAME, &payload)).await {
            self.inner.shutdown(&e);
        }
        let limit = if cmd == "AUTHORIZE" { Duration::from_secs(5 * 60) } else { self.timeout };
        match tokio::time::timeout(limit, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(DiscordError::Closed("connection closed".into())),
            Err(_) => {
                self.inner.state.lock().unwrap_or_else(|e| e.into_inner()).pending.remove(&nonce);
                Err(DiscordError::Other(format!("{cmd} timed out")))
            }
        }
    }

    pub async fn subscribe(&self, evt: &str, args: Value) -> Result<Value, DiscordError> {
        self.request("SUBSCRIBE", args, Some(evt)).await
    }

    pub async fn unsubscribe(&self, evt: &str, args: Value) -> Result<Value, DiscordError> {
        self.request("UNSUBSCRIBE", args, Some(evt)).await
    }

    pub fn close(&self) {
        self.inner.shutdown("connection closed");
    }
}

impl Drop for IpcClient {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
pub mod fake {
    //! A fake Discord client IPC server speaking the real framing, for tests.
    use super::*;
    use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};

    pub type Handler = Arc<dyn Fn(&Value, &Peer) + Send + Sync>;

    #[derive(Clone)]
    pub struct Peer {
        out: mpsc::UnboundedSender<Option<Vec<u8>>>,
    }

    impl Peer {
        pub fn send(&self, op: i32, data: Value) {
            let _ = self.out.send(Some(encode_frame(op, &data)));
        }
        pub fn dispatch(&self, evt: &str, data: Value) {
            self.send(OP_FRAME, json!({ "cmd": "DISPATCH", "evt": evt, "data": data }));
        }
        pub fn reply(&self, msg: &Value, data: Value) {
            self.send(OP_FRAME, json!({ "cmd": msg["cmd"], "nonce": msg["nonce"], "evt": null, "data": data }));
        }
        pub fn fail(&self, msg: &Value, code: i64, message: &str) {
            self.send(OP_FRAME, json!({ "cmd": msg["cmd"], "nonce": msg["nonce"], "evt": "ERROR", "data": { "code": code, "message": message } }));
        }
        pub fn close(&self) {
            let _ = self.out.send(None);
        }
    }

    #[derive(Default, Clone)]
    pub struct Handlers {
        pub map: HashMap<String, Handler>,
        pub handshake: Option<Handler>,
    }

    impl Handlers {
        pub fn on(mut self, cmd: &str, f: impl Fn(&Value, &Peer) + Send + Sync + 'static) -> Self {
            self.map.insert(cmd.to_string(), Arc::new(f));
            self
        }
    }

    pub struct FakeDiscord {
        pub pipe: String,
        pub received: Arc<Mutex<Vec<(i32, Value)>>>,
        pub peer: Arc<Mutex<Option<Peer>>>,
        task: tokio::task::JoinHandle<()>,
    }

    impl FakeDiscord {
        pub fn commands(&self) -> Vec<Value> {
            self.received.lock().unwrap().iter().filter(|(op, _)| *op == OP_FRAME).map(|(_, m)| m.clone()).collect()
        }
        pub fn count(&self, cmd: &str) -> usize {
            self.commands().iter().filter(|c| c["cmd"] == cmd).count()
        }
        pub fn handshakes(&self) -> usize {
            self.received.lock().unwrap().iter().filter(|(op, _)| *op == OP_HANDSHAKE).count()
        }
        pub fn peer(&self) -> Peer {
            self.peer.lock().unwrap().clone().expect("no connection yet")
        }
    }

    impl Drop for FakeDiscord {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    pub fn pipe_name() -> String {
        format!(r"\\.\pipe\kv-test-{}", uuid::Uuid::new_v4())
    }

    pub fn start(handlers: Handlers) -> FakeDiscord {
        start_on(pipe_name(), handlers)
    }

    /// Serves on a given pipe name (Discord "opening" where a client already looks).
    pub fn start_on(pipe: String, handlers: Handlers) -> FakeDiscord {
        let received = Arc::new(Mutex::new(Vec::new()));
        let peer_slot = Arc::new(Mutex::new(None));
        let first = ServerOptions::new().first_pipe_instance(true).create(&pipe).unwrap();
        let (name, rec, slot) = (pipe.clone(), received.clone(), peer_slot.clone());
        let task = tokio::spawn(async move {
            let mut server = first;
            loop {
                if server.connect().await.is_err() {
                    return;
                }
                let conn = server;
                server = ServerOptions::new().create(&name).unwrap();
                tokio::spawn(serve(conn, handlers.clone(), rec.clone(), slot.clone()));
            }
        });
        FakeDiscord { pipe, received, peer: peer_slot, task }
    }

    async fn serve(conn: NamedPipeServer, handlers: Handlers, received: Arc<Mutex<Vec<(i32, Value)>>>, slot: Arc<Mutex<Option<Peer>>>) {
        let (mut read, mut write) = tokio::io::split(conn);
        let (out, mut out_rx) = mpsc::unbounded_channel::<Option<Vec<u8>>>();
        let peer = Peer { out };
        *slot.lock().unwrap() = Some(peer.clone());
        let writer = tokio::spawn(async move {
            while let Some(Some(frame)) = out_rx.recv().await {
                if write.write_all(&frame).await.is_err() {
                    break;
                }
            }
            // dropping the write half and returning ends the connection together with the reader
        });
        let mut decoder = FrameDecoder::default();
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            tokio::select! {
                _ = async { while !writer.is_finished() { tokio::time::sleep(Duration::from_millis(5)).await; } } => break,
                r = read.read(&mut buf) => {
                    let n = match r { Ok(0) | Err(_) => break, Ok(n) => n };
                    for (op, msg) in decoder.push(&buf[..n]).unwrap() {
                        received.lock().unwrap().push((op, msg.clone()));
                        match op {
                            OP_HANDSHAKE => match &handlers.handshake {
                                Some(h) => h(&msg, &peer),
                                None => peer.dispatch("READY", json!({ "v": 1, "user": { "id": "100000000000000001", "username": "streamer" } })),
                            },
                            OP_FRAME => match handlers.map.get(msg["cmd"].as_str().unwrap_or("")) {
                                Some(h) => h(&msg, &peer),
                                None => peer.reply(&msg, json!({})),
                            },
                            _ => {}
                        }
                    }
                }
            }
        }
        writer.abort();
    }

    pub async fn wait_for(mut f: impl FnMut() -> bool) {
        let start = std::time::Instant::now();
        while !f() {
            assert!(start.elapsed() < Duration::from_secs(5), "wait_for timed out");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fake::{self, Handlers};
    use super::*;

    const CLIENT: &str = "123456789012345678";

    #[test]
    fn frames_round_trip_across_split_chunks() {
        let a = encode_frame(OP_FRAME, &json!({ "cmd": "X", "n": 1 }));
        let b = encode_frame(OP_PING, &json!({ "p": "ñ" }));
        let all = [a, b].concat();
        let mut d = FrameDecoder::default();
        let mut got = Vec::new();
        for chunk in all.chunks(3) {
            got.extend(d.push(chunk).unwrap());
        }
        assert_eq!(got, vec![(OP_FRAME, json!({ "cmd": "X", "n": 1 })), (OP_PING, json!({ "p": "ñ" }))]);
    }

    #[test]
    fn decoder_rejects_oversized_frames() {
        let mut head = OP_FRAME.to_le_bytes().to_vec();
        head.extend_from_slice(&(20 * 1024 * 1024i32).to_le_bytes());
        assert!(FrameDecoder::default().push(&head).unwrap_err().contains("too large"));
    }

    #[tokio::test]
    async fn connects_with_the_client_id_and_resolves_ready() {
        let f = fake::start(Handlers::default());
        let c = IpcClient::connect(CLIENT, &[f.pipe.clone()], Duration::from_secs(2)).await.unwrap();
        assert_eq!(c.ready["user"]["username"], "streamer");
        let hs = f.received.lock().unwrap()[0].clone();
        assert_eq!(hs, (OP_HANDSHAKE, json!({ "v": 1, "client_id": CLIENT })));
    }

    #[tokio::test]
    async fn request_resolves_by_nonce_and_error_rejects_with_code() {
        let f = fake::start(
            Handlers::default()
                .on("GET_SELECTED_VOICE_CHANNEL", |m, p| p.reply(m, json!({ "id": "c1" })))
                .on("AUTHENTICATE", |m, p| p.fail(m, 4009, "Invalid OAuth2 access token")),
        );
        let c = IpcClient::connect(CLIENT, &[f.pipe.clone()], Duration::from_secs(2)).await.unwrap();
        let ch = c.client.request("GET_SELECTED_VOICE_CHANNEL", json!({}), None).await.unwrap();
        assert_eq!(ch["id"], "c1");
        let err = c.client.request("AUTHENTICATE", json!({ "access_token": "x" }), None).await.unwrap_err();
        assert_eq!(err, DiscordError::Rpc { code: Some(4009), message: "Invalid OAuth2 access token".into() });
        c.client.subscribe("SPEAKING_START", json!({ "channel_id": "c1" })).await.unwrap();
        let sub = f.commands().into_iter().find(|m| m["cmd"] == "SUBSCRIBE").unwrap();
        assert_eq!(sub["evt"], "SPEAKING_START");
        assert_eq!(sub["args"]["channel_id"], "c1");
    }

    #[tokio::test]
    async fn emits_dispatches_answers_ping_and_rejects_pending_on_close() {
        let f = fake::start(Handlers::default().on("SLOW", |_, _| {}));
        let mut c = IpcClient::connect(CLIENT, &[f.pipe.clone()], Duration::from_secs(2)).await.unwrap();
        let peer = f.peer();
        peer.dispatch("SPEAKING_START", json!({ "user_id": "1" }));
        match c.events.recv().await.unwrap() {
            IpcEvent::Dispatch(evt, data) => assert_eq!((evt.as_str(), data["user_id"].as_str()), ("SPEAKING_START", Some("1"))),
            other => panic!("{other:?}"),
        }
        peer.send(OP_PING, json!({ "t": 1 }));
        fake::wait_for(|| f.received.lock().unwrap().iter().any(|(op, d)| *op == OP_PONG && d["t"] == 1)).await;

        let slow = c.client.request("SLOW", json!({}), None);
        let closer = async {
            tokio::time::sleep(Duration::from_millis(50)).await;
            peer.send(OP_CLOSE, json!({ "code": 4006, "message": "Not authenticated or invalid scope" }));
        };
        let (res, _) = tokio::join!(slow, closer);
        let reason = "Discord closed the connection (4006): Not authenticated or invalid scope";
        assert_eq!(res.unwrap_err(), DiscordError::Closed(reason.into()));
        match c.events.recv().await.unwrap() {
            IpcEvent::Close(r) => assert_eq!(r, reason),
            other => panic!("{other:?}"),
        }
        assert_eq!(c.client.request("X", json!({}), None).await.unwrap_err(), DiscordError::Closed("connection closed".into()));
    }

    #[tokio::test]
    async fn connect_fails_when_no_pipe_answers() {
        let err = IpcClient::connect(CLIENT, &[fake::pipe_name()], Duration::from_secs(1)).await.err().unwrap();
        assert!(matches!(err, DiscordError::NotRunning(_)));
    }
}
