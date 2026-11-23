// Pure editor logic (no DOM): shared by editor.js in the browser and node tests.
import { demoVoice, boxLayout } from "../shared/model.js";
import { t, LANGUAGES } from "./i18n.js";

/** Define getters that translate on every read, so labels follow the current editor language. */
function translated(obj, keys) {
  for (const [prop, key] of Object.entries(keys)) Object.defineProperty(obj, prop, { get: () => t(key), enumerable: true });
  return obj;
}
const opts = (prefix, values) => values.map((value) => translated({ value }, { label: `${prefix}.${value}` }));
const spec = (group, name, props, values) => {
  const f = translated({ ...props }, { label: `field.${group}.${name}` });
  if (values) f.options = opts(`opt.${name}`, values);
  return f;
};

/** Initial editor language: a valid saved choice, else Spanish when the first browser language is es-*. */
export function pickLanguage(stored, browserLanguages) {
  if (LANGUAGES.includes(stored)) return stored;
  const first = String((browserLanguages ?? [])[0] ?? "").toLowerCase().split(/[-_]/)[0];
  return first === "es" ? "es" : "en";
}

// Mirror of LAYOUT/STYLE in src/config.js (a test keeps them in sync).
export const FIELDS = {
  layout: {
    direction: spec("layout", "direction", { kind: "enum", def: "row" }, ["row", "column", "grid"]),
    columns: spec("layout", "columns", { kind: "int", def: 4, min: 1, max: 12 }),
    alignX: spec("layout", "alignX", { kind: "enum", def: "left" }, ["left", "center", "right"]),
    alignY: spec("layout", "alignY", { kind: "enum", def: "top" }, ["top", "center", "bottom"]),
    offsetX: spec("layout", "offsetX", { kind: "int", def: 0, min: -4000, max: 4000 }),
    offsetY: spec("layout", "offsetY", { kind: "int", def: 0, min: -4000, max: 4000 }),
    gap: spec("layout", "gap", { kind: "int", def: 24, min: 0, max: 400 }),
    padding: spec("layout", "padding", { kind: "int", def: 24, min: 0, max: 400 }),
    size: spec("layout", "size", { kind: "int", def: 160, min: 32, max: 1024 }),
    placement: spec("layout", "placement", { kind: "enum", def: "canvas" }, ["canvas", "box"]),
    room: spec("layout", "room", { kind: "int", def: 4, min: 1, max: 25 }),
  },
  style: {
    shape: spec("style", "shape", { kind: "enum", def: "square" }, ["square", "rounded", "circle"]),
    frame: spec("style", "frame", { kind: "bool", def: true }),
    showNames: spec("style", "showNames", { kind: "bool", def: true }),
    showRoles: spec("style", "showRoles", { kind: "bool", def: true }),
    nameSize: spec("style", "nameSize", { kind: "int", def: 22, min: 10, max: 96 }),
    talkAnimation: spec("style", "talkAnimation", { kind: "enum", def: "bounce" }, ["bounce", "shake", "pulse", "none"]),
    talkGlow: spec("style", "talkGlow", { kind: "bool", def: true }),
    talkColor: spec("style", "talkColor", { kind: "color", def: "#6fc2b0" }),
    idleDim: spec("style", "idleDim", { kind: "num", def: 0.65, min: 0, max: 1, step: 0.05 }),
    muteDim: spec("style", "muteDim", { kind: "num", def: 0.45, min: 0, max: 1, step: 0.05 }),
    hideWhenSilent: spec("style", "hideWhenSilent", { kind: "bool", def: false }),
    showMuteIcon: spec("style", "showMuteIcon", { kind: "bool", def: true }),
    offlineText: spec("style", "offlineText", { kind: "str", def: "OFFLINE", min: 0, max: 24 }),
    frameColor: spec("style", "frameColor", { kind: "optcolor", def: "" }),
    boxColor: spec("style", "boxColor", { kind: "optcolor", def: "" }),
    nameColor: spec("style", "nameColor", { kind: "optcolor", def: "" }),
    nameBg: spec("style", "nameBg", { kind: "optcolor", def: "" }),
    nameBorder: spec("style", "nameBorder", { kind: "optcolor", def: "" }),
    accentColor: spec("style", "accentColor", { kind: "optcolor", def: "" }),
    nameStripe: spec("style", "nameStripe", { kind: "bool", def: true }),
  },
};

