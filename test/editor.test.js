import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FIELDS,
  slugify,
  uniquePresetId,
  mapErrors,
  describePath,
  translateMessage,
  isDirty,
  simulationVoice,
  membersNotConfigured,
  removeUser,
  renameUserId,
  duplicatePreset,
  deletePreset,
  moveItem,
  assetUsers,
  statusText,
  getAt,
  setAt,
  knownPaths,
  newPreset,
} from "../public/editor/logic.js";
import { defaultConfig, defaultPreset, validateConfig } from "../src/config.js";
import { buildTiles } from "../public/shared/model.js";

const A = "111111111111111111";
const B = "222222222222222222";
const C = "333333333333333333";
const user = (id, displayName = "", images = {}) => ({
  id,
  displayName,
  role: "",
  roleColor: "",
  images: { idle: "", talking: "", muted: "", deafened: "", ...images },
});
function cfg() {
  const c = defaultConfig();
  c.users = [user(A, "Kosmik", { idle: "k.png" }), user(B, "Fugi", { talking: "k.png", muted: "b.gif" })];
  c.presets.push({ ...defaultPreset("squad", "Squad"), mode: "slots", users: [B, A] });
  return c;
}

test("editor field schema matches the server schema (defaults, ranges, enums)", () => {
  const def = defaultPreset();
  for (const group of ["layout", "style"]) {
    assert.deepEqual(Object.keys(FIELDS[group]).sort(), Object.keys(def[group]).sort(), group);
    for (const [key, f] of Object.entries(FIELDS[group])) {
      assert.equal(f.def, def[group][key], `${group}.${key} default`);
      assert.ok(f.label, `${group}.${key} label`);
      const ok = (v) => {
        const c = defaultConfig();
        c.presets[0][group][key] = v;
        return validateConfig(c).ok;
      };
      if (f.kind === "int" || f.kind === "num") {
        const eps = f.kind === "int" ? 1 : 0.01;
        assert.ok(ok(f.min) && ok(f.max), `${group}.${key} bounds accepted`);
        assert.ok(!ok(f.min - eps) && !ok(f.max + eps), `${group}.${key} outside bounds rejected`);
      }
      if (f.kind === "enum") {
        for (const o of f.options) assert.ok(ok(o.value) && o.label, `${group}.${key}=${o.value}`);
        assert.ok(!ok("zzz"));
      }
      if (f.kind === "str") assert.ok(ok("x".repeat(f.max)) && !ok("x".repeat(f.max + 1)));
    }
  }
});

test("slugify makes valid preset ids from any name", () => {
  assert.equal(slugify("Pixel Café — Squad!"), "pixel-cafe-squad");
  assert.equal(slugify("  ¡¡¡  "), "preset");
  assert.equal(slugify("Ñandú 2"), "nandu-2");
  assert.equal(slugify("x".repeat(50)).length, 32);
});

test("uniquePresetId avoids taken ids and stays within 32 chars", () => {
  assert.equal(uniquePresetId("Principal", ["main"]), "principal");
  assert.equal(uniquePresetId("Main", ["main"]), "main-2");
  assert.equal(uniquePresetId("Main", ["main", "main-2", "main-3"]), "main-4");
  const long = uniquePresetId("y".repeat(40), ["y".repeat(32)]);
  assert.equal(long, "y".repeat(30) + "-2");
  const c = defaultConfig();
  c.presets[0].id = long;
  assert.ok(validateConfig(c).ok);
});

test("mapErrors attaches each error to its field or nearest known ancestor", () => {
  const known = new Set(["presets[0].layout.size", "presets[0].users", "users[1].id"]);
  const errors = [
    { path: "presets[0].layout.size", message: "must be an integer between 32 and 1024" },
    { path: "presets[0].users[2]", message: "unknown user id" },
    { path: "users[1].id", message: "duplicate user id" },
    { path: "", message: "config must be an object" },
  ];
  const { fields, summary } = mapErrors(errors, known);
  assert.deepEqual(fields, {
    "presets[0].layout.size": ["tiene que ser un entero entre 32 y 1024"],
    "presets[0].users": ["usuario desconocido"],
    "users[1].id": ["ID de usuario repetido"],
  });
  assert.deepEqual(
    summary.map((s) => s.target),
    ["presets[0].layout.size", "presets[0].users", "users[1].id", null],
  );
  assert.equal(summary[3].message, "config must be an object");
});

