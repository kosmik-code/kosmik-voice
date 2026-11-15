import { test } from "node:test";
import assert from "node:assert/strict";
import { IpcClient, encodeFrame, FrameDecoder } from "../src/discord/ipc.js";
import { startFakeDiscord, waitFor } from "./helpers/fake-discord.js";

test("frames round-trip across split chunks", () => {
  const a = encodeFrame(1, { cmd: "X", nonce: "1" });
  const b = encodeFrame(3, { ping: true });
  const all = Buffer.concat([a, b]);
  const dec = new FrameDecoder();
  const out = [];
  for (let i = 0; i < all.length; i += 5) out.push(...dec.push(all.subarray(i, i + 5)));
  assert.deepEqual(out, [
    { op: 1, data: { cmd: "X", nonce: "1" } },
    { op: 3, data: { ping: true } },
  ]);
});

test("decoder rejects oversized frames", () => {
  const head = Buffer.alloc(8);
  head.writeInt32LE(1, 0);
  head.writeInt32LE(64 * 1024 * 1024, 4);
  assert.throws(() => new FrameDecoder().push(head), /frame too large/);
});

test("connects, handshakes with client id, resolves READY user", async () => {
  const fake = await startFakeDiscord();
  const ipc = new IpcClient({ clientId: "123456789012345678", pipePaths: [`${fake.pipe}-missing`, fake.pipe] });
  try {
    const ready = await ipc.connect();
    assert.equal(ready.user.username, "streamer");
    assert.deepEqual(fake.received[0], { op: 0, msg: { v: 1, client_id: "123456789012345678" } });
  } finally {
    ipc.close();
    await fake.stop();
  }
});

test("request resolves by nonce, ERROR rejects with code", async () => {
  const fake = await startFakeDiscord({
    GET_SELECTED_VOICE_CHANNEL: (msg, { reply }) => setTimeout(() => reply({ id: "c1" }), 20),
    AUTHENTICATE: (msg, { fail }) => fail(4009, "Invalid OAuth2 access token"),
  });
  const ipc = new IpcClient({ clientId: "123456789012345678", pipePaths: [fake.pipe] });
  try {
    await ipc.connect();
    const [chan, err] = await Promise.allSettled([
      ipc.request("GET_SELECTED_VOICE_CHANNEL"),
      ipc.request("AUTHENTICATE", { access_token: "x" }),
    ]);
    assert.deepEqual(chan.value, { id: "c1" });
    assert.equal(err.reason.code, 4009);
    assert.equal(err.reason.message, "Invalid OAuth2 access token");
    const cmds = fake.commands();
    assert.equal(cmds.length, 2);
    assert.notEqual(cmds[0].nonce, cmds[1].nonce);
  } finally {
    ipc.close();
    await fake.stop();
  }
});

test("emits dispatched events, answers PING, rejects pending on close", async () => {
  let api;
  const fake = await startFakeDiscord({ connection: (a) => (api = a), SUBSCRIBE: () => {} });
  const ipc = new IpcClient({ clientId: "123456789012345678", pipePaths: [fake.pipe] });
  const events = [];
  ipc.on("event", (evt, data) => events.push([evt, data]));
  const closed = new Promise((r) => ipc.once("close", r));
  await ipc.connect();
  api.dispatch("SPEAKING_START", { user_id: "u1", channel_id: "c1" });
  api.send(3, { n: 7 });
  await waitFor(() => events.length === 1 && fake.received.some((r) => r.op === 4));
  assert.deepEqual(events[0], ["SPEAKING_START", { user_id: "u1", channel_id: "c1" }]);
  assert.deepEqual(fake.received.find((r) => r.op === 4).msg, { n: 7 });
  const pending = ipc.request("SUBSCRIBE", {}, "VOICE_STATE_CREATE");
  await waitFor(() => fake.commands().length === 1);
  api.close();
  await assert.rejects(pending, /connection closed/);
  await closed;
  await fake.stop();
});

test("connect fails when no pipe answers", async () => {
  const ipc = new IpcClient({ clientId: "123456789012345678", pipePaths: ["\\\\?\\pipe\\kv-none-1"] });
  await assert.rejects(ipc.connect(), /Discord is not running/);
});
