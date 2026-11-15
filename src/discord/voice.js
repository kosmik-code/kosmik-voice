// Voice channel state reduced from Discord RPC payloads into the overlay snapshot.

export function avatarUrl(user) {
  if (user?.avatar) {
    const ext = user.avatar.startsWith("a_") ? "gif" : "png";
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=256`;
  }
  let index = 0;
  try {
    index = Number((BigInt(user.id) >> 22n) % 6n);
  } catch {
    // non-numeric id: keep the first default avatar
  }
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

function toMember(vs, previous) {
  const v = vs.voice_state ?? {};
  const user = vs.user ?? {};
  const deafened = Boolean(v.deaf || v.self_deaf);
  const muted = !deafened && Boolean(v.mute || v.self_mute || v.suppress);
  return {
    id: user.id,
    name: vs.nick || user.global_name || user.username || "?",
    avatarUrl: avatarUrl(user),
    muted,
    deafened,
    // A muted user cannot be speaking; Discord may not send SPEAKING_STOP first.
    speaking: muted || deafened ? false : Boolean(previous?.speaking),
  };
}

export class VoiceRoom {
  constructor() {
    this.channel = null;
    this.members = new Map(); // insertion order = join order
  }

  setChannel(ch) {
    this.members.clear();
    if (!ch) {
      this.channel = null;
      return;
    }
    this.channel = { id: ch.id, name: ch.name ?? "", guildId: ch.guild_id ?? null };
    for (const vs of ch.voice_states ?? []) {
      if (vs?.user?.id) this.members.set(vs.user.id, toMember(vs));
    }
  }

  /** Apply one RPC event. Returns true when the snapshot changed. */
  apply(evt, data) {
    if (!this.channel || !data) return false;
    switch (evt) {
      case "VOICE_STATE_CREATE":
      case "VOICE_STATE_UPDATE": {
        const id = data.user?.id;
        if (!id) return false;
        this.members.set(id, toMember(data, this.members.get(id)));
        return true;
      }
      case "VOICE_STATE_DELETE":
        return this.members.delete(data.user?.id);
      case "SPEAKING_START":
      case "SPEAKING_STOP": {
        if (data.channel_id && data.channel_id !== this.channel.id) return false;
        const m = this.members.get(data.user_id);
        if (!m) return false;
        const speaking = evt === "SPEAKING_START" && !m.muted && !m.deafened;
        if (m.speaking === speaking) return false;
        m.speaking = speaking;
        return true;
      }
      default:
        return false;
    }
  }

  snapshot() {
    return {
      channel: this.channel ? { ...this.channel } : null,
      members: [...this.members.values()].map((m) => ({ ...m })),
    };
  }
}