// Mirror of CANVASES in src/config.js (a test keeps them in sync). First = default.
export const CANVASES = [
  { value: "1920x1080", width: 1920, height: 1080 },
  { value: "2560x1440", width: 2560, height: 1440 },
  { value: "1280x720", width: 1280, height: 720 },
  { value: "1080x1920", width: 1080, height: 1920 },
].map((c) => translated(c, { label: `canvas.${c.value}` }));

// Mirror of THEMES in src/config.js (a test keeps them in sync). First = default.
// swatch: [background, accent] for the small colour sample next to the select.
export const THEMES = [
  { value: "pixel-cafe", swatch: ["#24223f", "#f3e9d2"] },
  { value: "clean", swatch: ["#ffffff", "#2b2b2b"] },
  { value: "neon", swatch: ["#0c0f1f", "#22e4ff"] },
  { value: "comic", swatch: ["#ffd23f", "#ffffff"] },
  { value: "glass", swatch: ["#c8d4ff", "#ffffff"] },
].map((x) => translated(x, { label: `theme.${x.value}.label`, description: `theme.${x.value}.description` }));

export function canvasSize(value) {
  const c = CANVASES.find((x) => x.value === value) ?? CANVASES[0];
  return { width: c.width, height: c.height };
}

const keyed = (prefix, names) => translated({}, Object.fromEntries(names.map((n) => [n, `${prefix}.${n}`])));
export const PRESET_LABELS = keyed("preset", ["id", "name", "mode", "theme", "canvas", "users", "showUnlisted"]);
export const USER_LABELS = keyed("user", ["id", "displayName", "role", "roleColor", "images", "images.idle", "images.talking", "images.muted", "images.deafened"]);
export const SIM_STATES = opts("sim", ["offline", "idle", "talking", "muted", "deafened"]);

export function slugify(name) {
  const slug = String(name ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  return slug || "preset";
}

export function uniquePresetId(name, taken) {
  const used = new Set(taken);
  const base = slugify(name);
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) {
    const suffix = `-${i}`;
    const candidate = base.slice(0, 32 - suffix.length).replace(/-+$/, "") + suffix;
    if (!used.has(candidate)) return candidate;
  }
}

const MESSAGES = [
  [/^must be one of (.+)$/, (m) => t("msg.oneOf", { list: m[1] })],
  [/^must be an integer between (\S+) and (\S+)$/, (m) => t("msg.int", { min: m[1], max: m[2] })],
  [/^must be a number between (\S+) and (\S+)$/, (m) => t("msg.num", { min: m[1], max: m[2] })],
  [/^must be true or false$/, () => t("msg.bool")],
  [/^must be a hex color like (\S+)$/, (m) => t("msg.hex", { example: m[1] })],
  [/^must be text of (\d+)-(\d+) characters$/, (m) => t("msg.textRange", { min: m[1], max: m[2] })],
  [/^must be text of at most (\d+) characters$/, (m) => t("msg.textMax", { max: m[1] })],
  [/^is required$/, () => t("msg.required")],
  [/^must be a Discord user id/, () => t("msg.userId")],
  [/^must be a Discord application id/, () => t("msg.appId")],
  [/^must be an uploaded image file name$/, () => t("msg.image")],
  [/^must be lowercase letters/, () => t("msg.slug")],
  [/^must be a list of at most (\d+) user ids$/, (m) => t("msg.maxUsers", { max: m[1] })],
  [/^unknown user id$/, () => t("msg.unknownUser")],
  [/^listed twice$/, () => t("msg.listedTwice")],
  [/^duplicate user id$/, () => t("msg.dupUser")],
  [/^duplicate preset id$/, () => t("msg.dupPreset")],
  [/^at most (\d+) users$/, (m) => t("msg.maxUsers", { max: m[1] })],
  [/^between (\d+) and (\d+) presets$/, (m) => t("msg.presetRange", { min: m[1], max: m[2] })],
  [/^must be an object$/, () => t("msg.object")],
];

export function translateMessage(message) {
  for (const [re, fn] of MESSAGES) {
    const m = re.exec(String(message));
    if (m) return fn(m);
  }
  return String(message);
}

function parentPath(p) {
  const m = /^(.*)(\.[^.[\]]+|\[\d+\])$/.exec(p);
  return m ? m[1] : "";
}

/**
 * Map server errors to editor fields. known = Set of data-path values present in the UI.
 * Returns { fields: {path: [messages]}, summary: [{path, message, target}] }.
 */
