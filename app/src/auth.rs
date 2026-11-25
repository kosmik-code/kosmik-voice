//! OAuth for Discord local RPC. The streamer's own Discord application is used; as its owner
//! they are an allowed RPC tester. Order: saved token -> refresh -> interactive AUTHORIZE.

use crate::ipc::{DiscordError, IpcClient};
use crate::secrets::{SecretStore, str_field, truthy};
use serde_json::{Map, Value, json};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

pub const SCOPES: [&str; 3] = ["rpc", "rpc.voice.read", "identify"];
pub const TOKEN_URL: &str = "https://discord.com/api/oauth2/token";
const DEFAULT_REDIRECT: &str = "http://127.0.0.1";

pub type Form = Vec<(&'static str, String)>;
/// POSTs a form to the token endpoint; returns (HTTP status, JSON body or null).
pub type TokenFetch = Arc<dyn Fn(Form) -> Pin<Box<dyn Future<Output = Result<(u16, Value), String>> + Send>> + Send + Sync>;

pub fn http_token_fetch(client: reqwest::Client) -> TokenFetch {
    Arc::new(move |form: Form| {
        let client = client.clone();
        Box::pin(async move {
            let res = client.post(TOKEN_URL).form(&form).send().await.map_err(|e| e.without_url().to_string())?;
            let status = res.status().as_u16();
            let body = res.json::<Value>().await.unwrap_or(Value::Null);
            Ok((status, body))
        })
    })
}

async fn token_request(fetch: &TokenFetch, form: Form) -> Result<Value, DiscordError> {
    let (status, body) = fetch(form).await.map_err(DiscordError::Other)?;
    let ok = (200..300).contains(&status) && body.get("access_token").is_some_and(truthy);
    if !ok {
        let reason = [body.get("error_description"), body.get("error")]
            .into_iter()
            .flatten()
            .find(|v| truthy(v))
            .map(|v| v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string()))
            .unwrap_or_else(|| format!("HTTP {status}"));
        return Err(DiscordError::Token(format!("Discord token request failed: {reason}")));
    }
    Ok(body)
}

fn to_token(body: &Value, now: i64) -> Value {
    let expires_in = match &body["expires_in"] {
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        Value::String(s) => s.trim().parse().unwrap_or(0.0),
        _ => 0.0,
    };
    json!({
        "accessToken": body["access_token"],
        "refreshToken": if body["refresh_token"].is_null() { json!("") } else { body["refresh_token"].clone() },
        "expiresAt": now + (expires_in * 1000.0) as i64,
    })
}

fn access_token(token: &Value) -> Option<String> {
    token.get("accessToken").filter(|v| truthy(v)).and_then(Value::as_str).map(str::to_string)
}

