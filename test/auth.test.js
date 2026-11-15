import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { IpcClient } from "../src/discord/ipc.js";
import { authenticate, SecretStore } from "../src/discord/auth.js";
import { startFakeDiscord } from "./helpers/fake-discord.js";

const CLIENT = "123456789012345678";

function tokenResponse(access, refresh = "r-" + access) {
  return { access_token: access, refresh_token: refresh, expires_in: 604800, token_type: "Bearer", scope: "rpc rpc.voice.read identify" };
}

function mockFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, body: Object.fromEntries(new URLSearchParams(init.body)) });
    const next = responses.shift();
    return { ok: next.status === 200, status: next.status, json: async () => next.body };
  };
  fn.calls = calls;
  return fn;
}

async function setup(handlers, secrets) {
  const dir = await mkdtemp(path.join(tmpdir(), "kv-auth-"));
  if (secrets) await writeFile(path.join(dir, "secrets.json"), JSON.stringify(secrets));
  const fake = await startFakeDiscord(handlers);
  const ipc = new IpcClient({ clientId: CLIENT, pipePaths: [fake.pipe] });
  await ipc.connect();
  const store = new SecretStore(dir);
  return { dir, fake, ipc, store, done: async () => (ipc.close(), fake.stop()) };
}

test("first run: AUTHORIZE -> token exchange -> AUTHENTICATE, token saved", async () => {
  const ctx = await setup(
    {
      AUTHORIZE: (msg, { reply }) => reply({ code: "code-1" }),
      AUTHENTICATE: (msg, { reply }) => reply({ user: { id: "1" }, access_token: msg.args.access_token }),
    },
    { clientSecret: "s3cret" },
  );
  const fetch = mockFetch([{ status: 200, body: tokenResponse("tok-1") }]);
  try {
    const res = await authenticate({ ipc: ctx.ipc, clientId: CLIENT, store: ctx.store, fetch, now: () => 1000 });
    assert.equal(res.user.id, "1");
    const authz = ctx.fake.commands().find((c) => c.cmd === "AUTHORIZE");
    assert.deepEqual(authz.args, { client_id: CLIENT, scopes: ["rpc", "rpc.voice.read", "identify"] });
    assert.equal(fetch.calls[0].url, "https://discord.com/api/oauth2/token");
    assert.deepEqual(fetch.calls[0].body, {
      client_id: CLIENT,
      client_secret: "s3cret",
      grant_type: "authorization_code",
      code: "code-1",
      redirect_uri: "http://127.0.0.1",
    });
    const saved = JSON.parse(await readFile(path.join(ctx.dir, "secrets.json"), "utf8"));
    assert.equal(saved.clientSecret, "s3cret");
    assert.equal(saved.token.accessToken, "tok-1");
    assert.equal(saved.token.expiresAt, 1000 + 604800 * 1000);
  } finally {
    await ctx.done();
  }
});

test("valid saved token authenticates without AUTHORIZE or network", async () => {
  const ctx = await setup(
    { AUTHENTICATE: (msg, { reply }) => reply({ user: { id: "1" } }) },
    { clientSecret: "s", token: { accessToken: "saved", refreshToken: "r", expiresAt: 10_000_000 } },
  );
  const fetch = mockFetch([]);
  try {
    await authenticate({ ipc: ctx.ipc, clientId: CLIENT, store: ctx.store, fetch, now: () => 1000 });
    assert.deepEqual(ctx.fake.commands().map((c) => [c.cmd, c.args.access_token]), [["AUTHENTICATE", "saved"]]);
    assert.equal(fetch.calls.length, 0);
  } finally {
    await ctx.done();
  }
});

test("expired token refreshes; rejected token falls back to AUTHORIZE once", async () => {
  let n = 0;
  const ctx = await setup(
    {
      AUTHORIZE: (msg, { reply }) => reply({ code: "code-2" }),
      AUTHENTICATE: (msg, { reply, fail }) => (n++ === 0 ? fail(4009, "Invalid OAuth2 access token") : reply({ user: { id: "1" } })),
    },
    { clientSecret: "s", token: { accessToken: "old", refreshToken: "r-old", expiresAt: 500 } },
  );
  const fetch = mockFetch([
    { status: 200, body: tokenResponse("refreshed") },
    { status: 200, body: tokenResponse("fresh") },
  ]);
  try {
    await authenticate({ ipc: ctx.ipc, clientId: CLIENT, store: ctx.store, fetch, now: () => 1000 });
    assert.deepEqual(fetch.calls.map((c) => c.body.grant_type), ["refresh_token", "authorization_code"]);
    assert.equal(fetch.calls[0].body.refresh_token, "r-old");
    assert.deepEqual(ctx.fake.commands().map((c) => c.cmd), ["AUTHENTICATE", "AUTHORIZE", "AUTHENTICATE"]);
    const saved = JSON.parse(await readFile(path.join(ctx.dir, "secrets.json"), "utf8"));
    assert.equal(saved.token.accessToken, "fresh");
  } finally {
    await ctx.done();
  }
});

test("missing client secret fails with a setup hint and never calls Discord", async () => {
  const ctx = await setup({}, null);
  const fetch = mockFetch([]);
  try {
    await assert.rejects(
      authenticate({ ipc: ctx.ipc, clientId: CLIENT, store: ctx.store, fetch }),
      (err) => err.code === "SETUP_REQUIRED" && /client secret/.test(err.message),
    );
    assert.equal(ctx.fake.commands().length, 0);
  } finally {
    await ctx.done();
  }
});

test("token endpoint error surfaces Discord's message without leaking the secret", async () => {
  const ctx = await setup({ AUTHORIZE: (msg, { reply }) => reply({ code: "c" }) }, { clientSecret: "TOPSECRET" });
  const fetch = mockFetch([{ status: 401, body: { error: "invalid_client" } }]);
  try {
    await assert.rejects(authenticate({ ipc: ctx.ipc, clientId: CLIENT, store: ctx.store, fetch }), (err) => {
      assert.match(err.message, /invalid_client/);
      assert.doesNotMatch(err.message, /TOPSECRET/);
      return true;
    });
  } finally {
    await ctx.done();
  }
});