export function mapErrors(errors, known) {
  const fields = {};
  const summary = [];
  for (const e of errors ?? []) {
    const message = translateMessage(e.message);
    let target = null;
    for (let p = e.path ?? ""; p; p = parentPath(p)) {
      if (known.has(p)) {
        target = p;
        break;
      }
    }
    if (target) (fields[target] ??= []).push(message);
    // raw: the server message, so the editor can re-translate after a language switch.
    summary.push({ path: e.path ?? "", message, target, raw: e.message });
  }
  return { fields, summary };
}

export function describePath(p, config) {
  let m = /^presets\[(\d+)\](?:\.(.+))?$/.exec(p);
  if (m) {
    const preset = config?.presets?.[Number(m[1])];
    const head = t("path.preset", { name: preset?.name || preset?.id || Number(m[1]) + 1 });
    if (!m[2]) return head;
    const [group, key] = m[2].split(".");
    const label = FIELDS[group]?.[key]?.label ?? PRESET_LABELS[m[2].replace(/\[\d+\]$/, "")] ?? m[2];
    return `${head} › ${label}`;
  }
  m = /^users\[(\d+)\](?:\.(.+))?$/.exec(p);
  if (m) {
    const u = config?.users?.[Number(m[1])];
    const head = t("path.user", { name: u?.displayName || u?.id || Number(m[1]) + 1 });
    return m[2] ? `${head} › ${USER_LABELS[m[2]] ?? m[2]}` : head;
  }
  if (p === "presets") return t("path.presets");
  if (p === "users") return t("path.users");
  if (p === "discord.clientId") return t("path.clientId");
  return p ? p : t("path.config");
}

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export function isDirty(base, draft) {
  return canonical(base) !== canonical(draft);
}

