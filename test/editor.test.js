import { after, before, test } from "node:test";
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
  CANVASES,
  canvasSize,
  TEMPLATES,
  presetFromTemplate,
  callMembers,
  setAlias,
  discordHelp,
  firstSteps,
  obsSetup,
  USER_LABELS,
  THEMES,
} from "../public/editor/logic.js";
import { buildTiles, boxLayout } from "../public/shared/model.js";
import { startRustApp } from "./helpers/rust-app.js";

let app;
before(async () => { app = await startRustApp(); });
after(async () => { await app?.close(); });
const defaultConfig = () => structuredClone(app.defaults);
const defaultPreset = (id = "main", name = "Principal") => ({ ...defaultConfig().presets[0], id, name });

async function saveConfig(draft, label = "PUT /api/config") {
  const { status, body } = await app.putConfig(draft);
  assert.equal(status, 200, `${label}: ${JSON.stringify(body)}`);
  return body;
}

async function rejectConfig(draft) {
  const before = await app.getConfig();
  const { status, body } = await app.putConfig(draft);
  assert.equal(status, 400, JSON.stringify(body));
  assert.deepEqual(await app.getConfig(), before, "rejected PUT leaves config unchanged");
  return body.errors;
}

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

test("editor field schema matches the server schema (defaults, ranges, enums)", async () => {
  const def = app.defaults.presets[0];
  for (const group of ["layout", "style"]) {
    assert.deepEqual(Object.keys(FIELDS[group]).sort(), Object.keys(def[group]).sort(), group);
    for (const [key, f] of Object.entries(FIELDS[group])) {
      const path = `presets[0].${group}.${key}`;
      assert.equal(f.def, def[group][key], `${path} default`);
      assert.ok(f.label, `${path} label`);
      const check = async (value, message) => {
        const c = defaultConfig();
        c.presets[0][group][key] = value;
        if (message) {
          assert.deepEqual(await rejectConfig(c), [{ path, message }]);
        } else {
          const saved = await saveConfig(c, `${path}=${value}`);
          assert.equal(saved.presets[0][group][key], value, path);
        }
      };
      if (f.kind === "int" || f.kind === "num") {
        const eps = f.kind === "int" ? 1 : 0.01;
        const type = f.kind === "int" ? "an integer" : "a number";
        const message = `must be ${type} between ${f.min} and ${f.max}`;
        await check(f.min);
        await check(f.max);
        await check(f.min - eps, message);
        await check(f.max + eps, message);
      }
      if (f.kind === "enum") {
        for (const o of f.options) {
          assert.ok(o.label, `${path}=${o.value}`);
          await check(o.value);
        }
        await check("zzz", `must be one of ${f.options.map((o) => o.value).join(", ")}`);
      }
      if (f.kind === "str") {
        await check("x".repeat(f.max));
        await check("x".repeat(f.max + 1), `must be text of ${f.min}-${f.max} characters`);
      }
    }
  }
});

test("slugify makes valid preset ids from any name", () => {
  assert.equal(slugify("Pixel Café — Squad!"), "pixel-cafe-squad");
  assert.equal(slugify("  ¡¡¡  "), "preset");
  assert.equal(slugify("Ñandú 2"), "nandu-2");
  assert.equal(slugify("x".repeat(50)).length, 32);
});

