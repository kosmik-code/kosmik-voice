import { test } from "node:test";
import assert from "node:assert/strict";
import { VoiceRoom, avatarUrl } from "../src/discord/voice.js";

const A = "111111111111111111";
const B = "222222222222222222";

const vs = (id, extra = {}, voice = {}) => ({
  nick: extra.nick ?? null,
  mute: false,
  voice_state: { mute: false, deaf: false, self_mute: false, self_deaf: false, suppress: false, ...voice },
  user: { id, username: `user${id[0]}`, global_name: extra.global ?? null, avatar: extra.avatar ?? null },
});

test("avatar urls: animated, static and default", () => {
  assert.equal(avatarUrl({ id: A, avatar: "a_abc" }), `https://cdn.discordapp.com/avatars/${A}/a_abc.gif?size=256`);
  assert.equal(avatarUrl({ id: A, avatar: "abc" }), `https://cdn.discordapp.com/avatars/${A}/abc.png?size=256`);
  const n = Number((BigInt(A) >> 22n) % 6n);
  assert.equal(avatarUrl({ id: A, avatar: null }), `https://cdn.discordapp.com/embed/avatars/${n}.png`);
});

test("channel snapshot keeps join order and resolves names nick > global > username", () => {
  const room = new VoiceRoom();
  room.setChannel({ id: "c1", name: "General", guild_id: "g1", voice_states: [vs(A, { nick: "Nick" }), vs(B, { global: "Bee" })] });
  const s = room.snapshot();
  assert.deepEqual(s.channel, { id: "c1", name: "General", guildId: "g1" });
  assert.deepEqual(s.members.map((m) => [m.id, m.name]), [[A, "Nick"], [B, "Bee"]]);
  assert.equal(s.members[0].speaking, false);
});

test("speaking, mute and deaf transitions", () => {
  const room = new VoiceRoom();
  room.setChannel({ id: "c1", name: "General", voice_states: [vs(A)] });
  assert.equal(room.apply("SPEAKING_START", { user_id: A, channel_id: "c1" }), true);
  assert.equal(room.snapshot().members[0].speaking, true);
  room.apply("VOICE_STATE_UPDATE", vs(A, {}, { self_mute: true }));
  let m = room.snapshot().members[0];
  assert.deepEqual([m.muted, m.deafened, m.speaking], [true, false, false]);
  room.apply("VOICE_STATE_UPDATE", vs(A, {}, { deaf: true }));
  m = room.snapshot().members[0];
  assert.deepEqual([m.muted, m.deafened], [false, true]);
  room.apply("SPEAKING_STOP", { user_id: A, channel_id: "c1" });
  assert.equal(room.snapshot().members[0].speaking, false);
});

test("join and leave; events for other channels or unknown users are ignored", () => {
  const room = new VoiceRoom();
  room.setChannel({ id: "c1", name: "General", voice_states: [vs(A)] });
  room.apply("VOICE_STATE_CREATE", vs(B));
  assert.deepEqual(room.snapshot().members.map((m) => m.id), [A, B]);
  assert.equal(room.apply("SPEAKING_START", { user_id: A, channel_id: "other" }), false);
  assert.equal(room.apply("SPEAKING_START", { user_id: "333333333333333333", channel_id: "c1" }), false);
  room.apply("VOICE_STATE_DELETE", vs(A));
  assert.deepEqual(room.snapshot().members.map((m) => m.id), [B]);
  room.setChannel(null);
  assert.deepEqual(room.snapshot(), { channel: null, members: [] });
});
