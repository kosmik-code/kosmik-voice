//! Voice channel state reduced from Discord RPC payloads into the overlay snapshot.

use crate::secrets::truthy;
use serde_json::{Value, json};

pub fn avatar_url(user: &Value) -> String {
    let id = key(&user["id"]);
    if let Some(avatar) = user["avatar"].as_str().filter(|a| !a.is_empty()) {
        let ext = if avatar.starts_with("a_") { "gif" } else { "png" };
        return format!("https://cdn.discordapp.com/avatars/{id}/{avatar}.{ext}?size=256");
    }
    let index = id.parse::<u64>().map(|n| (n >> 22) % 6).unwrap_or(0);
    format!("https://cdn.discordapp.com/embed/avatars/{index}.png")
}

/// Map key for an id as JavaScript would print it.
fn key(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn first_truthy<'a>(vals: &[&'a Value]) -> Option<&'a Value> {
    vals.iter().copied().find(|v| truthy(v))
}

fn to_member(vs: &Value, previous: Option<&Value>) -> Value {
    let v = &vs["voice_state"];
    let user = &vs["user"];
    let deafened = truthy(&v["deaf"]) || truthy(&v["self_deaf"]);
    let muted = !deafened && (truthy(&v["mute"]) || truthy(&v["self_mute"]) || truthy(&v["suppress"]));
    let name = first_truthy(&[&vs["nick"], &user["global_name"], &user["username"]]).cloned().unwrap_or(json!("?"));
    // A muted user cannot be speaking; Discord may not send SPEAKING_STOP first.
    let speaking = !(muted || deafened) && previous.is_some_and(|p| truthy(&p["speaking"]));
    json!({ "id": user["id"], "name": name, "avatarUrl": avatar_url(user), "muted": muted, "deafened": deafened, "speaking": speaking })
}

#[derive(Default)]
pub struct VoiceRoom {
    channel: Option<Value>,
    /// Join order.
    members: Vec<(String, Value)>,
}

impl VoiceRoom {
    pub fn has_channel(&self) -> bool {
        self.channel.is_some()
    }

    pub fn set_channel(&mut self, ch: &Value) {
        self.members.clear();
        if ch.is_null() {
            self.channel = None;
            return;
        }
        let name = if ch["name"].is_null() { json!("") } else { ch["name"].clone() };
        let guild = ch["guild_id"].clone();
        self.channel = Some(json!({ "id": ch["id"], "name": name, "guildId": guild }));
        for vs in ch["voice_states"].as_array().into_iter().flatten() {
            if truthy(&vs["user"]["id"]) {
                self.put(key(&vs["user"]["id"]), to_member(vs, None));
            }
        }
    }

    fn put(&mut self, id: String, member: Value) {
        match self.members.iter_mut().find(|(k, _)| *k == id) {
            Some(slot) => slot.1 = member,
            None => self.members.push((id, member)),
        }
    }

    fn get(&self, id: &str) -> Option<&Value> {
        self.members.iter().find(|(k, _)| k == id).map(|(_, m)| m)
    }

    /// Applies one RPC event. Returns true when the snapshot changed.
    pub fn apply(&mut self, evt: &str, data: &Value) -> bool {
        let Some(channel) = &self.channel else { return false };
        if data.is_null() {
            return false;
        }
        match evt {
            "VOICE_STATE_CREATE" | "VOICE_STATE_UPDATE" => {
                if !truthy(&data["user"]["id"]) {
                    return false;
                }
                let id = key(&data["user"]["id"]);
                let member = to_member(data, self.get(&id));
                self.put(id, member);
                true
            }
            "VOICE_STATE_DELETE" => {
                let id = key(&data["user"]["id"]);
                let before = self.members.len();
                self.members.retain(|(k, _)| *k != id);
                self.members.len() != before
            }
            "SPEAKING_START" | "SPEAKING_STOP" => {
                if truthy(&data["channel_id"]) && data["channel_id"] != channel["id"] {
                    return false;
                }
                let id = key(&data["user_id"]);
                let Some((_, m)) = self.members.iter_mut().find(|(k, _)| *k == id) else { return false };
                let speaking = evt == "SPEAKING_START" && !truthy(&m["muted"]) && !truthy(&m["deafened"]);
                if m["speaking"] == json!(speaking) {
                    return false;
                }
                m["speaking"] = json!(speaking);
                true
            }
            _ => false,
        }
    }

