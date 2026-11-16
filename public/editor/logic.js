// Pure editor logic (no DOM): shared by editor.js in the browser and node tests.
import { demoVoice } from "../shared/model.js";

const opts = (pairs) => pairs.map(([value, label]) => ({ value, label }));

// Mirror of LAYOUT/STYLE in src/config.js (a test keeps them in sync).
export const FIELDS = {
  layout: {
    direction: { kind: "enum", def: "row", label: "Dirección", options: opts([["row", "Fila"], ["column", "Columna"], ["grid", "Grilla"]]) },
    columns: { kind: "int", def: 4, min: 1, max: 12, label: "Columnas (grilla)" },
    alignX: { kind: "enum", def: "left", label: "Posición horizontal", options: opts([["left", "Izquierda"], ["center", "Centro"], ["right", "Derecha"]]) },
    alignY: { kind: "enum", def: "top", label: "Posición vertical", options: opts([["top", "Arriba"], ["center", "Centro"], ["bottom", "Abajo"]]) },
    offsetX: { kind: "int", def: 0, min: -4000, max: 4000, label: "Correr a los costados (px)" },
    offsetY: { kind: "int", def: 0, min: -4000, max: 4000, label: "Correr arriba/abajo (px)" },
    gap: { kind: "int", def: 24, min: 0, max: 400, label: "Espacio entre imágenes (px)" },
    padding: { kind: "int", def: 24, min: 0, max: 400, label: "Distancia al borde (px)" },
    size: { kind: "int", def: 160, min: 32, max: 1024, label: "Tamaño (px)" },
  },
  style: {
    shape: { kind: "enum", def: "square", label: "Forma", options: opts([["square", "Cuadrada"], ["rounded", "Redondeada"], ["circle", "Círculo"]]) },
    frame: { kind: "bool", def: true, label: "Marco" },
    showNames: { kind: "bool", def: true, label: "Mostrar nombres" },
    showRoles: { kind: "bool", def: true, label: "Mostrar roles" },
    nameSize: { kind: "int", def: 22, min: 10, max: 96, label: "Tamaño del nombre (px)" },
    talkAnimation: { kind: "enum", def: "bounce", label: "Animación al hablar", options: opts([["bounce", "Rebote"], ["shake", "Temblor"], ["pulse", "Pulso"], ["none", "Ninguna"]]) },
    talkGlow: { kind: "bool", def: true, label: "Resaltar al hablar" },
    talkColor: { kind: "color", def: "#6fc2b0", label: "Color al hablar" },
    idleDim: { kind: "num", def: 0.65, min: 0, max: 1, step: 0.05, label: "Brillo cuando está callado" },
    muteDim: { kind: "num", def: 0.45, min: 0, max: 1, step: 0.05, label: "Brillo cuando está muteado" },
    hideWhenSilent: { kind: "bool", def: false, label: "Mostrar solo a quien habla" },
    showMuteIcon: { kind: "bool", def: true, label: "Ícono de muteado/sordo" },
    offlineText: { kind: "str", def: "OFFLINE", min: 0, max: 24, label: "Texto cuando no está" },
  },
};

// Mirror of CANVASES in src/config.js (a test keeps them in sync). First = default.
export const CANVASES = [
  { value: "1920x1080", label: "Full HD (1920×1080)", width: 1920, height: 1080 },
  { value: "2560x1440", label: "2K (2560×1440)", width: 2560, height: 1440 },
  { value: "1280x720", label: "HD (1280×720)", width: 1280, height: 720 },
  { value: "1080x1920", label: "Vertical (1080×1920)", width: 1080, height: 1920 },
];

// Mirror of THEMES in src/config.js (a test keeps them in sync). First = default.
// swatch: [background, accent] for the small colour sample next to the select.
export const THEMES = [
  { value: "pixel-cafe", label: "Pixel café", description: "Marco pixelado crema, como los overlays de Kosmik.", swatch: ["#24223f", "#f3e9d2"] },
  { value: "clean", label: "Limpio (neutro)", description: "Borde blanco fino y nombre en pastilla oscura.", swatch: ["#ffffff", "#2b2b2b"] },
  { value: "neon", label: "Neón", description: "Fondo oscuro con borde de neón del color al hablar; letras futuristas.", swatch: ["#0c0f1f", "#22e4ff"] },
  { value: "comic", label: "Cómic / sticker", description: "Recorte tipo sticker con borde blanco grueso, sombra dura y letra gruesa.", swatch: ["#ffd23f", "#ffffff"] },
  { value: "glass", label: "Glass / moderno", description: "Tarjeta translúcida tipo vidrio, esquinas suaves y nombre en pastilla.", swatch: ["#c8d4ff", "#ffffff"] },
];

