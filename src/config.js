// Config schema, validation and atomic persistence.
// The validator is hand-rolled on purpose: no dependency, every error carries a path
// the editor can show next to the offending field.
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";

export const LIMITS = { users: 50, presets: 20, presetUsers: 25 };
export const IMAGE_STATES = ["idle", "talking", "muted", "deafened"];
export const IMAGE_NAME = /^[a-z0-9][a-z0-9._-]{0,79}\.(png|gif|webp|jpe?g)$/i;

const USER_ID = /^\d{17,20}$/;
const PRESET_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const COLOR = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;

// Each field: [kind, default, ...constraint]. Defaults double as documentation.
const LAYOUT = {
  direction: ["enum", "row", ["row", "column", "grid"]],
  columns: ["int", 4, 1, 12],
  alignX: ["enum", "left", ["left", "center", "right"]],
  alignY: ["enum", "top", ["top", "center", "bottom"]],
  offsetX: ["int", 0, -4000, 4000],
  offsetY: ["int", 0, -4000, 4000],
  gap: ["int", 24, 0, 400],
  padding: ["int", 24, 0, 400],
  size: ["int", 160, 32, 1024],
};

const STYLE = {
  shape: ["enum", "square", ["square", "rounded", "circle"]],
  frame: ["bool", true],
  showNames: ["bool", true],
  showRoles: ["bool", true],
  nameSize: ["int", 22, 10, 96],
  talkAnimation: ["enum", "bounce", ["bounce", "shake", "pulse", "none"]],
  talkGlow: ["bool", true],
  talkColor: ["color", "#6fc2b0"],
  idleDim: ["num", 0.65, 0, 1],
  muteDim: ["num", 0.45, 0, 1],
  hideWhenSilent: ["bool", false],
  showMuteIcon: ["bool", true],
  offlineText: ["str", "OFFLINE", 0, 24],
};

export function defaultPreset(id = "main", name = "Principal") {
  return {
    id,
    name,
    mode: "reactive",
    theme: "pixel-cafe",
    users: [],
    showUnlisted: true,
    layout: fill(LAYOUT, {}),
    style: fill(STYLE, {}),
  };
}

export function defaultConfig() {
  return { version: 1, discord: { clientId: "" }, users: [], presets: [defaultPreset()] };
}

function fill(schema, input) {
  const out = {};
  for (const [key, [, def]] of Object.entries(schema)) out[key] = input?.[key] ?? def;
  return out;
}

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function checkField(errors, p, value, [kind, , a, b]) {
  const fail = (message) => errors.push({ path: p, message });
  switch (kind) {
    case "enum":
      if (!a.includes(value)) fail(`must be one of ${a.join(", ")}`);
      break;
    case "int":
      if (!Number.isInteger(value) || value < a || value > b) fail(`must be an integer between ${a} and ${b}`);
      break;
    case "num":
      if (typeof value !== "number" || !Number.isFinite(value) || value < a || value > b) fail(`must be a number between ${a} and ${b}`);
      break;
    case "bool":
      if (typeof value !== "boolean") fail("must be true or false");
      break;
    case "color":
      if (typeof value !== "string" || !COLOR.test(value)) fail("must be a hex color like #6fc2b0");
      break;
    case "str":
      if (typeof value !== "string" || value.length < a || value.length > b) fail(`must be text of ${a}-${b} characters`);
      break;
  }
}

function checkGroup(errors, p, input, schema) {
  if (input !== undefined && !isObject(input)) {
    errors.push({ path: p, message: "must be an object" });
    return fill(schema, {});
  }
  const value = fill(schema, input);
  for (const [key, spec] of Object.entries(schema)) checkField(errors, `${p}.${key}`, value[key], spec);
  return value;
}

function checkText(errors, p, value, max, { required = false } = {}) {
  if (value === undefined || value === "") {
    if (required) errors.push({ path: p, message: "is required" });
    return "";
  }
  if (typeof value !== "string" || value.length > max) {
    errors.push({ path: p, message: `must be text of at most ${max} characters` });
  }
  return value;
}

function checkUser(errors, p, u) {
  if (!isObject(u)) {
    errors.push({ path: p, message: "must be an object" });
    return null;
  }
  if (typeof u.id !== "string" || !USER_ID.test(u.id)) errors.push({ path: `${p}.id`, message: "must be a Discord user id (17-20 digits)" });
  const images = {};
  const rawImages = isObject(u.images) ? u.images : {};
  if (u.images !== undefined && !isObject(u.images)) errors.push({ path: `${p}.images`, message: "must be an object" });
  for (const state of IMAGE_STATES) {
    const name = rawImages[state] ?? "";
    if (name !== "" && (typeof name !== "string" || !IMAGE_NAME.test(name))) {
      errors.push({ path: `${p}.images.${state}`, message: "must be an uploaded image file name" });
    }
    images[state] = name;
  }
  const roleColor = u.roleColor ?? "";
  if (roleColor !== "" && (typeof roleColor !== "string" || !COLOR.test(roleColor))) {
    errors.push({ path: `${p}.roleColor`, message: "must be a hex color like #6fc2b0" });
  }
  return {
    id: u.id,
    displayName: checkText(errors, `${p}.displayName`, u.displayName, 40),
    role: checkText(errors, `${p}.role`, u.role, 24),
    roleColor,
    images,
  };
}

