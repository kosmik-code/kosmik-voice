//! Startup update check for the installed app: is there a newer GitHub release?
//! One anonymous GitHub API call per start; nothing about the user is sent. Any failure ends as
//! "unknown" and the app keeps working. KV_UPDATE_CHECK=0 turns it off.

use serde_json::{Value, json};
use std::time::Duration;

pub const REPO: &str = "kosmik-code/kosmik-voice";

/// a > b, comparing up to three dot-separated numbers ("v" prefix and suffixes ignored).
pub fn newer(a: &str, b: &str) -> bool {
    let parts = |s: &str| -> Vec<u64> {
        s.trim_start_matches('v').split('.').take(3).map(|p| p.split(|c: char| !c.is_ascii_digit()).next().and_then(|d| d.parse().ok()).unwrap_or(0)).collect()
    };
    let (pa, pb) = (parts(a), parts(b));
    for i in 0..3 {
        let (x, y) = (pa.get(i).copied().unwrap_or(0), pb.get(i).copied().unwrap_or(0));
        if x != y {
            return x > y;
        }
    }
    false
}

/// Turns the latest-release JSON (None when unreachable) into what the editor's banner reads.
pub fn evaluate(release: Option<&Value>, current: &str) -> Value {
    let Some(tag) = release.and_then(|r| r["tag_name"].as_str()) else { return json!({ "state": "unknown", "via": "app" }) };
    let version = tag.trim_start_matches('v');
    if !newer(version, current) {
        return json!({ "state": "current", "via": "app" });
    }
    let url = release
        .and_then(|r| r["html_url"].as_str())
        .filter(|u| u.starts_with("https://github.com/"))
        .map(str::to_string)
        .unwrap_or_else(|| format!("https://github.com/{REPO}/releases/latest"));
    json!({ "state": "available", "via": "app", "behind": null, "url": url, "latest": { "version": version } })
}

pub async fn check_for_update(client: &reqwest::Client, current: &str) -> Value {
    let res = client
        .get(format!("https://api.github.com/repos/{REPO}/releases/latest"))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "kosmik-voice-update-check")
        .timeout(Duration::from_secs(5))
        .send()
        .await;
    let release = match res {
        Ok(r) if r.status().is_success() => r.json::<Value>().await.ok(),
        _ => None,
    };
    evaluate(release.as_ref(), current)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_numerically() {
        assert!(newer("0.10.0", "0.9.9"));
        assert!(newer("v1.0.0", "0.9.0"));
        assert!(!newer("0.2.0", "0.2.0"));
        assert!(!newer("0.1.9", "0.2.0"));
        assert!(newer("0.2.1-beta", "0.2.0"));
    }

    #[test]
    fn a_newer_release_is_available_with_its_page() {
        let r = json!({ "tag_name": "v0.3.0", "html_url": "https://github.com/kosmik-code/kosmik-voice/releases/tag/v0.3.0" });
        assert_eq!(
            evaluate(Some(&r), "0.2.0"),
            json!({ "state": "available", "via": "app", "behind": null, "url": "https://github.com/kosmik-code/kosmik-voice/releases/tag/v0.3.0", "latest": { "version": "0.3.0" } })
        );
        assert_eq!(evaluate(Some(&json!({ "tag_name": "v0.2.0" })), "0.2.0")["state"], "current");
        assert_eq!(evaluate(None, "0.2.0")["state"], "unknown");
        let odd = json!({ "tag_name": "v9.0.0", "html_url": "https://evil.example/" });
        assert_eq!(evaluate(Some(&odd), "0.2.0")["url"], "https://github.com/kosmik-code/kosmik-voice/releases/latest");
    }
}
