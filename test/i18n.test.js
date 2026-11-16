import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CATALOG, LANGUAGES, t, parts, getLanguage, setLanguage } from "../public/editor/i18n.js";
import {
  pickLanguage, describePath, USER_LABELS, PRESET_LABELS, FIELDS, THEMES, TEMPLATES, SIM_STATES, CANVASES,
  statusText, translateMessage, discordHelp, firstSteps, obsSetup, isDirty,
} from "../public/editor/logic.js";
import { defaultConfig } from "../src/config.js";

function inLanguage(lang, fn) {
  const before = getLanguage();
  setLanguage(lang);
  try {
    return fn();
  } finally {
    setLanguage(before);
  }
}

const cfg = () => {
  const c = defaultConfig();
  c.users = [{ id: "111111111111111111", displayName: "Kosmik", role: "", roleColor: "", images: { idle: "", talking: "", muted: "", deafened: "" } }];
  return c;
};

test("pickLanguage: a valid stored choice wins over the browser", () => {
  assert.equal(pickLanguage("en", ["es-AR"]), "en");
  assert.equal(pickLanguage("es", ["en-US"]), "es");
});

test("pickLanguage: invalid stored values are ignored", () => {
  for (const bad of [null, undefined, "", "fr", "EN ", "{}", 1]) {
    assert.equal(pickLanguage(bad, ["es-AR"]), "es", String(bad));
    assert.equal(pickLanguage(bad, ["en-US"]), "en", String(bad));
  }
});

test("pickLanguage follows the first browser language: es-* -> es, anything else -> en", () => {
  assert.equal(pickLanguage(null, ["es-AR"]), "es");
  assert.equal(pickLanguage(null, ["es"]), "es");
  assert.equal(pickLanguage(null, ["ES-mx", "en"]), "es");
  assert.equal(pickLanguage(null, ["en-US", "es"]), "en");
  assert.equal(pickLanguage(null, ["pt-BR"]), "en");
  assert.equal(pickLanguage(null, ["eses"]), "en");
  assert.equal(pickLanguage(null, []), "en");
  assert.equal(pickLanguage(null, undefined), "en");
  assert.equal(pickLanguage(null, [undefined]), "en");
});

test("es and en catalogs have identical keys, no empty values and the same {params}", () => {
  assert.deepEqual(LANGUAGES, ["es", "en"]);
  const es = Object.keys(CATALOG.es).sort();
  const en = Object.keys(CATALOG.en).sort();
  assert.deepEqual(en, es);
  const params = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const k of es) {
    for (const lang of LANGUAGES) assert.ok(typeof CATALOG[lang][k] === "string" && CATALOG[lang][k].trim(), `${lang} ${k}`);
    assert.deepEqual(params(CATALOG.en[k]), params(CATALOG.es[k]), k);
  }
});

test("t interpolates params, falls back to es and then to the key", () => {
  inLanguage("en", () => {
    assert.equal(t("path.user", { name: "Lu" }), "User “Lu”");
    CATALOG.es.__only_es = "solo {x}";
    try {
      assert.equal(t("__only_es", { x: "es" }), "solo es");
    } finally {
      delete CATALOG.es.__only_es;
    }
    assert.equal(t("__nope__"), "__nope__");
  });
  assert.equal(t("path.user", { name: "Lu" }), "Usuario «Lu»");
});

test("parts keeps non-string params (DOM nodes) in place", () => {
  const node = { tag: "strong" };
  const out = inLanguage("en", () => parts("ed.discord.step4", { clientId: node }));
  assert.deepEqual(out, ["Copy the ", node, " and paste it below."]);
});

test("setLanguage ignores unknown languages; default is Spanish", () => {
  assert.equal(getLanguage(), "es");
  setLanguage("fr");
  assert.equal(getLanguage(), "es");
});

test("English mode: labels, paths, statuses and messages switch to English", () => {
  inLanguage("en", () => {
    assert.equal(USER_LABELS.displayName, "Alias (on-screen name)");
    assert.equal(describePath("users[0].displayName", cfg()), "User “Kosmik” › Alias (on-screen name)");
    assert.equal(describePath("presets[0].layout.size", cfg()), "Preset “Principal” › Size (px)");
    assert.equal(describePath("", cfg()), "Settings");
    assert.equal(PRESET_LABELS.canvas, "OBS canvas");
    assert.equal(FIELDS.layout.direction.label, "Direction");
    assert.equal(FIELDS.layout.direction.options.find((o) => o.value === "grid").label, "Grid");
    assert.equal(THEMES.find((x) => x.value === "neon").label, "Neon");
    assert.equal(TEMPLATES.find((x) => x.key === "blank").name, "Blank");
    assert.equal(SIM_STATES.find((s) => s.value === "idle").label, "Silent");
    assert.equal(statusText({ state: "ready" }).text, "Connected to Discord");
    assert.equal(statusText(null).text, "No connection to Kosmik Voice (is the app running?)");
    assert.equal(translateMessage("must be an integer between 32 and 1024"), "must be a whole number between 32 and 1024");
    assert.equal(translateMessage("something new"), "something new");
    assert.equal(discordHelp({ state: "discord_closed" }).title, "Discord isn't open");
    assert.equal(firstSteps({ status: null, config: defaultConfig() })[0].label, "Connect Discord");
    assert.match(obsSetup({ canvas: "2560x1440", id: "x" }, "").text, /Width 2560.*Height 1440/);
    assert.ok(CANVASES.every((c) => c.label));
  });
  // Back in Spanish, the same objects read Spanish again.
  assert.equal(USER_LABELS.displayName, "Alias (cómo aparece en pantalla)");
  assert.equal(THEMES.find((x) => x.value === "neon").label, "Neón");
});

test("switching language never changes config data or dirty state", () => {
  const base = cfg();
  const draft = structuredClone(base);
  inLanguage("en", () => assert.equal(isDirty(base, draft), false));
  assert.deepEqual(draft, base);
});

test("editor.js and logic.js have no hard-coded Spanish text left (accents/¿¡ outside comments)", () => {
  for (const f of ["public/editor/editor.js", "public/editor/logic.js"]) {
    const code = readFileSync(new URL(`../${f}`, import.meta.url), "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\/\*\*?|\*)/.test(l))
      .map((l) => l.replace(/\s\/\/ .*$/, ""))
      .join("\n");
    const hits = code.split("\n").filter((l) => /[áéíóúñÁÉÍÓÚÑ¿¡]/.test(l));
    assert.deepEqual(hits, [], f);
  }
});