/// Authenticates the IPC connection. A rejected saved token falls back to AUTHORIZE once.
pub async fn authenticate(
    ipc: &IpcClient,
    client_id: &str,
    store: &SecretStore,
    fetch: &TokenFetch,
    now: impl Fn() -> i64,
) -> Result<Value, DiscordError> {
    let secrets = store.read();
    let Some(secret) = str_field(&secrets, "clientSecret").map(str::to_string) else {
        return Err(DiscordError::Setup("Missing Discord client secret: paste it in the editor (Discord tab).".into()));
    };
    let redirect = str_field(&secrets, "redirectUri").unwrap_or(DEFAULT_REDIRECT).to_string();
    let base = |grant: &str| -> Form { vec![("client_id", client_id.to_string()), ("client_secret", secret.clone()), ("grant_type", grant.to_string())] };

    let save_token = |token: Value| -> Result<Value, DiscordError> {
        store
            .update(|s: &mut Map<String, Value>| {
                s.insert("token".into(), token.clone());
            })
            .map_err(|e| DiscordError::Other(format!("could not save the Discord token: {e}")))?;
        Ok(token)
    };

    // AUTHORIZE must NOT carry redirect_uri ("Redirect URI cannot be used in the RPC OAuth2
    // Authorization flow"), but the app needs one registered under OAuth2 > Redirects or Discord
    // answers "Missing redirect_uri". The token exchange sends that registered value.
    let interactive = || async {
        let res = ipc.request("AUTHORIZE", json!({ "client_id": client_id, "scopes": SCOPES }), None).await;
        let res = res.map_err(|err| {
            let lower = err.message().to_lowercase();
            if lower.contains("missing \"redirect_uri") || lower.contains("missing redirect_uri") {
                let msg = format!(
                    "{} Add {redirect} under OAuth2 > Redirects in the Discord Developer Portal, save, then press Save and connect.",
                    err.message()
                );
                err.with_message(msg)
            } else {
                err
            }
        })?;
        let code = res["code"].as_str().unwrap_or("").to_string();
        let mut form = base("authorization_code");
        form.push(("code", code));
        form.push(("redirect_uri", redirect.clone()));
        let body = token_request(fetch, form).await?;
        save_token(to_token(&body, now()))
    };

    let saved = secrets.get("token").cloned().unwrap_or(Value::Null);
    let mut token = access_token(&saved);
    let from_saved = token.is_some();
    let expired = saved.get("expiresAt").and_then(Value::as_f64).is_some_and(|at| at - 60_000.0 <= now() as f64);
    if token.is_some() && expired {
        token = None;
        if let Some(refresh) = saved.get("refreshToken").filter(|v| truthy(v)).and_then(Value::as_str) {
            let mut form = base("refresh_token");
            form.push(("refresh_token", refresh.to_string()));
            if let Ok(body) = token_request(fetch, form).await {
                token = save_token(to_token(&body, now())).ok().as_ref().and_then(access_token);
            }
        }
    }
    let mut from_saved = from_saved;
    let token = match token {
        Some(t) => t,
        None => {
            from_saved = false;
            access_token(&interactive().await?).unwrap_or_default()
        }
    };

    match ipc.request("AUTHENTICATE", json!({ "access_token": token }), None).await {
        Ok(v) => Ok(v),
        // A token we just obtained interactively is not retried: surface the error.
        Err(e) if !from_saved => Err(e),
        // Saved/refreshed token rejected (revoked, scopes changed): ask once more.
        Err(_) => {
            let token = access_token(&interactive().await?).unwrap_or_default();
            ipc.request("AUTHENTICATE", json!({ "access_token": token }), None).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::fake::{self, Handlers};
    use std::sync::Mutex;
    use std::time::Duration;

    const CLIENT: &str = "123456789012345678";

    struct Mock {
        fetch: TokenFetch,
        calls: Arc<Mutex<Vec<Map<String, Value>>>>,
    }

    fn mock(replies: Vec<(u16, Value)>) -> Mock {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let replies = Arc::new(Mutex::new(replies.into_iter()));
        let c = calls.clone();
        let fetch: TokenFetch = Arc::new(move |form: Form| {
            c.lock().unwrap().push(form.into_iter().map(|(k, v)| (k.to_string(), json!(v))).collect());
            let next = replies.lock().unwrap().next();
            Box::pin(async move { next.ok_or_else(|| "no more replies".to_string()) })
        });
        Mock { fetch, calls }
    }

    fn token_response(token: &str) -> Value {
        json!({ "access_token": token, "refresh_token": format!("r-{token}"), "expires_in": 604800 })
    }

    async fn setup(handlers: Handlers, secrets: Option<Value>) -> (tempfile::TempDir, fake::FakeDiscord, IpcClient, SecretStore) {
        let dir = tempfile::tempdir().unwrap();
        if let Some(s) = secrets {
            std::fs::write(dir.path().join("secrets.json"), s.to_string()).unwrap();
        }
        let f = fake::start(handlers);
        let c = IpcClient::connect(CLIENT, &[f.pipe.clone()], Duration::from_secs(2)).await.unwrap();
        let store = SecretStore::new(dir.path());
        (dir, f, c.client, store)
    }

    fn saved(dir: &tempfile::TempDir) -> Value {
        serde_json::from_str(&std::fs::read_to_string(dir.path().join("secrets.json")).unwrap()).unwrap()
    }

    #[tokio::test]
    async fn first_run_authorizes_exchanges_and_saves_the_token() {
        let (dir, f, ipc, store) = setup(
            Handlers::default()
                .on("AUTHORIZE", |m, p| p.reply(m, json!({ "code": "code-1" })))
                .on("AUTHENTICATE", |m, p| p.reply(m, json!({ "user": { "id": "1" }, "access_token": m["args"]["access_token"] }))),
            Some(json!({ "clientSecret": "s3cret" })),
        )
        .await;
        let m = mock(vec![(200, token_response("tok-1"))]);
        let res = authenticate(&ipc, CLIENT, &store, &m.fetch, || 1000).await.unwrap();
        assert_eq!(res["user"]["id"], "1");
        let authz = f.commands().into_iter().find(|c| c["cmd"] == "AUTHORIZE").unwrap();
        assert_eq!(authz["args"], json!({ "client_id": CLIENT, "scopes": ["rpc", "rpc.voice.read", "identify"] }));
        let call = Value::Object(m.calls.lock().unwrap()[0].clone());
        assert_eq!(
            call,
            json!({ "client_id": CLIENT, "client_secret": "s3cret", "grant_type": "authorization_code", "code": "code-1", "redirect_uri": "http://127.0.0.1" })
        );
        let s = saved(&dir);
        assert_eq!(s["clientSecret"], "s3cret");
        assert_eq!(s["token"]["accessToken"], "tok-1");
        assert_eq!(s["token"]["expiresAt"], 1000 + 604800 * 1000);
    }

    #[tokio::test]
    async fn valid_saved_token_authenticates_without_authorize_or_network() {
        let (_dir, f, ipc, store) = setup(
            Handlers::default().on("AUTHENTICATE", |m, p| p.reply(m, json!({ "user": { "id": "1" } }))),
            Some(json!({ "clientSecret": "s", "token": { "accessToken": "saved", "refreshToken": "r", "expiresAt": 10_000_000 } })),
        )
        .await;
        let m = mock(vec![]);
        authenticate(&ipc, CLIENT, &store, &m.fetch, || 1000).await.unwrap();
        let cmds: Vec<(Value, Value)> = f.commands().iter().map(|c| (c["cmd"].clone(), c["args"]["access_token"].clone())).collect();
        assert_eq!(cmds, vec![(json!("AUTHENTICATE"), json!("saved"))]);
        assert!(m.calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn expired_token_refreshes_and_a_rejected_one_falls_back_to_authorize_once() {
        let n = Arc::new(Mutex::new(0));
        let (dir, f, ipc, store) = setup(
            Handlers::default().on("AUTHORIZE", |m, p| p.reply(m, json!({ "code": "code-2" }))).on("AUTHENTICATE", move |m, p| {
                let mut n = n.lock().unwrap();
                *n += 1;
                if *n == 1 { p.fail(m, 4009, "Invalid OAuth2 access token") } else { p.reply(m, json!({ "user": { "id": "1" } })) }
            }),
            Some(json!({ "clientSecret": "s", "token": { "accessToken": "old", "refreshToken": "r-old", "expiresAt": 500 } })),
        )
        .await;
        let m = mock(vec![(200, token_response("refreshed")), (200, token_response("fresh"))]);
        authenticate(&ipc, CLIENT, &store, &m.fetch, || 1000).await.unwrap();
        let calls = m.calls.lock().unwrap().clone();
        assert_eq!(calls.iter().map(|c| c["grant_type"].clone()).collect::<Vec<_>>(), vec![json!("refresh_token"), json!("authorization_code")]);
        assert_eq!(calls[0]["refresh_token"], "r-old");
        let cmds: Vec<Value> = f.commands().iter().map(|c| c["cmd"].clone()).collect();
        assert_eq!(cmds, vec![json!("AUTHENTICATE"), json!("AUTHORIZE"), json!("AUTHENTICATE")]);
        assert_eq!(saved(&dir)["token"]["accessToken"], "fresh");
    }

    #[tokio::test]
    async fn missing_client_secret_fails_with_a_setup_hint_and_never_calls_discord() {
        let (_dir, f, ipc, store) = setup(Handlers::default(), None).await;
        let m = mock(vec![]);
        let err = authenticate(&ipc, CLIENT, &store, &m.fetch, || 0).await.unwrap_err();
        assert!(matches!(&err, DiscordError::Setup(msg) if msg.contains("client secret")), "{err:?}");
        assert!(f.commands().is_empty());
    }

    #[tokio::test]
    async fn token_endpoint_error_surfaces_discords_message_without_the_secret() {
        let (_dir, _f, ipc, store) =
            setup(Handlers::default().on("AUTHORIZE", |m, p| p.reply(m, json!({ "code": "c" }))), Some(json!({ "clientSecret": "TOPSECRET" }))).await;
        let m = mock(vec![(401, json!({ "error": "invalid_client" }))]);
        let err = authenticate(&ipc, CLIENT, &store, &m.fetch, || 0).await.unwrap_err();
        assert!(matches!(err, DiscordError::Token(_)));
        assert!(err.message().contains("invalid_client"));
        assert!(!err.message().contains("TOPSECRET"));
    }
}