export function canvasSize(value) {
  const c = CANVASES.find((x) => x.value === value) ?? CANVASES[0];
  return { width: c.width, height: c.height };
}

export const PRESET_LABELS = {
  id: "Nombre en la dirección (URL)",
  name: "Nombre",
  mode: "Tipo",
  theme: "Tema",
  canvas: "Lienzo de OBS",
  users: "Personas",
  showUnlisted: "Mostrar también a quienes no están en la lista",
};
export const USER_LABELS = {
  id: "ID de Discord",
  displayName: "Alias (cómo aparece en pantalla)",
  role: "Rol",
  roleColor: "Color del rol",
  images: "Imágenes",
  "images.idle": "Imagen normal",
  "images.talking": "Imagen hablando",
  "images.muted": "Imagen muteado",
  "images.deafened": "Imagen ensordecido",
};
export const SIM_STATES = opts([
  ["offline", "Offline"],
  ["idle", "Callado"],
  ["talking", "Hablando"],
  ["muted", "Muteado"],
  ["deafened", "Sordo"],
]);

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
  [/^must be one of (.+)$/, (m) => `tiene que ser uno de: ${m[1]}`],
  [/^must be an integer between (\S+) and (\S+)$/, (m) => `tiene que ser un entero entre ${m[1]} y ${m[2]}`],
  [/^must be a number between (\S+) and (\S+)$/, (m) => `tiene que ser un número entre ${m[1]} y ${m[2]}`],
  [/^must be true or false$/, () => "tiene que ser sí o no"],
  [/^must be a hex color like (\S+)$/, (m) => `tiene que ser un color hex como ${m[1]}`],
  [/^must be text of (\d+)-(\d+) characters$/, (m) => `tiene que tener entre ${m[1]} y ${m[2]} caracteres`],
  [/^must be text of at most (\d+) characters$/, (m) => `máximo ${m[1]} caracteres`],
  [/^is required$/, () => "es obligatorio"],
  [/^must be a Discord user id/, () => "tiene que ser un ID de usuario de Discord (17 a 20 dígitos)"],
  [/^must be a Discord application id/, () => "tiene que ser un Application ID de Discord (17 a 20 dígitos)"],
  [/^must be an uploaded image file name$/, () => "tiene que ser una imagen subida"],
  [/^must be lowercase letters/, () => "solo minúsculas, números o guiones (máx. 32)"],
  [/^must be a list of at most (\d+) user ids$/, (m) => `máximo ${m[1]} usuarios`],
  [/^unknown user id$/, () => "usuario desconocido"],
  [/^listed twice$/, () => "está repetido"],
  [/^duplicate user id$/, () => "ID de usuario repetido"],
  [/^duplicate preset id$/, () => "ID de preset repetido"],
  [/^at most (\d+) users$/, (m) => `máximo ${m[1]} usuarios`],
  [/^between (\d+) and (\d+) presets$/, (m) => `entre ${m[1]} y ${m[2]} presets`],
  [/^must be an object$/, () => "formato inválido"],
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
    summary.push({ path: e.path ?? "", message, target });
  }
  return { fields, summary };
}

