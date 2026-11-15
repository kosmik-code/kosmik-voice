import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { startServer } from "../src/server.js";
import { ConfigStore, defaultConfig } from "../src/config.js";
import { SecretStore } from "../src/discord/auth.js";

const USER = "123456789012345678";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

class FakeDiscord extends EventEmitter {
  constructor() {
    super();
    this.status = { state: "ready", message: "" };
    this.restarts = [];
  }
  snapshot() {
    return { channel: { id: "c1", name: "General", guildId: null }, members: [] };
  }
  restart(id) {
    this.restarts.push(id);
  }
}

let ctx;
before(async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "kv-srv-"));
  const publicDir = await mkdtemp(path.join(tmpdir(), "kv-pub-"));
  await mkdir(path.join(publicDir, "overlay"));
  await mkdir(path.join(publicDir, "editor"));
  await writeFile(path.join(publicDir, "overlay", "index.html"), "<h1>overlay</h1>");
  await writeFile(path.join(publicDir, "editor", "index.html"), "<h1>editor</h1>");
  await writeFile(path.join(dataDir, "outside.txt"), "nope");
  const config = new ConfigStore(dataDir);
  await config.load();
  const secrets = new SecretStore(dataDir);
  await secrets.write({ clientSecret: "TOPSECRET", token: { accessToken: "TOKEN123", refreshToken: "R", expiresAt: 1 } });
  const discord = new FakeDiscord();
  const srv = await startServer({ port: 0, dataDir, publicDir, config, secrets, discord });
  const origin = srv.url;
  const api = (p, init = {}) =>
    fetch(origin + p, {
      ...init,
      headers: { Origin: origin, "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
  ctx = { srv, origin, api, dataDir, config, secrets, discord };
});
after(() => ctx.srv.close());

test("binds to loopback and serves overlay/editor pages", async () => {
  assert.match(ctx.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  const ov = await fetch(ctx.origin + "/overlay/main");
  assert.equal(ov.status, 200);
  assert.equal(await ov.text(), "<h1>overlay</h1>");
  assert.equal(ov.headers.get("x-content-type-options"), "nosniff");
  const ed = await fetch(ctx.origin + "/editor/");
  assert.equal(await ed.text(), "<h1>editor</h1>");
  const root = await fetch(ctx.origin + "/", { redirect: "manual" });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get("location"), "/editor/");
});

test("static and asset routes refuse traversal", async () => {
  for (const p of ["/editor/..%2f..%2foutside.txt", "/assets/..%2Foutside.txt", "/assets/outside.txt", "/editor/%2e%2e/%2e%2e/outside.txt"]) {
    const res = await fetch(ctx.origin + p);
    assert.equal(res.status, 404, p);
  }
});

test("rejects foreign Host (DNS rebinding) on every route", async () => {
  const { request } = await import("node:http");
  const status = await new Promise((resolve, reject) => {
    const u = new URL(ctx.origin);
    request({ host: u.hostname, port: u.port, path: "/api/config", headers: { Host: "evil.example" } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on("error", reject).end();
  });
  assert.equal(status, 403);
});

test("config GET/PUT round-trip, validation errors leave stored config unchanged", async () => {
  const cfg = await (await ctx.api("/api/config")).json();
  assert.deepEqual(cfg, ctx.config.current);
  assert.equal(cfg.presets[0].id, defaultConfig().presets[0].id);

  const next = structuredClone(cfg);
  next.users.push({ id: USER, displayName: "Kosmik" });
  next.presets[0].mode = "slots";
  next.presets[0].users = [USER];
  const ok = await ctx.api("/api/config", { method: "PUT", body: JSON.stringify(next) });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).presets[0].mode, "slots");

  const disk = await readFile(path.join(ctx.dataDir, "config.json"), "utf8");
  const bad = structuredClone(next);
  bad.presets[0].layout = { size: 1 };
  const res = await ctx.api("/api/config", { method: "PUT", body: JSON.stringify(bad) });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { errors: [{ path: "presets[0].layout.size", message: "must be an integer between 32 and 1024" }] });
  assert.equal(await readFile(path.join(ctx.dataDir, "config.json"), "utf8"), disk);

  const notJson = await ctx.api("/api/config", { method: "PUT", body: "{" });
  assert.equal(notJson.status, 400);
});

test("mutations need same-origin Origin and JSON content type", async () => {
  const body = JSON.stringify(ctx.config.current);
  const foreign = await fetch(ctx.origin + "/api/config", { method: "PUT", body, headers: { Origin: "https://evil.example", "Content-Type": "application/json" } });
  assert.equal(foreign.status, 403);
  const noOrigin = await fetch(ctx.origin + "/api/config", { method: "PUT", body, headers: { "Content-Type": "application/json" } });
  assert.equal(noOrigin.status, 403);
  const form = await fetch(ctx.origin + "/api/config", { method: "PUT", body, headers: { Origin: ctx.origin, "Content-Type": "text/plain" } });
  assert.equal(form.status, 415);
});

