// Pure editor logic (no DOM): shared by editor.js in the browser and node tests.
import { demoVoice } from "../shared/model.js";

const opts = (pairs) => pairs.map(([value, label]) => ({ value, label }));

// Mirror of LAYOUT/STYLE in src/config.js (a test keeps them in sync).
export const FIELDS = {
  layout: {
    direction: { kind: "enum", def: "row", label: "Dirección", options: opts([["row", "Fila"], ["column", "Columna"], ["grid", "Grilla"]]) },
    columns: { kind: "int", def: 4, min: 1, max: 12, label: "Columnas (grilla)" },
    alignX: { kind: "enum", def: "left", label: "Alineación horizontal", options: opts([["left", "Izquierda"], ["center", "Centro"], ["right", "Derecha"]]) },
    alignY: { kind: "enum", def: "top", label: "Alineación vertical", options: opts([["top", "Arriba"], ["center", "Centro"], ["bottom", "Abajo"]]) },
    offsetX: { kind: "int", def: 0, min: -4000, max: 4000, label: "Desplazamiento X (px)" },
    offsetY: { kind: "int", def: 0, min: -4000, max: 4000, label: "Desplazamiento Y (px)" },
    gap: { kind: "int", def: 24, min: 0, max: 400, label: "Separación (px)" },
    padding: { kind: "int", def: 24, min: 0, max: 400, label: "Margen (px)" },
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
    idleDim: { kind: "num", def: 0.65, min: 0, max: 1, step: 0.05, label: "Brillo en silencio" },
    muteDim: { kind: "num", def: 0.45, min: 0, max: 1, step: 0.05, label: "Brillo muteado" },
    hideWhenSilent: { kind: "bool", def: false, label: "Ocultar si no habla" },
    showMuteIcon: { kind: "bool", def: true, label: "Ícono de mute" },
    offlineText: { kind: "str", def: "OFFLINE", min: 0, max: 24, label: "Texto offline" },
  },
};

export const PRESET_LABELS = {
  id: "ID",
  name: "Nombre",
  mode: "Modo",
  theme: "Tema",
  users: "Usuarios",
  showUnlisted: "Mostrar no listados",
};
export const USER_LABELS = {
  id: "ID de Discord",
  displayName: "Nombre",
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
  setup_required: ["Falta configurar la app de Discord: cargá el Application ID y el Client Secret.", "warn"],
  discord_closed: ["Discord no está abierto. Abrí la app de escritorio de Discord.", "bad"],
  connecting: ["Conectando con Discord…", "warn"],
  authorizing: ["Aceptá el pedido en Discord", "warn"],
  ready: ["Conectado a Discord", "ok"],
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
  return { id, name, mode: "reactive", theme: "pixel-cafe", users: [], showUnlisted: true, layout: fill("layout"), style: fill("style") };
}
