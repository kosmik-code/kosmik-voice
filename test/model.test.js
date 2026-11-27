import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { buildTiles } from "../public/shared/model.js";
import { startRustApp } from "./helpers/rust-app.js";

let app;
before(async () => { app = await startRustApp(); });
after(async () => { await app?.close(); });
const defaultPreset = () => structuredClone(app.defaults.presets[0]);

const A = "111111111111111111";
const B = "222222222222222222";
const C = "333333333333333333";

function cfg() {
  const c = structuredClone(app.defaults);
  c.users = [
    { id: A, displayName: "Kosmik", role: "Host", roleColor: "#e98a9b", images: { idle: "k-idle.png", talking: "k-talk.gif", muted: "", deafened: "" } },
    { id: B, displayName: "", role: "", roleColor: "", images: { idle: "", talking: "", muted: "", deafened: "" } },
  ];
  return c;
}
const member = (id, extra = {}) => ({ id, name: `discord-${id[0]}`, avatarUrl: `https://cdn/${id}.png`, muted: false, deafened: false, speaking: false, ...extra });
const view = (tiles) => tiles.map((t) => [t.id, t.state, t.name, t.image]);

test("reactive: everyone present in join order, configured images and names win", () => {
  const preset = defaultPreset();
  const tiles = buildTiles(cfg(), preset, { members: [member(C), member(A, { speaking: true }), member(B, { muted: true })] });
  assert.deepEqual(view(tiles), [
    [C, "idle", "discord-3", `https://cdn/${C}.png`],
    [A, "talking", "Kosmik", "/assets/k-talk.gif"],
    [B, "muted", "discord-2", `https://cdn/${B}.png`],
  ]);
  assert.deepEqual([tiles[1].role, tiles[1].roleColor], ["Host", "#e98a9b"]);
});

test("reactive with listed users: listed first in preset order, unlisted optional", () => {
  const preset = { ...defaultPreset(), users: [B, A] };
  const voice = { members: [member(C), member(A), member(B)] };
  assert.deepEqual(buildTiles(cfg(), preset, voice).map((t) => t.id), [B, A, C]);
  assert.deepEqual(buildTiles(cfg(), { ...preset, showUnlisted: false }, voice).map((t) => t.id), [B, A]);
});

test("slots: fixed order, offline placeholders, unlisted members hidden", () => {
  const preset = { ...defaultPreset(), mode: "slots", users: [A, B] };
  const tiles = buildTiles(cfg(), preset, { members: [member(C, { speaking: true }), member(B, { deafened: true })] });
  assert.deepEqual(view(tiles), [
    [A, "offline", "Kosmik", "/assets/k-idle.png"],
    [B, "deafened", "discord-2", `https://cdn/${B}.png`],
  ]);
  const unknownOffline = buildTiles(cfg(), preset, { members: [] });
  assert.deepEqual(view(unknownOffline)[1], [B, "offline", "Slot 2", null]);
});

test("slots without a user list use every configured user", () => {
  const preset = { ...defaultPreset(), mode: "slots", users: [] };
  assert.deepEqual(buildTiles(cfg(), preset, { members: [] }).map((t) => t.id), [A, B]);
});

test("image fallbacks per state: deafened > muted > idle > avatar", () => {
  const c = cfg();
  c.users[0].images = { idle: "i.png", talking: "", muted: "m.png", deafened: "" };
  const p = defaultPreset();
  const img = (extra) => buildTiles(c, p, { members: [member(A, extra)] })[0].image;
  assert.equal(img({ speaking: true }), "/assets/i.png");
  assert.equal(img({ muted: true }), "/assets/m.png");
  assert.equal(img({ deafened: true }), "/assets/m.png");
  c.users[0].images = { idle: "", talking: "", muted: "", deafened: "" };
  assert.equal(img({ deafened: true }), `https://cdn/${A}.png`);
});

test("hideWhenSilent hides non-talking tiles; null voice is treated as empty", () => {
  const p = { ...defaultPreset(), style: { ...defaultPreset().style, hideWhenSilent: true } };
  const tiles = buildTiles(cfg(), p, { members: [member(A, { speaking: true }), member(B)] });
  assert.deepEqual(tiles.map((t) => t.hidden), [false, true]);
  assert.deepEqual(buildTiles(cfg(), p, null), []);
});

test("demo voice: configured users present with a rotating speaker; static tick shows every state", async () => {
  const { demoVoice } = await import("../public/shared/model.js");
  const c = cfg();
  const preset = { ...defaultPreset(), mode: "slots", users: [A, B] };
  const v0 = demoVoice(c, preset, 0);
  assert.deepEqual(v0.members.map((m) => [m.id, m.speaking]), [[A, true], [B, false]]);
  const v1 = demoVoice(c, preset, 1);
  assert.deepEqual(v1.members.map((m) => [m.id, m.speaking]), [[A, false], [B, true]]);
  const stat = demoVoice(c, { ...defaultPreset(), users: [] }, "static");
  assert.equal(stat.members.length, 4, "pads to four demo members");
  assert.deepEqual(stat.members.map((m) => [m.speaking, m.muted, m.deafened]), [
    [true, false, false], [false, false, false], [false, true, false], [false, false, true],
  ]);
  assert.ok(stat.members.every((m) => m.avatarUrl.startsWith("data:image/svg+xml")));
});