test("asset upload: sanitized unique names, magic-byte check, size cap, serve, delete guard", async () => {
  const up = (name, buf, type = "image/png") =>
    ctx.api(`/api/assets?name=${encodeURIComponent(name)}`, { method: "POST", body: buf, headers: { "Content-Type": type } });

  const r1 = await up("Mi Avatar (1).PNG", PNG);
  assert.equal(r1.status, 201);
  assert.deepEqual(await r1.json(), { name: "mi-avatar-1.png" });
  const r2 = await up("Mi Avatar (1).PNG", PNG);
  assert.deepEqual(await r2.json(), { name: "mi-avatar-1-2.png" });

  const fakePng = await up("x.png", Buffer.from("<script>alert(1)</script>"));
  assert.equal(fakePng.status, 400);
  const svg = await up("x.svg", Buffer.from("<svg/>"), "image/svg+xml");
  assert.equal(svg.status, 400);
  const big = await up("big.png", Buffer.concat([PNG, Buffer.alloc(11 * 1024 * 1024)]));
  assert.equal(big.status, 413);

  const got = await fetch(ctx.origin + "/assets/mi-avatar-1.png");
  assert.equal(got.status, 200);
  assert.equal(got.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), PNG);

  const list = await (await ctx.api("/api/assets")).json();
  assert.deepEqual(list.map((a) => a.name), ["mi-avatar-1-2.png", "mi-avatar-1.png"]);

  const cfg = structuredClone(ctx.config.current);
  cfg.users = [{ id: USER, displayName: "K", images: { idle: "mi-avatar-1.png" } }];
  cfg.presets[0].users = [];
  assert.equal((await ctx.api("/api/config", { method: "PUT", body: JSON.stringify(cfg) })).status, 200);
  const inUse = await ctx.api("/api/assets/mi-avatar-1.png", { method: "DELETE" });
  assert.equal(inUse.status, 409);
  const del = await ctx.api("/api/assets/mi-avatar-1-2.png", { method: "DELETE" });
  assert.equal(del.status, 204);
  const files = await readdir(path.join(ctx.dataDir, "assets"));
  assert.deepEqual(files, ["mi-avatar-1.png"]);
});

test("discord settings never expose secret or token, restart on save", async () => {
  const st = await (await ctx.api("/api/discord")).json();
  assert.deepEqual(st, { clientId: "", hasClientSecret: true, hasToken: true, status: { state: "ready", message: "" } });
  const res = await ctx.api("/api/discord", { method: "PUT", body: JSON.stringify({ clientId: "987654321098765432", clientSecret: "NEWSECRET" }) });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.doesNotMatch(text, /NEWSECRET|TOPSECRET|TOKEN123/);
  assert.deepEqual(ctx.discord.restarts, ["987654321098765432"]);
  const secrets = await ctx.secrets.read();
  assert.equal(secrets.clientSecret, "NEWSECRET");
  assert.equal(secrets.token, undefined, "changing the app drops the old token");
  assert.equal(ctx.config.current.discord.clientId, "987654321098765432");

  const keep = await ctx.api("/api/discord", { method: "PUT", body: JSON.stringify({ clientId: "987654321098765432" }) });
  assert.equal(keep.status, 200);
  assert.equal((await ctx.secrets.read()).clientSecret, "NEWSECRET");

  const bad = await ctx.api("/api/discord", { method: "PUT", body: JSON.stringify({ clientId: "abc" }) });
  assert.equal(bad.status, 400);

  for (const p of ["/api/config", "/api/assets", "/api/discord", "/data/secrets.json", "/secrets.json"]) {
    const body = await (await fetch(ctx.origin + p)).text();
    assert.doesNotMatch(body, /NEWSECRET|TOKEN123/, p);
  }
});

test("websocket: hello snapshot, live voice/status/config broadcasts, foreign origin refused", async () => {
  const ws = new WebSocket(ctx.origin.replace("http", "ws") + "/ws", { origin: ctx.origin });
  const msgs = [];
  ws.on("message", (m) => msgs.push(JSON.parse(m)));
  await new Promise((r) => ws.once("open", r));
  const until = async (fn) => {
    for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(fn());
  };
  await until(() => msgs.length === 1);
  assert.equal(msgs[0].type, "hello");
  assert.deepEqual(Object.keys(msgs[0]).sort(), ["config", "status", "type", "voice"]);
  ctx.discord.emit("state", { channel: null, members: [] });
  ctx.discord.emit("status", { state: "discord_closed", message: "x" });
  await until(() => msgs.length === 3);
  assert.deepEqual(msgs[1], { type: "voice", voice: { channel: null, members: [] } });
  assert.deepEqual(msgs[2], { type: "status", status: { state: "discord_closed", message: "x" } });
  await ctx.api("/api/config", { method: "PUT", body: JSON.stringify(ctx.config.current) });
  await until(() => msgs.some((m) => m.type === "config"));
  ws.close();

  const evil = new WebSocket(ctx.origin.replace("http", "ws") + "/ws", { origin: "https://evil.example" });
  const code = await new Promise((r) => evil.once("unexpected-response", (req, res) => r(res.statusCode)).once("error", () => r("error")));
  assert.equal(code, 403);
});

test("rejected WS upgrade followed by a client reset does not crash the server", async () => {
  const net = await import("node:net");
  const { port } = new URL(ctx.origin);
  await new Promise((resolve, reject) => {
    const s = net.connect(Number(port), "127.0.0.1", () => {
      s.write(
        `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: https://evil.example\r\n` +
          "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
      );
    });
    s.once("data", (d) => {
      assert.match(String(d), /^HTTP\/1\.1 403/);
      s.resetAndDestroy();
      setTimeout(resolve, 200);
    });
    s.on("error", () => {});
    setTimeout(() => reject(new Error("no response")), 3000);
  });
  const res = await fetch(ctx.origin + "/api/config");
  assert.equal(res.status, 200);
});

test("pages refuse to be framed by other sites", async () => {
  for (const p of ["/editor/", "/overlay/main"]) {
    const res = await fetch(ctx.origin + p);
    assert.equal(res.headers.get("content-security-policy"), "frame-ancestors 'self'", p);
  }
});