test("uniquePresetId avoids taken ids and stays within 32 chars", async () => {
  assert.equal(uniquePresetId("Principal", ["main"]), "principal");
  assert.equal(uniquePresetId("Main", ["main"]), "main-2");
  assert.equal(uniquePresetId("Main", ["main", "main-2", "main-3"]), "main-4");
  const long = uniquePresetId("y".repeat(40), ["y".repeat(32)]);
  assert.equal(long, "y".repeat(30) + "-2");
  const c = defaultConfig();
  c.presets[0].id = long;
  assert.equal((await saveConfig(c)).presets[0].id, long);
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

test("removeUser and renameUserId keep preset user lists valid", async () => {
  const c = removeUser(cfg(), A);
  assert.deepEqual(c.users.map((u) => u.id), [B]);
  assert.deepEqual(c.presets[1].users, [B]);
  await saveConfig(c);
  const r = renameUserId(cfg(), B, C);
  assert.deepEqual(r.users.map((u) => u.id), [A, C]);
  assert.deepEqual(r.presets[1].users, [C, A]);
  await saveConfig(r);
});

test("duplicatePreset copies with a unique id; deletePreset keeps at least one", async () => {
  const c = duplicatePreset(cfg(), 1);
  assert.deepEqual(c.presets.map((p) => [p.id, p.name]), [
    ["main", "Principal"],
    ["squad", "Squad"],
    ["squad-copia", "Squad (copia)"],
  ]);
  assert.deepEqual(c.presets[2].users, [B, A]);
  c.presets[2].layout.size = 99;
  assert.equal(c.presets[1].layout.size, 160);
  await saveConfig(c);
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
  assert.equal(statusText({ state: "auth_failed", message: "x" }).text, "La autorización falló. Revisá el error, corregilo y tocá Guardar para reintentar.");
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

test("knownPaths lists every editable field so any server error path can be placed", async () => {
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
  const errors = await rejectConfig(c);
  assert.ok(errors.length >= 5);
  const { summary } = mapErrors(errors, known);
  assert.ok(summary.every((s) => s.target), JSON.stringify(summary));
});

test("newPreset builds the same preset the server would default to", () => {
  assert.deepEqual(newPreset("nuevo", "Nuevo"), defaultPreset("nuevo", "Nuevo"));
});

// ---------------------------------------------------------------- S11 canvas

test("CANVASES mirrors the server canvas enum, 2K labelled", async () => {
  assert.deepEqual(CANVASES.map((c) => c.value).sort(), ["1080x1920", "1280x720", "1920x1080", "2560x1440"]);
  for (const c of CANVASES) {
    const cf = defaultConfig();
    cf.presets[0].canvas = c.value;
    assert.equal((await saveConfig(cf, c.value)).presets[0].canvas, c.value);
    assert.equal(`${c.width}x${c.height}`, c.value);
    assert.ok(c.label);
  }
  const bad = defaultConfig();
  bad.presets[0].canvas = "zzz";
  assert.deepEqual(await rejectConfig(bad), [{
    path: "presets[0].canvas", message: "must be one of 1920x1080, 2560x1440, 1280x720, 1080x1920",
  }]);
  assert.equal(CANVASES.find((c) => c.value === "2560x1440").label, "2K (2560×1440)");
  assert.equal(newPreset("x", "X").canvas, defaultPreset("x", "X").canvas);
  assert.deepEqual(canvasSize("2560x1440"), { width: 2560, height: 1440 });
  assert.deepEqual(canvasSize(undefined), { width: 1920, height: 1080 });
  assert.deepEqual(canvasSize("zzz"), { width: 1920, height: 1080 });
  assert.ok(knownPaths(cfg()).has("presets[0].canvas"));
});

test("obsSetup gives the overlay URL and the exact width/height of the preset canvas", () => {
  const p = { ...newPreset("squad", "Squad"), canvas: "2560x1440" };
  const o = obsSetup(p, "http://127.0.0.1:7429");
  assert.equal(o.url, "http://127.0.0.1:7429/overlay/squad");
  assert.equal(o.width, 2560);
  assert.equal(o.height, 1440);
  assert.match(o.text, /Ancho 2560.*Alto 1440/);
  const legacy = newPreset("main", "Principal");
  delete legacy.canvas;
  assert.deepEqual([obsSetup(legacy, "").width, obsSetup(legacy, "").height], [1920, 1080]);
});

test("box placement: old presets stay on the canvas; a box is sized for its people", async () => {
  const legacy = cfg();
  delete legacy.presets[0].layout.placement;
  delete legacy.presets[0].layout.room;
  const saved = await saveConfig(legacy);
  assert.equal(saved.presets[0].layout.placement, "canvas");
  assert.equal(saved.presets[0].layout.room, 4);

  const p = newPreset("box", "Box");
  p.layout = { ...p.layout, placement: "box", direction: "row", size: 100, gap: 10, padding: 0, room: 3 };
  const b = boxLayout({ users: [] }, p);
  assert.equal(b.count, 3);
  assert.equal(b.cols, 3);
  // three tiles and two gaps, plus the bleed on both sides
  assert.equal(b.width, 3 * 100 + 2 * 10 + 2 * b.bleed);
  // one more person needs a wider box; a column is one tile wide and three tall
  assert.ok(boxLayout({}, { ...p, layout: { ...p.layout, room: 4 } }).width > b.width);
  const col = boxLayout({}, { ...p, layout: { ...p.layout, direction: "column" } });
  assert.equal(col.cols, 1);
  assert.ok(col.height > col.width);
  // a grid never uses more columns than people
  assert.equal(boxLayout({}, { ...p, layout: { ...p.layout, direction: "grid", columns: 6, room: 2 } }).cols, 2);
  // slots: one per listed person (or every user when none are listed)
  assert.equal(boxLayout({ users: [{ id: A }, { id: B }] }, { ...p, mode: "slots", users: [] }).count, 2);
  assert.equal(boxLayout({ users: [{ id: A }, { id: B }] }, { ...p, mode: "slots", users: [A] }).count, 1);

  const o = obsSetup(p, "", { users: [] });
  assert.equal(o.box, true);
  assert.deepEqual([o.width, o.height], [b.width, b.height]);
  assert.equal(obsSetup({ ...p, layout: { ...p.layout, placement: "canvas" } }, "").box, false);
});

// ---------------------------------------------------------------- S12 templates
test("editor theme options mirror the server theme enum with human labels", async () => {
  const expected = ["pixel-cafe", "clean", "neon", "comic", "glass"];
  assert.deepEqual(THEMES.map((t) => t.value), expected);
  const by = Object.fromEntries(THEMES.map((t) => [t.value, t]));
  assert.equal(by.neon.label, "Neón");
  assert.equal(by.comic.label, "Cómic / sticker");
  assert.equal(by.glass.label, "Glass / moderno");
  for (const t of THEMES) {
    assert.ok(t.label && t.description && t.description.length < 120, t.value);
    const c = defaultConfig();
    c.presets[0].theme = t.value;
    assert.equal((await saveConfig(c, t.value)).presets[0].theme, t.value);
  }
  const bad = defaultConfig();
  bad.presets[0].theme = "zzz";
  assert.deepEqual(await rejectConfig(bad), [{
    path: "presets[0].theme", message: `must be one of ${expected.join(", ")}`,
  }]);
  assert.equal(newPreset("x", "X").theme, defaultPreset().theme);
  for (const tpl of TEMPLATES) if (tpl.preset.theme) assert.ok(expected.includes(tpl.preset.theme), tpl.key);
});

const REQUIRED_TEMPLATES = ["Fila abajo", "Columna al costado", "Squad en grilla", "PNGtuber solo", "Solo quien habla", "Burbujas", "Vertical", "En blanco"];

test("TEMPLATES include the required ones, each with description and canvas", () => {
  const names = TEMPLATES.map((tpl) => tpl.name);
  for (const n of REQUIRED_TEMPLATES) assert.ok(names.includes(n), n);
  assert.equal(new Set(TEMPLATES.map((tpl) => tpl.key)).size, TEMPLATES.length);
  for (const tpl of TEMPLATES) {
    assert.ok(tpl.description && tpl.description.length < 120 && !tpl.description.includes("\n"), tpl.name);
    assert.ok(CANVASES.some((c) => c.value === tpl.canvas), tpl.name);
  }
  const by = Object.fromEntries(TEMPLATES.map((tpl) => [tpl.name, tpl.preset]));
  assert.equal(TEMPLATES.find((tpl) => tpl.name === "Vertical").canvas, "1080x1920");
  assert.equal(by["Squad en grilla"].mode, "slots");
  assert.equal(by["Squad en grilla"].layout.direction, "grid");
  assert.equal(by["Squad en grilla"].layout.columns, 4);
  assert.equal(by["PNGtuber solo"].mode, "slots");
  assert.equal(by["PNGtuber solo"].style.showNames, false);
  assert.ok(by["PNGtuber solo"].layout.size >= 380);
  assert.equal(by["Solo quien habla"].style.hideWhenSilent, true);
  assert.equal(by["Burbujas"].theme, "clean");
  assert.equal(by["Burbujas"].style.shape, "circle");
  assert.equal(by["Burbujas"].style.talkAnimation, "pulse");
  assert.deepEqual([by["Burbujas"].layout.alignX, by["Burbujas"].layout.alignY], ["right", "top"]);
  assert.deepEqual([by["Columna al costado"].layout.direction, by["Columna al costado"].layout.alignX, by["Columna al costado"].layout.alignY], ["column", "left", "center"]);
  assert.deepEqual([by["Fila abajo"].layout.alignX, by["Fila abajo"].layout.alignY], ["center", "bottom"]);
});

test("presetFromTemplate: every template on every canvas yields a valid config with a unique id", async () => {
  for (const tpl of TEMPLATES) {
    for (const canvas of CANVASES.map((c) => c.value)) {
      const base = cfg();
      const r = presetFromTemplate(base, tpl.key, { canvas });
      assert.ok(!r.error, `${tpl.key} ${canvas}`);
      await saveConfig(r.config, `${tpl.key} ${canvas}`);
      assert.equal(r.index, base.presets.length);
      const ids = r.config.presets.map((p) => p.id);
      assert.equal(new Set(ids).size, ids.length);
      assert.equal(r.config.presets[r.index].name, tpl.name);
      assert.equal(base.presets.length, 2, "input not mutated");
    }
  }
  let c = cfg();
  c = presetFromTemplate(c, "fila-abajo").config;
  c = presetFromTemplate(c, "fila-abajo").config;
  assert.equal(new Set(c.presets.map((p) => p.id)).size, c.presets.length);
  await saveConfig(c);
});

test("presetFromTemplate scales pixel sizes for 2K and keeps the template canvas for vertical", () => {
  const fhd = presetFromTemplate(cfg(), "fila-abajo", { canvas: "1920x1080" });
  const k2 = presetFromTemplate(cfg(), "fila-abajo", { canvas: "2560x1440" });
  const a = fhd.config.presets[fhd.index];
  const b = k2.config.presets[k2.index];
  assert.equal(a.canvas, "1920x1080");
  assert.equal(b.canvas, "2560x1440");
  assert.equal(b.layout.size, Math.round((a.layout.size * 4) / 3));
  assert.equal(b.style.nameSize, Math.round((a.style.nameSize * 4) / 3));
  assert.equal(b.layout.columns, a.layout.columns);
  const v = presetFromTemplate(cfg(), "vertical", { canvas: "2560x1440" });
  assert.equal(v.config.presets[v.index].canvas, "1080x1920");
  const d = presetFromTemplate(cfg(), "squad");
  assert.equal(d.config.presets[d.index].canvas, "1920x1080");
});

test("presetFromTemplate: slots templates take the configured users or ask to add them", async () => {
  const withUsers = presetFromTemplate(cfg(), "squad");
  assert.deepEqual(withUsers.config.presets[withUsers.index].users, [A, B]);
  assert.equal(withUsers.needsUsers, false);
  const solo = presetFromTemplate(cfg(), "pngtuber");
  assert.deepEqual(solo.config.presets[solo.index].users, [A]);
  const empty = defaultConfig();
  const none = presetFromTemplate(empty, "squad");
  assert.equal(none.needsUsers, true);
  assert.deepEqual(none.config.presets[none.index].users, []);
  await saveConfig(none.config);
  assert.equal(presetFromTemplate(empty, "fila-abajo").needsUsers, false);
});

test("presetFromTemplate refuses past the preset limit and unknown templates", () => {
  const c = defaultConfig();
  while (c.presets.length < 20) c.presets.push(newPreset(`p${c.presets.length}`, "P"));
  assert.equal(presetFromTemplate(c, "fila-abajo").error, "limit");
  assert.equal(presetFromTemplate(cfg(), "nope").error, "unknown");
  const blank = presetFromTemplate(defaultConfig(), "blank");
  const p = blank.config.presets[blank.index];
  assert.deepEqual({ ...p, id: "x", name: "x" }, newPreset("x", "x"));
});

// ---------------------------------------------------------------- S13 aliases

test("user displayName is labelled as an on-screen alias", () => {
  assert.equal(USER_LABELS.displayName, "Alias (cómo aparece en pantalla)");
  assert.equal(describePath("users[0].displayName", cfg()), "Usuario «Kosmik» › Alias (cómo aparece en pantalla)");
});

test("callMembers lists live members with their Discord name and current alias", () => {
  const voice = { channel: { id: "1", name: "General" }, members: [
    { id: A, name: "kosmik_dc", avatarUrl: "https://cdn/a.png", speaking: true },
    { id: C, name: "Invitada", avatarUrl: "" },
  ] };
  assert.deepEqual(callMembers(voice, cfg()), [
    { id: A, discordName: "kosmik_dc", avatarUrl: "https://cdn/a.png", alias: "Kosmik", configured: true, speaking: true },
    { id: C, discordName: "Invitada", avatarUrl: "", alias: "", configured: false, speaking: false },
  ]);
  assert.deepEqual(callMembers(null, cfg()), []);
});

test("setAlias creates, edits and clears aliases within the schema", async () => {
  const m = { id: C, discordName: "Invitada" };
  const created = setAlias(cfg(), m, "Lu");
  assert.deepEqual(created.users.at(-1), { id: C, displayName: "Lu", role: "", roleColor: "", images: { idle: "", talking: "", muted: "", deafened: "" } });
  await saveConfig(created);
  const edited = setAlias(created, m, "L".repeat(60));
  assert.equal(edited.users.filter((u) => u.id === C).length, 1);
  assert.equal(edited.users.find((u) => u.id === C).displayName.length, 40);
  await saveConfig(edited);
  const cleared = setAlias(edited, m, "");
  assert.equal(cleared.users.find((u) => u.id === C).displayName, "");
  assert.equal(buildTiles(cleared, cleared.presets[0], { members: [{ id: C, name: "Invitada" }] })[0].name, "Invitada");
  assert.equal(buildTiles(created, created.presets[0], { members: [{ id: C, name: "Invitada" }] })[0].name, "Lu");
  assert.equal(setAlias(cfg(), m, "").users.length, 2, "empty alias creates nothing");
  assert.equal(setAlias(cfg(), { id: "demo-1" }, "X").users.length, 2, "invalid ids ignored");
  const base = cfg();
  setAlias(base, { id: A }, "Otro");
  assert.equal(base.users[0].displayName, "Kosmik", "input not mutated");
  const full = defaultConfig();
  for (let n = 0; n < 50; n++) full.users.push(user(String(10n ** 17n + BigInt(n))));
  assert.equal(setAlias(full, m, "Lu").users.length, 50, "user limit respected");
});

// ---------------------------------------------------------------- S10 guidance

test("discordHelp explains known Discord errors in plain words", () => {
  const redirect = discordHelp({ state: "auth_failed", message: 'OAuth2 Error: invalid_request: Missing "redirect_uri" in request.' });
  assert.match(redirect.title, /redirect/i);
  assert.ok(redirect.steps.some((s) => /Save Changes/.test(s)));
  assert.ok(redirect.steps.some((s) => s.includes("http://127.0.0.1")));
  assert.ok(discordHelp({ state: "auth_failed", message: "denied" }).title);
  assert.match(discordHelp({ state: "discord_closed", message: "x" }).title, /Discord/);
  assert.ok(discordHelp({ state: "error", message: "handshake timed out" }).steps.length);
  assert.equal(discordHelp({ state: "ready", message: "" }), null);
  assert.equal(discordHelp(null), null);
});

test("firstSteps reports live completion for connect, preset and OBS", () => {
  const fresh = firstSteps({ status: { state: "setup_required" }, config: defaultConfig(), flags: {} });
  assert.deepEqual(fresh.map((s) => s.key), ["discord", "preset", "obs"]);
  assert.deepEqual(fresh.map((s) => s.done), [false, false, false]);
  assert.ok(fresh.every((s) => s.label && s.tab));
  const ready = firstSteps({ status: { state: "ready" }, config: cfg(), flags: { obsCopied: true } });
  assert.deepEqual(ready.map((s) => s.done), [true, true, true]);
  const custom = defaultConfig();
  custom.presets[0].layout.size = 200;
  assert.equal(firstSteps({ status: null, config: custom, flags: {} })[1].done, true);
  assert.equal(firstSteps({ status: null, config: defaultConfig(), flags: { templatePicked: true } })[1].done, true);
});