test("describePath names presets, users and fields in Spanish", () => {
  const c = cfg();
  assert.equal(describePath("presets[1].layout.size", c), "Preset «Squad» › Tamaño (px)");
  assert.equal(describePath("users[0].id", c), "Usuario «Kosmik» › ID de Discord");
  assert.equal(describePath("users[0].images.talking", c), "Usuario «Kosmik» › Imagen hablando");
  assert.equal(describePath("presets", c), "Presets");
});

test("translateMessage covers server messages and keeps unknown ones", () => {
  assert.equal(translateMessage("must be one of row, column, grid"), "tiene que ser uno de: row, column, grid");
  assert.equal(translateMessage("must be a number between 0 and 1"), "tiene que ser un número entre 0 y 1");
  assert.equal(translateMessage("is required"), "es obligatorio");
  assert.equal(translateMessage("something new"), "something new");
});

test("isDirty ignores key order and detects any value change", () => {
  const base = cfg();
  const reordered = JSON.parse(JSON.stringify(base, Object.keys(base).reverse()));
  const same = structuredClone(base);
  same.presets[0] = Object.fromEntries(Object.entries(same.presets[0]).reverse());
  assert.equal(isDirty(base, same), false);
  assert.equal(isDirty(base, structuredClone(base)), false);
  const changed = structuredClone(base);
  changed.presets[1].layout.size = 161;
  assert.equal(isDirty(base, changed), true);
  const moved = structuredClone(base);
  moved.presets[1].users.reverse();
  assert.equal(isDirty(base, moved), true);
  assert.ok(reordered);
});

test("simulationVoice manual: per-user states become members the tile model understands", () => {
  const c = cfg();
  const preset = c.presets[1];
  const voice = simulationVoice(c, preset, { source: "manual", states: { [A]: "talking", [B]: "deafened" } });
  assert.equal(voice.channel.name, "Simulación");
  assert.deepEqual(
    voice.members.map((m) => [m.id, m.name, m.speaking, m.muted, m.deafened]),
    [
      [B, "Fugi", false, true, true],
      [A, "Kosmik", true, false, false],
    ],
  );
  assert.match(voice.members[0].avatarUrl, /^data:image\/svg\+xml,/);
  const tiles = buildTiles(c, preset, voice);
  assert.deepEqual(tiles.map((t) => [t.id, t.state, t.image]), [
    [B, "deafened", "/assets/b.gif"],
    [A, "talking", "/assets/k.png"],
  ]);
  const off = simulationVoice(c, preset, { source: "manual", states: { [A]: "offline", [B]: "muted" } });
  assert.deepEqual(off.members.map((m) => [m.id, m.muted, m.deafened]), [[B, true, false]]);
  assert.deepEqual(buildTiles(c, preset, off).map((t) => t.state), ["muted", "offline"]);
  // Unknown users default to idle.
  const idle = simulationVoice(c, preset, { source: "manual", states: {} });
  assert.deepEqual(idle.members.map((m) => m.speaking), [false, false]);
});

test("simulationVoice demo sources: all talking, rotate tick, static states", () => {
  const c = cfg();
  const preset = c.presets[0];
  const all = simulationVoice(c, preset, { source: "all" });
  assert.ok(all.members.length >= 4 && all.members.every((m) => m.speaking && !m.muted && !m.deafened));
  const r0 = simulationVoice(c, preset, { source: "rotate", tick: 0 }).members.findIndex((m) => m.speaking);
  const r1 = simulationVoice(c, preset, { source: "rotate", tick: 1 }).members.findIndex((m) => m.speaking);
  assert.deepEqual([r0, r1], [0, 1]);
  const st = simulationVoice(c, preset, { source: "static" }).members;
  assert.deepEqual(st.map((m) => [m.speaking, m.muted, m.deafened]).slice(0, 4), [
    [true, false, false],
    [false, false, false],
    [false, true, false],
    [false, false, true],
  ]);
  const live = { channel: { id: "1", name: "General" }, members: [] };
  assert.equal(simulationVoice(c, preset, { source: "live", live }), live);
  assert.deepEqual(simulationVoice(c, preset, { source: "live" }).members, []);
});

