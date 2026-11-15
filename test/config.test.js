import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig, validateConfig, ConfigStore } from "../src/config.js";

const USER = "123456789012345678";

function baseConfig() {
  const c = defaultConfig();
  c.users.push({ id: USER, displayName: "Kosmik", role: "Host", images: { idle: "kosmik-idle.png", talking: "kosmik-talk.gif" } });
  return c;
}

test("default config is valid and fills preset defaults", () => {
  const r = validateConfig(defaultConfig());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const p = r.value.presets[0];
  assert.equal(p.mode, "reactive");
  assert.equal(p.theme, "pixel-cafe");
  assert.equal(p.layout.size, 160);
  assert.equal(p.style.talkAnimation, "bounce");
});

test("partial preset gets defaults, user image slots are optional", () => {
  const c = baseConfig();
  c.presets = [{ id: "squad", name: "Squad", mode: "slots", users: [USER] }];
  const r = validateConfig(c);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.value.presets[0].layout.direction, "row");
  assert.equal(r.value.presets[0].style.offlineText, "OFFLINE");
  assert.deepEqual(r.value.users[0].images, { idle: "kosmik-idle.png", talking: "kosmik-talk.gif", muted: "", deafened: "" });
});

test("rejects invalid values with a path per error", () => {
  const c = baseConfig();
  c.users.push({ id: "12", displayName: "x".repeat(80) });
  c.users[0].images.idle = "../secrets.json";
  c.presets[0].mode = "carousel";
  c.presets[0].layout = { size: 5000 };
  c.presets[0].style = { talkColor: "red;}" };
  const r = validateConfig(c);
  assert.equal(r.ok, false);
  const paths = r.errors.map((e) => e.path).sort();
  assert.deepEqual(paths, [
    "presets[0].layout.size",
    "presets[0].mode",
    "presets[0].style.talkColor",
    "users[0].images.idle",
    "users[1].displayName",
    "users[1].id",
  ]);
});

test("rejects duplicate user and preset ids and unknown preset users", () => {
  const c = baseConfig();
  c.users.push({ ...c.users[0] });
  c.presets.push({ ...c.presets[0] });
  c.presets[0].users = ["999999999999999999"];
  const r = validateConfig(c);
  assert.equal(r.ok, false);
  const msgs = r.errors.map((e) => `${e.path}: ${e.message}`);
  assert.ok(msgs.includes("users[1].id: duplicate user id"), msgs.join("\n"));
  assert.ok(msgs.includes("presets[1].id: duplicate preset id"), msgs.join("\n"));
  assert.ok(msgs.includes("presets[0].users[0]: unknown user id"), msgs.join("\n"));
});

test("rejects unknown top-level shape", () => {
  assert.equal(validateConfig(null).ok, false);
  assert.equal(validateConfig({ users: "nope", presets: [] }).ok, false);
});

test("store creates default file, saves atomically and refuses invalid config without touching disk", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "kv-config-"));
  const store = new ConfigStore(dir);
  const first = await store.load();
  assert.equal(first.presets.length, 1);
  const onDisk = JSON.parse(await readFile(path.join(dir, "config.json"), "utf8"));
  assert.deepEqual(onDisk, first);

  const next = baseConfig();
  const saved = await store.save(next);
  assert.equal(saved.users[0].id, USER);
  const before = await readFile(path.join(dir, "config.json"), "utf8");

  const bad = baseConfig();
  bad.presets[0].mode = "nope";
  await assert.rejects(store.save(bad), (err) => err.code === "INVALID_CONFIG" && err.errors.length === 1);
  assert.equal(await readFile(path.join(dir, "config.json"), "utf8"), before);
  assert.deepEqual(store.current.users[0].id, USER);
  const files = (await readdir(dir)).sort();
  assert.deepEqual(files, ["config.json"]);
});

test("store keeps a broken file aside and starts from defaults", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "kv-config-"));
  await writeFile(path.join(dir, "config.json"), "{ not json");
  const store = new ConfigStore(dir);
  const cfg = await store.load();
  assert.equal(cfg.presets[0].id, "main");
  const files = (await readdir(dir)).sort();
  assert.equal(files.length, 2);
  assert.equal(files[1], "config.json");
  assert.match(files[0], /^config\.broken-\d+\.json$/);
  const broken = await readFile(path.join(dir, files[0]), "utf8");
  assert.equal(broken, "{ not json");
});