const COLORS = ["#6fc2b0", "#e98a9b", "#ffcf8b", "#b79cff", "#7b4a6e", "#9a6a4f"];
function avatar(i, label) {
  const letter = (label || "?").trim().charAt(0).toUpperCase().replace(/[<>&"']/g, "") || "?";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges"><rect width="16" height="16" fill="${COLORS[i % COLORS.length]}"/><text x="8" y="12" font-family="Consolas,monospace" font-weight="700" font-size="10" text-anchor="middle" fill="#100f1c">${letter}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Ids of configured users in preview order: the preset's list first, then everyone else. */
function orderedUserIds(config, preset) {
  const all = (config?.users ?? []).map((u) => u.id);
  const listed = (preset?.users ?? []).filter((id) => all.includes(id));
  return [...listed, ...all.filter((id) => !listed.includes(id))];
}

/**
 * Voice snapshot for the preview.
 * sim.source: "live" (sim.live), "manual" (sim.states per user id), "all", "rotate" (sim.tick), "static".
 */
export function simulationVoice(config, preset, sim) {
  const source = sim?.source ?? "manual";
  const labels = { guest: (n) => t("ed.sim.guest", { n }), user: (n) => t("sim.user", { n }) };
  if (source === "live") return sim.live ?? { channel: null, members: [] };
  if (source === "rotate") return demoVoice(config, preset, Number(sim.tick) || 0, labels);
  if (source === "static") return demoVoice(config, preset, "static", labels);
  if (source === "all") {
    const v = demoVoice(config, preset, 0, labels);
    return { ...v, members: v.members.map((m) => ({ ...m, speaking: true, muted: false, deafened: false })) };
  }
  const users = new Map((config?.users ?? []).map((u) => [u.id, u]));
  const members = [];
  orderedUserIds(config, preset).forEach((id, i) => {
    const state = sim?.states?.[id] ?? "idle";
    if (state === "offline") return;
    const name = users.get(id)?.displayName || t("sim.user", { n: i + 1 });
    members.push({
      id,
      name,
      avatarUrl: avatar(i, name),
      speaking: state === "talking",
      muted: state === "muted" || state === "deafened",
      deafened: state === "deafened",
    });
  });
  return { channel: { id: "sim", name: t("sim.channel"), guildId: null }, members };
}

export function membersNotConfigured(voice, config) {
  const known = new Set((config?.users ?? []).map((u) => u.id));
  return (voice?.members ?? []).filter((m) => !known.has(m.id));
}

export function newUser(id = "", displayName = "") {
  return { id, displayName, role: "", roleColor: "", images: { idle: "", talking: "", muted: "", deafened: "" } };
}

export function removeUser(config, id) {
  const c = structuredClone(config);
  c.users = c.users.filter((u) => u.id !== id);
  for (const p of c.presets) p.users = p.users.filter((u) => u !== id);
  return c;
}

export function renameUserId(config, from, to) {
  const c = structuredClone(config);
  const u = c.users.find((x) => x.id === from);
  if (u) u.id = to;
  for (const p of c.presets) p.users = p.users.map((x) => (x === from ? to : x));
  return c;
}

export function duplicatePreset(config, index) {
  const c = structuredClone(config);
  const src = c.presets[index];
  const copy = structuredClone(src);
  copy.name = t("preset.copyName", { name: src.name }).slice(0, 40);
  copy.id = uniquePresetId(t("preset.copyId", { id: src.id }), c.presets.map((p) => p.id));
  c.presets.splice(index + 1, 0, copy);
  return c;
}

export function deletePreset(config, index) {
  const c = structuredClone(config);
  if (c.presets.length > 1) c.presets.splice(index, 1);
  return c;
}

export function moveItem(list, index, delta) {
  const out = [...list];
  const to = index + delta;
  if (to < 0 || to >= out.length || index < 0 || index >= out.length) return out;
  [out[index], out[to]] = [out[to], out[index]];
  return out;
}

export function assetUsers(config, name) {
  return (config?.users ?? []).filter((u) => Object.values(u.images ?? {}).includes(name)).map((u) => u.displayName || u.id);
}

const STATUS_TONE = { setup_required: "warn", discord_closed: "bad", connecting: "warn", authorizing: "warn", ready: "ok", auth_failed: "bad", error: "bad" };

export function statusText(status) {
  if (!status) return { text: t("status.none"), tone: "bad", detail: "" };
  const known = Object.hasOwn(STATUS_TONE, status.state);
  return { text: known ? t(`status.${status.state}`) : status.state, tone: known ? STATUS_TONE[status.state] : "warn", detail: status.message || "" };
}

function splitPath(p) {
  return String(p)
    .split(/\.|\[(\d+)\]/)
    .filter((s) => s !== undefined && s !== "")
    .map((s) => (/^\d+$/.test(s) ? Number(s) : s));
}

export function getAt(obj, p) {
  let cur = obj;
  for (const k of splitPath(p)) {
    if (cur == null) return undefined;
    cur = cur[k];
  }
  return cur;
}

export function setAt(obj, p, value) {
  const keys = splitPath(p);
  let cur = obj;
  for (const k of keys.slice(0, -1)) cur = cur[k];
  cur[keys.at(-1)] = value;
}

/** Every path the editor renders as a field (data-path); errors map onto these. */
export function knownPaths(config) {
  const out = new Set(["discord.clientId", "users", "presets"]);
  (config?.users ?? []).forEach((_, i) => {
    for (const k of Object.keys(USER_LABELS)) out.add(`users[${i}].${k}`);
    out.add(`users[${i}]`);
  });
  (config?.presets ?? []).forEach((_, i) => {
    out.add(`presets[${i}]`);
    for (const k of Object.keys(PRESET_LABELS)) out.add(`presets[${i}].${k}`);
    for (const g of ["layout", "style"]) {
      out.add(`presets[${i}].${g}`);
      for (const k of Object.keys(FIELDS[g])) out.add(`presets[${i}].${g}.${k}`);
    }
  });
  return out;
}

/** Same shape as defaultPreset() in src/config.js, built from FIELDS (src/ is not served). */
export function newPreset(id, name) {
  const fill = (g) => Object.fromEntries(Object.entries(FIELDS[g]).map(([k, f]) => [k, f.def]));
  return { id, name, mode: "reactive", theme: "clean", canvas: CANVASES[0].value, users: [], showUnlisted: true, layout: fill("layout"), style: fill("style") };
}

// ---------------------------------------------------------------- templates (S12)

export const LIMIT_PRESETS = 20;
const LIMIT_USERS = 50;
const LIMIT_PRESET_USERS = 25;
const USER_ID = /^\d{17,20}$/;

/**
 * Ready-made presets. Pixel sizes are designed for `canvas` and scaled when the preset is created
 * for another canvas (2K = x4/3). fixedCanvas templates keep their own canvas. maxUsers caps slots.
 */
export const TEMPLATES = [
  {
    key: "fila-abajo", canvas: "1920x1080",
    preset: { mode: "reactive", layout: { direction: "row", alignX: "center", alignY: "bottom", size: 150, gap: 28, padding: 40 }, style: {} },
  },
  {
    key: "columna", canvas: "1920x1080",
    preset: { mode: "reactive", layout: { direction: "column", alignX: "left", alignY: "center", size: 120, gap: 20, padding: 32 }, style: { nameSize: 20 } },
  },
  {
    key: "squad", canvas: "1920x1080",
    preset: { mode: "slots", layout: { direction: "grid", columns: 4, alignX: "center", alignY: "bottom", size: 150, gap: 28, padding: 40 }, style: {} },
  },
  {
    key: "pngtuber", canvas: "1920x1080", maxUsers: 1,
    preset: {
      mode: "slots",
      layout: { direction: "row", alignX: "left", alignY: "bottom", size: 420, gap: 0, padding: 24 },
      style: { showNames: false, showRoles: false, frame: false, talkGlow: false, talkAnimation: "bounce", idleDim: 0.85, offlineText: "" },
    },
  },
  {
    key: "solo-habla", canvas: "1920x1080",
    preset: { mode: "reactive", layout: { direction: "row", alignX: "center", alignY: "bottom", size: 220, gap: 24, padding: 48 }, style: { hideWhenSilent: true, nameSize: 26 } },
  },
  {
    key: "burbujas", canvas: "1920x1080",
    preset: {
      mode: "reactive", theme: "clean",
      layout: { direction: "row", alignX: "right", alignY: "top", size: 110, gap: 16, padding: 32 },
      style: { shape: "circle", talkAnimation: "pulse", nameSize: 18, showRoles: false },
    },
  },
  {
    key: "neon", canvas: "1920x1080",
    preset: { mode: "reactive", theme: "neon", layout: { direction: "row", alignX: "center", alignY: "bottom", size: 150, gap: 32, padding: 48 }, style: { shape: "rounded", talkAnimation: "pulse", talkColor: "#22e4ff" } },
  },
  {
    key: "stickers", canvas: "1920x1080",
    preset: { mode: "reactive", theme: "comic", layout: { direction: "row", alignX: "left", alignY: "bottom", size: 160, gap: 36, padding: 48 }, style: { talkColor: "#ffd23f", nameSize: 22 } },
  },
  {
    key: "vidrio", canvas: "1920x1080",
    preset: { mode: "reactive", theme: "glass", layout: { direction: "column", alignX: "right", alignY: "center", size: 120, gap: 44, padding: 40 }, style: { shape: "rounded", talkAnimation: "pulse", nameSize: 18 } },
  },
  {
    key: "vertical", canvas: "1080x1920", fixedCanvas: true,
    preset: { mode: "reactive", layout: { direction: "row", alignX: "center", alignY: "bottom", size: 150, gap: 20, padding: 96 }, style: { nameSize: 22 } },
  },
  {
    key: "blank", canvas: "1920x1080",
    preset: {},
  },
].map((tpl) => translated(tpl, { name: `tpl.${tpl.key}.name`, description: `tpl.${tpl.key}.description` }));

const SCALED = { layout: ["size", "gap", "padding", "offsetX", "offsetY"], style: ["nameSize"] };

function scaleFactor(from, to) {
  const a = canvasSize(from);
  const b = canvasSize(to);
  return Math.min(b.width / a.width, b.height / a.height);
}

/**
 * Append a preset built from a template. Never mutates config.
 * Returns { config, index, needsUsers } or { error: "limit" | "unknown" }.
 */
export function presetFromTemplate(config, key, { canvas } = {}) {
  const tpl = TEMPLATES.find((x) => x.key === key);
  if (!tpl) return { error: "unknown" };
  if ((config?.presets?.length ?? 0) >= LIMIT_PRESETS) return { error: "limit" };
  const c = structuredClone(config);
  const target = tpl.fixedCanvas || !CANVASES.some((x) => x.value === canvas) ? tpl.canvas : canvas;
  const p = newPreset(uniquePresetId(tpl.name, c.presets.map((x) => x.id)), tpl.name);
  const src = tpl.preset;
  if (src.mode) p.mode = src.mode;
  if (src.theme) p.theme = src.theme;
  p.canvas = target;
  Object.assign(p.layout, src.layout);
  Object.assign(p.style, src.style);
  const f = scaleFactor(tpl.canvas, target);
  if (f !== 1) {
    for (const [group, keys] of Object.entries(SCALED)) {
      for (const k of keys) {
        const spec = FIELDS[group][k];
        p[group][k] = Math.max(spec.min, Math.min(spec.max, Math.round(p[group][k] * f)));
      }
    }
  }
  if (p.mode === "slots") {
    p.users = c.users.map((u) => u.id).filter((id) => USER_ID.test(id ?? "")).slice(0, tpl.maxUsers ?? LIMIT_PRESET_USERS);
  }
  c.presets.push(p);
  return { config: c, index: c.presets.length - 1, needsUsers: p.mode === "slots" && p.users.length === 0 };
}

// ---------------------------------------------------------------- aliases (S13)

/** Live call members with their Discord name and the alias configured for them (if any). */
export function callMembers(voice, config) {
  const users = new Map((config?.users ?? []).map((u) => [u.id, u]));
  return (voice?.members ?? []).map((m) => ({
    id: m.id,
    discordName: String(m.name ?? ""),
    avatarUrl: m.avatarUrl || "",
    alias: users.get(m.id)?.displayName ?? "",
    configured: users.has(m.id),
    speaking: Boolean(m.speaking),
  }));
}

/**
 * Set the on-screen alias of a call member. Creates the user (no images) when it is new and the
 * alias is not empty; an empty alias falls back to the Discord name. Never mutates config.
 */
export function setAlias(config, member, alias) {
  const c = structuredClone(config);
  const value = String(alias ?? "").slice(0, 40);
  const u = c.users.find((x) => x.id === member?.id);
  if (u) u.displayName = value;
  else if (value.trim() && USER_ID.test(member?.id ?? "") && c.users.length < LIMIT_USERS) c.users.push(newUser(member.id, value));
  return c;
}

// ---------------------------------------------------------------- guidance (S10)

const PORTAL = "discord.com/developers/applications";

/** Plain-language explanation of a Discord connection problem, or null when there is none. */
export function discordHelp(status) {
  if (!status) return null;
  const RETRY = t("help.retry");
  const msg = String(status.message ?? "");
  if (/missing "?redirect_uri/i.test(msg)) {
    return {
      title: t("help.redirect.title"),
      steps: [t("help.redirect.1", { portal: PORTAL }), t("help.redirect.2"), t("help.redirect.3"), t("help.redirect.4"), RETRY],
    };
  }
  if (/timed out/i.test(msg)) {
    return { title: t("help.timeout.title"), steps: [t("help.timeout.1"), t("help.timeout.2"), RETRY] };
  }
  if (/invalid_client|client secret/i.test(msg)) {
    return { title: t("help.client.title"), steps: [t("help.client.1", { portal: PORTAL }), t("help.client.2"), RETRY] };
  }
  if (status.state === "discord_closed") {
    return { title: t("help.closed.title"), steps: [t("help.closed.1"), t("help.closed.2")] };
  }
  if (status.state === "auth_failed") {
    return { title: t("help.auth.title"), steps: [t("help.auth.1"), t("help.auth.2"), RETRY] };
  }
  if (status.state === "error") {
    return { title: t("help.error.title"), steps: [t("help.error.1"), RETRY, t("help.error.3")] };
  }
  return null;
}

/** Checklist shown on top of the editor. flags: { templatePicked, obsCopied } (kept by the browser). */
export function firstSteps({ status, config, flags = {} }) {
  const presets = config?.presets ?? [];
  const customised = presets.length > 1 || presets.some((p) => isDirty(newPreset(p.id, p.name), { ...p, canvas: p.canvas ?? CANVASES[0].value }));
  return [
    { key: "discord", label: t("step.discord.label"), hint: t("step.discord.hint"), tab: "discord", done: status?.state === "ready" },
    { key: "preset", label: t("step.preset.label"), hint: t("step.preset.hint"), tab: "presets", done: Boolean(flags.templatePicked) || customised },
    { key: "obs", label: t("step.obs.label"), hint: t("step.obs.hint"), tab: "presets", done: Boolean(flags.obsCopied) },
  ];
}

/** What to paste and type in OBS for a preset. */
/** Browser source address and size. Box placement: sized for its people; otherwise the preset's canvas. */
export function obsSetup(preset, origin, config) {
  const box = preset?.layout?.placement === "box";
  const { width, height } = box ? boxLayout(config, preset) : canvasSize(preset?.canvas);
  const url = `${origin}/overlay/${encodeURIComponent(preset?.id ?? "")}`;
  return { url, width, height, box, text: t(box ? "obs.textBox" : "obs.text", { width, height }) };
}