export function describePath(p, config) {
  let m = /^presets\[(\d+)\](?:\.(.+))?$/.exec(p);
  if (m) {
    const preset = config?.presets?.[Number(m[1])];
    const head = `Preset «${preset?.name || preset?.id || Number(m[1]) + 1}»`;
    if (!m[2]) return head;
    const [group, key] = m[2].split(".");
    const label = FIELDS[group]?.[key]?.label ?? PRESET_LABELS[m[2].replace(/\[\d+\]$/, "")] ?? m[2];
    return `${head} › ${label}`;
  }
  m = /^users\[(\d+)\](?:\.(.+))?$/.exec(p);
  if (m) {
    const u = config?.users?.[Number(m[1])];
    const head = `Usuario «${u?.displayName || u?.id || Number(m[1]) + 1}»`;
    return m[2] ? `${head} › ${USER_LABELS[m[2]] ?? m[2]}` : head;
  }
  if (p === "presets") return "Presets";
  if (p === "users") return "Usuarios";
  if (p === "discord.clientId") return "Discord › Application ID";
  return p ? p : "Configuración";
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
  if (source === "live") return sim.live ?? { channel: null, members: [] };
  if (source === "rotate") return demoVoice(config, preset, Number(sim.tick) || 0);
  if (source === "static") return demoVoice(config, preset, "static");
  if (source === "all") {
    const v = demoVoice(config, preset, 0);
    return { ...v, members: v.members.map((m) => ({ ...m, speaking: true, muted: false, deafened: false })) };
  }
  const users = new Map((config?.users ?? []).map((u) => [u.id, u]));
  const members = [];
  orderedUserIds(config, preset).forEach((id, i) => {
    const state = sim?.states?.[id] ?? "idle";
    if (state === "offline") return;
    const name = users.get(id)?.displayName || `Usuario ${i + 1}`;
    members.push({
      id,
      name,
      avatarUrl: avatar(i, name),
      speaking: state === "talking",
      muted: state === "muted" || state === "deafened",
      deafened: state === "deafened",
    });
  });
  return { channel: { id: "sim", name: "Simulación", guildId: null }, members };
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
  copy.name = `${src.name} (copia)`.slice(0, 40);
  copy.id = uniquePresetId(`${src.id}-copia`, c.presets.map((p) => p.id));
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

const STATUS = {
  setup_required: ["Falta conectar Discord: pegá el Client ID y el Client Secret.", "warn"],
  discord_closed: ["Discord no está abierto. Abrí la app de escritorio de Discord.", "bad"],
  connecting: ["Conectando con Discord…", "warn"],
  authorizing: ["Aceptá el pedido en Discord", "warn"],
  ready: ["Conectado a Discord", "ok"],
  auth_failed: ["La autorización falló. Revisá el error, corregilo y tocá Guardar para reintentar.", "bad"],
  error: ["Error al hablar con Discord", "bad"],
};

export function statusText(status) {
  if (!status) return { text: "Sin conexión con Kosmik Voice (¿está corriendo la app?)", tone: "bad", detail: "" };
  const [text, tone] = STATUS[status.state] ?? [status.state, "warn"];
  return { text, tone, detail: status.message || "" };
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
  return { id, name, mode: "reactive", theme: "pixel-cafe", canvas: CANVASES[0].value, users: [], showUnlisted: true, layout: fill("layout"), style: fill("style") };
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
    key: "fila-abajo", name: "Fila abajo", canvas: "1920x1080",
    description: "Quienes estén en la llamada, en fila abajo al centro.",
    preset: { mode: "reactive", layout: { direction: "row", alignX: "center", alignY: "bottom", size: 150, gap: 28, padding: 40 }, style: {} },
  },
  {
    key: "columna", name: "Columna al costado", canvas: "1920x1080",
    description: "Una columna a la izquierda, centrada en altura.",
    preset: { mode: "reactive", layout: { direction: "column", alignX: "left", alignY: "center", size: 120, gap: 20, padding: 32 }, style: { nameSize: 20 } },
  },
  {
    key: "squad", name: "Squad en grilla", canvas: "1920x1080",
    description: "Un lugar fijo por persona en grilla de 4; si alguien no está, dice OFFLINE.",
    preset: { mode: "slots", layout: { direction: "grid", columns: 4, alignX: "center", alignY: "bottom", size: 150, gap: 28, padding: 40 }, style: {} },
  },
  {
    key: "pngtuber", name: "PNGtuber solo", canvas: "1920x1080", maxUsers: 1,
    description: "Solo vos, en grande abajo a la izquierda, sin nombre y con rebote al hablar.",
    preset: {
      mode: "slots",
      layout: { direction: "row", alignX: "left", alignY: "bottom", size: 420, gap: 0, padding: 24 },
      style: { showNames: false, showRoles: false, frame: false, talkGlow: false, talkAnimation: "bounce", idleDim: 0.85, offlineText: "" },
    },
  },
  {
    key: "solo-habla", name: "Solo quien habla", canvas: "1920x1080",
    description: "Aparece solo quien está hablando, grande abajo al centro.",
    preset: { mode: "reactive", layout: { direction: "row", alignX: "center", alignY: "bottom", size: 220, gap: 24, padding: 48 }, style: { hideWhenSilent: true, nameSize: 26 } },
  },
  {
    key: "burbujas", name: "Burbujas", canvas: "1920x1080",
    description: "Círculos chicos arriba a la derecha, estilo limpio, laten al hablar.",
    preset: {
      mode: "reactive", theme: "clean",
      layout: { direction: "row", alignX: "right", alignY: "top", size: 110, gap: 16, padding: 32 },
      style: { shape: "circle", talkAnimation: "pulse", nameSize: 18, showRoles: false },
    },
  },
  {
    key: "neon", name: "Neón abajo", canvas: "1920x1080",
    description: "Tema Neón: fila abajo al centro con borde que brilla al hablar.",
    preset: { mode: "reactive", theme: "neon", layout: { direction: "row", alignX: "center", alignY: "bottom", size: 150, gap: 32, padding: 48 }, style: { shape: "rounded", talkAnimation: "pulse", talkColor: "#22e4ff" } },
  },
  {
    key: "stickers", name: "Stickers", canvas: "1920x1080",
    description: "Tema Cómic: stickers con borde blanco, abajo a la izquierda, saltan al hablar.",
    preset: { mode: "reactive", theme: "comic", layout: { direction: "row", alignX: "left", alignY: "bottom", size: 160, gap: 36, padding: 48 }, style: { talkColor: "#ffd23f", nameSize: 22 } },
  },
  {
    key: "vidrio", name: "Tarjetas de vidrio", canvas: "1920x1080",
    description: "Tema Glass: tarjetas translúcidas en columna a la derecha.",
    preset: { mode: "reactive", theme: "glass", layout: { direction: "column", alignX: "right", alignY: "center", size: 120, gap: 44, padding: 40 }, style: { shape: "rounded", talkAnimation: "pulse", nameSize: 18 } },
  },
  {
    key: "vertical", name: "Vertical", canvas: "1080x1920", fixedCanvas: true,
    description: "Para streams verticales (TikTok, Shorts): fila abajo al centro.",
    preset: { mode: "reactive", layout: { direction: "row", alignX: "center", alignY: "bottom", size: 150, gap: 20, padding: 96 }, style: { nameSize: 22 } },
  },
  {
    key: "blank", name: "En blanco", canvas: "1920x1080",
    description: "Valores base para armarlo a tu gusto.",
    preset: {},
  },
];

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
const RETRY = "Volvé a esta pestaña y tocá «Guardar y conectar».";