    pub fn snapshot(&self) -> Value {
        json!({ "channel": self.channel.clone().unwrap_or(Value::Null), "members": self.members.iter().map(|(_, m)| m.clone()).collect::<Vec<_>>() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "111111111111111111";
    const B: &str = "222222222222222222";

    fn vs(id: &str, extra: Value) -> Value {
        let mut v = json!({ "nick": null, "voice_state": { "mute": false, "deaf": false, "self_mute": false, "self_deaf": false }, "user": { "id": id, "username": format!("u{id}"), "avatar": null } });
        if let (Some(o), Some(e)) = (v.as_object_mut(), extra.as_object()) {
            for (k, x) in e {
                o.insert(k.clone(), x.clone());
            }
        }
        v
    }

    #[test]
    fn avatar_urls_animated_static_and_default() {
        assert_eq!(avatar_url(&json!({ "id": A, "avatar": "a_x" })), format!("https://cdn.discordapp.com/avatars/{A}/a_x.gif?size=256"));
        assert_eq!(avatar_url(&json!({ "id": A, "avatar": "x" })), format!("https://cdn.discordapp.com/avatars/{A}/x.png?size=256"));
        let index = (A.parse::<u64>().unwrap() >> 22) % 6;
        assert_eq!(avatar_url(&json!({ "id": A })), format!("https://cdn.discordapp.com/embed/avatars/{index}.png"));
        assert_eq!(avatar_url(&json!({ "id": "x" })), "https://cdn.discordapp.com/embed/avatars/0.png");
    }

    #[test]
    fn channel_snapshot_keeps_join_order_and_resolves_names() {
        let mut room = VoiceRoom::default();
        room.set_channel(&json!({ "id": "c1", "name": "General", "guild_id": "g", "voice_states": [
            vs(B, json!({ "nick": "Nick" })),
            vs(A, json!({ "user": { "id": A, "username": "user", "global_name": "Global" } })),
        ] }));
        let s = room.snapshot();
        assert_eq!(s["channel"], json!({ "id": "c1", "name": "General", "guildId": "g" }));
        let names: Vec<_> = s["members"].as_array().unwrap().iter().map(|m| m["name"].clone()).collect();
        assert_eq!(names, vec![json!("Nick"), json!("Global")]);
    }

    #[test]
    fn speaking_mute_and_deaf_transitions() {
        let mut room = VoiceRoom::default();
        room.set_channel(&json!({ "id": "c1", "voice_states": [vs(A, json!({}))] }));
        assert!(room.apply("SPEAKING_START", &json!({ "user_id": A, "channel_id": "c1" })));
        assert!(!room.apply("SPEAKING_START", &json!({ "user_id": A })));
        assert_eq!(room.snapshot()["members"][0]["speaking"], true);
        assert!(room.apply("VOICE_STATE_UPDATE", &vs(A, json!({ "voice_state": { "self_mute": true } }))));
        let m = &room.snapshot()["members"][0];
        assert_eq!((m["muted"].clone(), m["speaking"].clone()), (json!(true), json!(false)));
        assert!(!room.apply("SPEAKING_START", &json!({ "user_id": A })));
        assert!(room.apply("VOICE_STATE_UPDATE", &vs(A, json!({ "voice_state": { "self_mute": true, "self_deaf": true } }))));
        let m = &room.snapshot()["members"][0];
        assert_eq!((m["muted"].clone(), m["deafened"].clone()), (json!(false), json!(true)));
    }

    #[test]
    fn join_and_leave_and_foreign_events_are_ignored() {
        let mut room = VoiceRoom::default();
        assert!(!room.apply("VOICE_STATE_CREATE", &vs(A, json!({}))));
        room.set_channel(&json!({ "id": "c1", "voice_states": [] }));
        assert!(room.apply("VOICE_STATE_CREATE", &vs(A, json!({}))));
        assert!(room.apply("VOICE_STATE_CREATE", &vs(B, json!({}))));
        assert!(!room.apply("SPEAKING_START", &json!({ "user_id": A, "channel_id": "other" })));
        assert!(!room.apply("SPEAKING_START", &json!({ "user_id": "333333333333333333" })));
        assert!(room.apply("VOICE_STATE_DELETE", &json!({ "user": { "id": A } })));
        assert!(!room.apply("VOICE_STATE_DELETE", &json!({ "user": { "id": A } })));
        let ids: Vec<_> = room.snapshot()["members"].as_array().unwrap().iter().map(|m| m["id"].clone()).collect();
        assert_eq!(ids, vec![json!(B)]);
    }
}