function checkPreset(errors, p, input, userIds) {
  if (!isObject(input)) {
    errors.push({ path: p, message: "must be an object" });
    return null;
  }
  const def = defaultPreset(input.id, input.name);
  if (typeof input.id !== "string" || !PRESET_ID.test(input.id)) {
    errors.push({ path: `${p}.id`, message: "must be lowercase letters, digits or dashes (max 32)" });
  }
  const preset = {
    id: input.id,
    name: checkText(errors, `${p}.name`, input.name, 40, { required: true }),
    mode: input.mode ?? def.mode,
    theme: input.theme ?? def.theme,
    users: [],
    showUnlisted: input.showUnlisted ?? def.showUnlisted,
    layout: checkGroup(errors, `${p}.layout`, input.layout, LAYOUT),
    style: checkGroup(errors, `${p}.style`, input.style, STYLE),
  };
  checkField(errors, `${p}.mode`, preset.mode, ["enum", null, ["reactive", "slots"]]);
  checkField(errors, `${p}.theme`, preset.theme, ["enum", null, ["pixel-cafe", "clean"]]);
  checkField(errors, `${p}.showUnlisted`, preset.showUnlisted, ["bool"]);
  const users = input.users ?? [];
  if (!Array.isArray(users) || users.length > LIMITS.presetUsers) {
    errors.push({ path: `${p}.users`, message: `must be a list of at most ${LIMITS.presetUsers} user ids` });
  } else {
    users.forEach((id, i) => {
      if (!userIds.has(id)) errors.push({ path: `${p}.users[${i}]`, message: "unknown user id" });
      else if (preset.users.includes(id)) errors.push({ path: `${p}.users[${i}]`, message: "listed twice" });
      else preset.users.push(id);
    });
  }
  return preset;
}

/** Validate and normalize a config. Never throws; returns { ok, errors, value }. */
export function validateConfig(input) {
  const errors = [];
  if (!isObject(input)) return { ok: false, errors: [{ path: "", message: "config must be an object" }], value: null };
  if (!Array.isArray(input.users) || !Array.isArray(input.presets)) {
    return { ok: false, errors: [{ path: "", message: "config needs users and presets lists" }], value: null };
  }
  if (input.users.length > LIMITS.users) errors.push({ path: "users", message: `at most ${LIMITS.users} users` });
  if (input.presets.length < 1 || input.presets.length > LIMITS.presets) {
    errors.push({ path: "presets", message: `between 1 and ${LIMITS.presets} presets` });
  }
  const clientId = input.discord?.clientId ?? "";
  if (clientId !== "" && (typeof clientId !== "string" || !USER_ID.test(clientId))) {
    errors.push({ path: "discord.clientId", message: "must be a Discord application id (17-20 digits)" });
  }

  const seenUsers = new Set();
  const users = input.users.map((u, i) => {
    const user = checkUser(errors, `users[${i}]`, u);
    if (user && USER_ID.test(user.id ?? "")) {
      if (seenUsers.has(user.id)) errors.push({ path: `users[${i}].id`, message: "duplicate user id" });
      seenUsers.add(user.id);
    }
    return user;
  });

  const seenPresets = new Set();
  const presets = input.presets.map((pr, i) => {
    const preset = checkPreset(errors, `presets[${i}]`, pr, seenUsers);
    if (preset && typeof preset.id === "string") {
      if (seenPresets.has(preset.id)) errors.push({ path: `presets[${i}].id`, message: "duplicate preset id" });
      seenPresets.add(preset.id);
    }
    return preset;
  });

  const value = { version: 1, discord: { clientId }, users, presets };
  return { ok: errors.length === 0, errors, value: errors.length === 0 ? value : null };
}

export class InvalidConfigError extends Error {
  constructor(errors) {
    super(`invalid config: ${errors.map((e) => `${e.path} ${e.message}`).join("; ")}`);
    this.code = "INVALID_CONFIG";
    this.errors = errors;
  }
}

/** Loads and saves data/config.json. Invalid input never reaches disk. */
export class ConfigStore {
  constructor(dataDir) {
    this.dir = dataDir;
    this.file = path.join(dataDir, "config.json");
    this.current = null;
  }

  async load() {
    await mkdir(this.dir, { recursive: true });
    let raw;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      return this.save(defaultConfig());
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    const result = validateConfig(parsed);
    if (!result.ok) {
      // Keep the user's file for manual recovery instead of overwriting it silently.
      await rename(this.file, path.join(this.dir, `config.broken-${Date.now()}.json`));
      return this.save(defaultConfig());
    }
    this.current = result.value;
    return this.current;
  }

  async save(input) {
    const result = validateConfig(input);
    if (!result.ok) throw new InvalidConfigError(result.errors);
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(result.value, null, 2) + "\n");
    await rename(tmp, this.file);
    this.current = result.value;
    return this.current;
  }
}