/** Plain-language explanation of a Discord connection problem, or null when there is none. */
export function discordHelp(status) {
  if (!status) return null;
  const msg = String(status.message ?? "");
  if (/missing "?redirect_uri/i.test(msg)) {
    return {
      title: "Discord dice «Missing redirect_uri»: falta guardar el redirect",
      steps: [
        `Abrí tu aplicación en ${PORTAL}.`,
        "Entrá a OAuth2 y, en Redirects, tocá «Add Redirect».",
        "Escribí http://127.0.0.1",
        "Tocá «Save Changes» (la barra verde de abajo). Si no lo guardás, el error sigue.",
        RETRY,
      ],
    };
  }
  if (/timed out/i.test(msg)) {
    return {
      title: "Discord no respondió a tiempo",
      steps: [
        "Cerrá Discord del todo (también desde el ícono al lado del reloj) y abrilo de nuevo.",
        "Si aparece una ventana pidiendo autorización, aceptala.",
        RETRY,
      ],
    };
  }
  if (/invalid_client|client secret/i.test(msg)) {
    return {
      title: "El Client ID o el Client Secret no coinciden",
      steps: [`En ${PORTAL}, OAuth2: copiá de nuevo el Client ID y tocá «Reset Secret» para tener un secret nuevo.`, "Pegá los dos acá.", RETRY],
    };
  }
  if (status.state === "discord_closed") {
    return {
      title: "Discord no está abierto",
      steps: ["Abrí Discord de escritorio (no la versión del navegador) e iniciá sesión.", "Kosmik Voice se conecta solo cuando Discord está abierto."],
    };
  }
  if (status.state === "auth_failed") {
    return {
      title: "Discord no aceptó la autorización",
      steps: [
        "Si en Discord tocaste «Cancelar», reintentá y esta vez tocá «Autorizar».",
        "Revisá que el Client ID y el Client Secret sean de la misma aplicación.",
        RETRY,
      ],
    };
  }
  if (status.state === "error") {
    return { title: "Hubo un problema al hablar con Discord", steps: ["Cerrá y volvé a abrir Discord.", RETRY, "Si sigue, mirá el detalle técnico de abajo."] };
  }
  return null;
}

/** Checklist shown on top of the editor. flags: { templatePicked, obsCopied } (kept by the browser). */
export function firstSteps({ status, config, flags = {} }) {
  const presets = config?.presets ?? [];
  const customised = presets.length > 1 || presets.some((p) => isDirty(newPreset(p.id, p.name), { ...p, canvas: p.canvas ?? CANVASES[0].value }));
  return [
    { key: "discord", label: "Conectar Discord", hint: "Pegá los datos de tu aplicación de Discord.", tab: "discord", done: status?.state === "ready" },
    { key: "preset", label: "Elegir una plantilla", hint: "Elegí cómo se ve el overlay.", tab: "presets", done: Boolean(flags.templatePicked) || customised },
    { key: "obs", label: "Agregar a OBS", hint: "Copiá la dirección y pegala en OBS con el tamaño indicado.", tab: "presets", done: Boolean(flags.obsCopied) },
  ];
}

/** What to paste and type in OBS for a preset. */
export function obsSetup(preset, origin) {
  const { width, height } = canvasSize(preset?.canvas);
  const url = `${origin}/overlay/${encodeURIComponent(preset?.id ?? "")}`;
  return { url, width, height, text: `En OBS: Fuentes › + › Navegador. Pegá la dirección y poné Ancho ${width} y Alto ${height}.` };
}