test("membersNotConfigured lists call members missing from the config", () => {
  const voice = { members: [{ id: A, name: "k" }, { id: C, name: "Nuevo" }] };
  assert.deepEqual(membersNotConfigured(voice, cfg()).map((m) => m.id), [C]);
  assert.deepEqual(membersNotConfigured(null, cfg()), []);
});

test("removeUser and renameUserId keep preset user lists valid", () => {
  const c = removeUser(cfg(), A);
  assert.deepEqual(c.users.map((u) => u.id), [B]);
  assert.deepEqual(c.presets[1].users, [B]);
  assert.ok(validateConfig(c).ok);
  const r = renameUserId(cfg(), B, C);
  assert.deepEqual(r.users.map((u) => u.id), [A, C]);
  assert.deepEqual(r.presets[1].users, [C, A]);
  assert.ok(validateConfig(r).ok);
});

test("duplicatePreset copies with a unique id; deletePreset keeps at least one", () => {
  const c = duplicatePreset(cfg(), 1);
  assert.deepEqual(c.presets.map((p) => [p.id, p.name]), [
    ["main", "Principal"],
    ["squad", "Squad"],
    ["squad-copia", "Squad (copia)"],
  ]);
  assert.deepEqual(c.presets[2].users, [B, A]);
  c.presets[2].layout.size = 99;
  assert.equal(c.presets[1].layout.size, 160);
  assert.ok(validateConfig(c).ok);
  const one = deletePreset(deletePreset(cfg(), 0), 0);
  assert.deepEqual(one.presets.map((p) => p.id), ["squad"]);
});

test("moveItem moves within bounds and is a no-op at the edges", () => {
  assert.deepEqual(moveItem(["a", "b", "c"], 0, 1), ["b", "a", "c"]);
  assert.deepEqual(moveItem(["a", "b", "c"], 2, -1), ["a", "c", "b"]);
  assert.deepEqual(moveItem(["a", "b"], 0, -1), ["a", "b"]);
  assert.deepEqual(moveItem(["a", "b"], 1, 1), ["a", "b"]);
});

test("assetUsers lists who uses an image in the draft", () => {
  assert.deepEqual(assetUsers(cfg(), "k.png"), ["Kosmik", "Fugi"]);
  assert.deepEqual(assetUsers(cfg(), "none.png"), []);
});

test("statusText gives a Spanish message per Discord state", () => {
  assert.equal(statusText({ state: "authorizing", message: "x" }).text, "Aceptá el pedido en Discord");
  for (const state of ["setup_required", "discord_closed", "connecting", "ready", "error"]) {
    const s = statusText({ state, message: "detalle" });
    assert.ok(s.text && s.tone, state);
  }
  assert.equal(statusText({ state: "error", message: "boom" }).detail, "boom");
  assert.equal(statusText(null).tone, "bad");
});

test("getAt/setAt read and write config paths used as field ids", () => {
  const c = cfg();
  assert.equal(getAt(c, "presets[1].layout.size"), 160);
  assert.equal(getAt(c, "users[0].images.idle"), "k.png");
  assert.equal(getAt(c, "presets[9].name"), undefined);
  setAt(c, "presets[1].style.talkColor", "#ffffff");
  setAt(c, "users[1].images.deafened", "z.png");
  assert.equal(c.presets[1].style.talkColor, "#ffffff");
  assert.equal(c.users[1].images.deafened, "z.png");
});

test("knownPaths lists every editable field so any server error path can be placed", () => {
  const c = cfg();
  const known = knownPaths(c);
  for (const p of ["discord.clientId", "users", "presets", "users[1].id", "users[1].images.muted", "presets[1].users", "presets[1].showUnlisted", "presets[0].layout.offsetY", "presets[1].style.offlineText", "presets[0].id"]) {
    assert.ok(known.has(p), p);
  }
  // Every server error for a broken config lands on a known field.
  c.users[1].id = "abc";
  c.presets[1].users.push("999999999999999999");
  c.presets[0].layout.size = 5;
  c.presets[0].style.talkColor = "red";
  c.presets[1].name = "";
  const { errors } = validateConfig(c);
  assert.ok(errors.length >= 5);
  const { summary } = mapErrors(errors, known);
  assert.ok(summary.every((s) => s.target), JSON.stringify(summary));
});

test("newPreset builds the same preset the server would default to", () => {
  assert.deepEqual(newPreset("nuevo", "Nuevo"), defaultPreset("nuevo", "Nuevo"));
});
