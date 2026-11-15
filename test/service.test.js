import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DiscordService } from "../src/discord/service.js";
import { SecretStore } from "../src/discord/auth.js";
import { startFakeDiscord, waitFor } from "./helpers/fake-discord.js";

const CLIENT = "123456789012345678";
const A = "111111111111111111";
const B = "222222222222222222";
const state = (id) => ({ nick: null, mute: false, voice_state: { mute: false, deaf: false, self_mute: false, self_deaf: false }, user: { id, username: "u" + id[0], avatar: null } });

test("follows the selected channel, subscribes, tracks speaking and resubscribes on switch", async () => {
  let api;
  let selected = { id: "c1", name: "General", guild_id: "g", voice_states: [state(A)] };
  const fake = await startFakeDiscord({
    connection: (a) => (api = a),
    AUTHENTICATE: (m, { reply }) => reply({ user: { id: A } }),
    GET_SELECTED_VOICE_CHANNEL: (m, { reply }) => reply(selected),
  });
  const dir = await mkdtemp(path.join(tmpdir(), "kv-svc-"));
  await writeFile(path.join(dir, "secrets.json"), JSON.stringify({ clientSecret: "s", token: { accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 1e9 } }));
  const svc = new DiscordService({ clientId: CLIENT, secrets: new SecretStore(dir), pipePaths: [fake.pipe], retryMs: 50 });
  const snaps = [];
  svc.on("state", (s) => snaps.push(s));
  try {
    svc.start();
    await waitFor(() => svc.status.state === "ready" && snaps.at(-1)?.channel?.id === "c1");
    const subs = fake.commands().filter((c) => c.cmd === "SUBSCRIBE").map((c) => `${c.evt}:${c.args.channel_id ?? "-"}`);
    assert.deepEqual(subs.sort(), [
      "SPEAKING_START:c1", "SPEAKING_STOP:c1", "VOICE_CHANNEL_SELECT:-",
      "VOICE_STATE_CREATE:c1", "VOICE_STATE_DELETE:c1", "VOICE_STATE_UPDATE:c1",
    ]);

    api.dispatch("SPEAKING_START", { user_id: A, channel_id: "c1" });
    await waitFor(() => snaps.at(-1).members[0]?.speaking === true);

    selected = { id: "c2", name: "Squad", voice_states: [state(B)] };
    api.dispatch("VOICE_CHANNEL_SELECT", { channel_id: "c2" });
    await waitFor(() => snaps.at(-1).channel?.id === "c2");
    assert.deepEqual(snaps.at(-1).members.map((m) => m.id), [B]);
    const unsubs = fake.commands().filter((c) => c.cmd === "UNSUBSCRIBE").map((c) => c.args.channel_id);
    assert.equal(unsubs.length, 5);
    assert.ok(unsubs.every((id) => id === "c1"));

    api.dispatch("VOICE_CHANNEL_SELECT", { channel_id: null });
    selected = null;
    await waitFor(() => snaps.at(-1).channel === null);
  } finally {
    svc.stop();
    await fake.stop();
  }
});

test("reports setup_required without a client id and retries when Discord is closed", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "kv-svc-"));
  const none = new DiscordService({ clientId: "", secrets: new SecretStore(dir), pipePaths: [], retryMs: 50 });
  none.start();
  assert.equal(none.status.state, "setup_required");
  none.stop();

  const svc = new DiscordService({ clientId: CLIENT, secrets: new SecretStore(dir), pipePaths: ["\\\\?\\pipe\\kv-none-2"], retryMs: 30 });
  const statuses = [];
  svc.on("status", (s) => statuses.push(s.state));
  svc.start();
  await waitFor(() => statuses.filter((s) => s === "discord_closed").length >= 2);
  svc.stop();
});

test("an authorization failure stops instead of re-prompting Discord every retry", async () => {
  const fake = await startFakeDiscord({
    AUTHORIZE: (m, { fail }) => fail(5000, 'OAuth2 Error: invalid_request: Missing "redirect_uri" in request.'),
  });
  const dir = await mkdtemp(path.join(tmpdir(), "kv-svc-"));
  await writeFile(path.join(dir, "secrets.json"), JSON.stringify({ clientSecret: "s" }));
  const svc = new DiscordService({ clientId: CLIENT, secrets: new SecretStore(dir), pipePaths: [fake.pipe], retryMs: 20 });
  try {
    svc.start();
    await waitFor(() => svc.status.state === "auth_failed");
    assert.ok(svc.status.message.includes('Missing "redirect_uri" in request. Add http://127.0.0.1 under OAuth2 > Redirects'), svc.status.message);
    await new Promise((r) => setTimeout(r, 150));
    const handshakes = fake.received.filter((r) => r.op === 0).length;
    assert.equal(handshakes, 1, "no automatic reconnect after an auth failure");
    assert.equal(fake.commands().filter((c) => c.cmd === "AUTHORIZE").length, 1);
    svc.restart();
    await waitFor(() => fake.commands().filter((c) => c.cmd === "AUTHORIZE").length === 2);
  } finally {
    svc.stop();
    await fake.stop();
  }
});

test("when Discord closes the pipe, its close code and message reach the status", async () => {
  let api;
  const fake = await startFakeDiscord({
    connection: (a) => (api = a),
    AUTHORIZE: () => api.send(2, { code: 4006, message: "Not authenticated or invalid scope" }),
  });
  const dir = await mkdtemp(path.join(tmpdir(), "kv-svc-"));
  await writeFile(path.join(dir, "secrets.json"), JSON.stringify({ clientSecret: "s" }));
  const svc = new DiscordService({ clientId: CLIENT, secrets: new SecretStore(dir), pipePaths: [fake.pipe], retryMs: 5000 });
  const statuses = [];
  svc.on("status", (s) => statuses.push(`${s.state}|${s.message}`));
  try {
    svc.start();
    await waitFor(() => statuses.some((s) => s.startsWith("discord_closed|") || s.startsWith("error|")));
    assert.ok(statuses.some((s) => s.includes("4006") && s.includes("Not authenticated or invalid scope")), statuses.join("\n"));
  } finally {
    svc.stop();
    await fake.stop();
  }
});
