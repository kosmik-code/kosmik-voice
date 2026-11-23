// Kosmik Voice editor. Draft-based: every edit changes S.draft, the preview iframe gets the draft
// immediately, "Guardar" PUTs the whole config. User text is always rendered with textContent.
import {
  FIELDS, PRESET_LABELS, USER_LABELS, SIM_STATES, uniquePresetId, mapErrors, describePath, isDirty, simulationVoice,
  newUser, removeUser, renameUserId, duplicatePreset, deletePreset, moveItem, assetUsers,
  statusText, getAt, setAt, knownPaths, newPreset, CANVASES, canvasSize, TEMPLATES, LIMIT_PRESETS, presetFromTemplate,
  callMembers, setAlias, discordHelp, firstSteps, obsSetup, THEMES, pickLanguage,
} from "/editor/logic.js";
import { t, parts, getLanguage, setLanguage } from "/editor/i18n.js";

const $ = (sel, root = document) => root.querySelector(sel);
const TABS = ["discord", "users", "presets"];
// Image slots per user; labels come from the sim.* strings (Callado, Hablando, ...).
const IMAGE_SLOTS = ["idle", "talking", "muted", "deafened"];
const LANG_KEY = "kv-editor-lang";
// Preset fields shown up front; everything else lives under "Ajustes avanzados".
const BASIC = { layout: ["alignX", "alignY", "size"], style: ["showNames", "talkAnimation"] };
// Advanced style fields grouped under "Colores del tema" instead of the generic style grid.
const THEME_COLOR_FIELDS = ["talkColor", "frameColor", "boxColor", "nameColor", "nameBg", "nameBorder", "accentColor", "nameStripe"];
const FLAGS_KEY = "kv.firstSteps";

const S = {
  base: null,
  draft: null,
  remote: null, // config saved elsewhere while we had unsaved changes
  assets: [],
  voice: { channel: null, members: [] },
  status: null,
  discord: null,
  tab: "discord",
  presetIdx: 0,
  errors: { fields: {}, summary: [] },
  sim: { source: "sim", mode: "static", states: {}, tick: 0 },
  canvasOverride: null, // preview-only canvas; null = the preset's own canvas
  advancedOpen: false,
  galleryCanvas: CANVASES[0].value,
  flags: loadFlags(), // { hidden, templatePicked, obsCopied } kept in this browser
  libraryMsg: null, // { key, params } so it follows the language
  discordMsg: null, // { tone, key }
  update: null, // startup update check result from the server (src/update.js)
};
const UPDATE_DISMISS_KEY = "kv.updateDismissed";

// ---------------------------------------------------------------- language (editor UI only)

function initialLanguage() {
  let stored = null;
  try {
    stored = localStorage.getItem(LANG_KEY);
  } catch {
    // Private mode: follow the browser.
  }
  return pickLanguage(stored, navigator.languages?.length ? navigator.languages : [navigator.language]);
}

/** Set the language and translate the static chrome of index.html. Never touches the config. */
function applyLanguage(lang) {
  setLanguage(lang);
  document.documentElement.lang = getLanguage();
  document.querySelectorAll("[data-i18n]").forEach((el) => (el.textContent = t(el.dataset.i18n)));
  document.querySelectorAll("[data-i18n-attr]").forEach((el) => {
    for (const pair of el.dataset.i18nAttr.split(";")) {
      const [attr, key] = pair.split(":");
      el.setAttribute(attr, t(key));
    }
  });
  document.querySelectorAll("#lang-switch button").forEach((b) => {
    const on = b.dataset.lang === getLanguage();
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
  });
  $("#pv-canvas").replaceChildren(...CANVASES.map((c) => h("option", { value: c.value, text: c.label })));
  window.KosmikUI?.mountLooks($("#looks"), { studio: t("look.studio"), daylight: t("look.daylight"), pixel: t("look.pixel") });
  if (S.update) renderUpdate();
}

/** ES/EN switch: re-render everything in place; the draft, dirty state and typed Discord fields survive. */
function switchLanguage(lang) {
  if (lang === getLanguage()) return;
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    // Private mode: the choice lasts until reload.
  }
  const typed = ["#discord-id", "#discord-secret"].map((sel) => [sel, $(sel)?.value]);
  applyLanguage(lang);
  if (S.errors.summary.length) S.errors = mapErrors(S.errors.summary.map((e) => ({ path: e.path, message: e.raw })), knownPaths(S.draft));
  if (S.draft) render();
  else {
    renderConn();
    layoutPreview();
  }
  if (dialog.open) renderGallery();
  for (const [sel, value] of typed) if (value != null && $(sel)) $(sel).value = value;
}

function loadFlags() {
  try {
    return JSON.parse(localStorage.getItem(FLAGS_KEY)) ?? {};
  } catch {
    return {};
  }
}

function setFlag(name, value) {
  S.flags[name] = value;
  try {
    localStorage.setItem(FLAGS_KEY, JSON.stringify(S.flags));
  } catch {
    // Private mode: the checklist simply forgets.
  }
  renderSteps();
}

// ---------------------------------------------------------------- DOM helpers

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  const late = {};
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k === "value" || k === "checked" || k === "disabled") late[k] = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  Object.assign(el, late);
  return el;
}

function toast(text, tone = "ok") {
  const box = $("#toast");
  box.textContent = text;
  box.className = `toast tone-${tone}`;
  box.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (box.hidden = true), tone === "ok" ? 3500 : 7000);
}

async function copyText(text, message = t("ed.copied")) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h("textarea", { value: text });
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  if (message) toast(message);
}

const clone = (v) => structuredClone(v);
const preset = () => S.draft.presets[S.presetIdx];
const effectiveCanvas = () => S.canvasOverride ?? preset()?.canvas ?? CANVASES[0].value;
const canvasLabel = (v) => CANVASES.find((c) => c.value === v)?.label ?? v;
const fmtSize = (n) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const assetUrl = (name) => `/assets/${encodeURIComponent(name)}`;
const liveName = (id) => S.voice?.members?.find((m) => m.id === id)?.name ?? "";

// ---------------------------------------------------------------- API

async function api(path, { method = "GET", body, raw, type } = {}) {
  const init = { method, headers: {} };
  if (raw) {
    init.body = raw;
    init.headers["Content-Type"] = type || "application/octet-stream";
  } else if (body !== undefined || method !== "GET") {
    init.body = JSON.stringify(body ?? {});
    init.headers["Content-Type"] = "application/json";
  }
  const res = await fetch(path, init);
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

async function loadAssets() {
  const r = await api("/api/assets");
  if (r.ok) S.assets = r.data;
}

async function uploadFile(file) {
  const r = await api(`/api/assets?name=${encodeURIComponent(file.name)}`, { method: "POST", raw: file, type: file.type });
  if (r.status === 413) throw new Error(t("ed.upload.tooBig", { name: file.name }));
  if (!r.ok) throw new Error(t("ed.upload.badType", { name: file.name }));
  await loadAssets();
  return r.data.name;
}

// ---------------------------------------------------------------- draft lifecycle

function setBase(config) {
  S.base = clone(config);
  S.draft = clone(config);
  S.remote = null;
  S.presetIdx = Math.min(S.presetIdx, S.draft.presets.length - 1);
}

function dirty() {
  return S.draft && isDirty(S.base, S.draft);
}

function refreshChrome() {
  const d = dirty();
  $("#dirty").hidden = !d;
  $("#save").disabled = !d;
  $("#discard").disabled = !d && !S.remote;
  const n = $("#notice");
  n.hidden = !S.remote;
  n.textContent = S.remote ? t("ed.remote") : "";
  renderErrorSummary();
}

/** Called after an in-place field edit: no re-render, so the input keeps focus. */
function edited(path) {
  if (S.errors.fields[path]) {
    delete S.errors.fields[path];
    S.errors.summary = S.errors.summary.filter((e) => e.target !== path);
    const f = document.querySelector(`[data-path="${CSS.escape(path)}"]`);
    if (f) {
      f.classList.remove("has-error");
      f.querySelectorAll(":scope > .field-error").forEach((e) => e.remove());
    }
  }
  refreshChrome();
  schedulePreview();
}

/** Structural change: mutate the draft and re-render. */
function change(fn) {
  const next = fn(S.draft);
  if (next) S.draft = next;
  S.presetIdx = Math.max(0, Math.min(S.presetIdx, S.draft.presets.length - 1));
  render();
}

async function save() {
  if (!dirty()) return;
  $("#save").disabled = true;
  let r;
  try {
    r = await api("/api/config", { method: "PUT", body: S.draft });
  } catch {
    toast(t("ed.save.offline"), "bad");
    refreshChrome();
    return;
  }
  if (r.ok) {
    setBase(r.data);
    S.errors = { fields: {}, summary: [] };
    toast(t("ed.save.ok"));
    render();
  } else if (r.status === 400 && r.data?.errors) {
    S.errors = mapErrors(r.data.errors, knownPaths(S.draft));
    toast(r.data.errors.length === 1 ? t("ed.save.invalid1") : t("ed.save.invalidN", { n: r.data.errors.length }), "bad");
    render();
  } else {
    toast(t("ed.save.failed", { detail: `${r.status}${r.data?.error ? `: ${r.data.error}` : ""}` }), "bad");
    refreshChrome();
  }
}

function discard() {
  setBase(S.remote ?? S.base);
  S.errors = { fields: {}, summary: [] };
  render();
  toast(t("ed.discarded"));
}

// ---------------------------------------------------------------- field builders

let uid = 0;
/** A labelled field: the <label for> points at the main input and the hint describes it. */
function field(path, label, control, { hint, wide } = {}) {
  const id = `f${++uid}`;
  const target = control.matches("input, select, textarea")
    ? control
    : control.querySelector('input[type="number"], input[type="text"], select');
  const hintEl = hint ? h("small", { class: "hint", id: `${id}-hint`, text: hint }) : null;
  if (target) {
    target.id = id;
    if (hintEl) target.setAttribute("aria-describedby", hintEl.id);
  }
  return h("div", { class: `field${wide ? " wide" : ""}`, "data-path": path }, h("label", { for: target ? id : null, text: label }), control, hintEl);
}

function numberField(path, spec, { label = spec.label, hint } = {}) {
  const value = getAt(S.draft, path);
  const step = spec.step ?? 1;
  const range = h("input", { type: "range", min: spec.min, max: spec.max, step, value, "aria-label": t("ed.slider", { label }), tabindex: -1 });
  const num = h("input", { type: "number", min: spec.min, max: spec.max, step, value, class: "num" });
  const set = (src, other) => {
    other.value = src.value;
    if (src.value === "" || !Number.isFinite(Number(src.value))) return;
    setAt(S.draft, path, Number(src.value));
    edited(path);
  };
  range.addEventListener("input", () => set(range, num));
  num.addEventListener("input", () => set(num, range));
  return field(path, label, h("div", { class: "num-row" }, range, num), { hint });
}

function selectField(path, label, options, { onChange, hint } = {}) {
  const sel = h("select", {}, options.map((o) => h("option", { value: o.value, text: o.label })));
  sel.value = getAt(S.draft, path);
  sel.addEventListener("change", () => {
    setAt(S.draft, path, sel.value);
    if (onChange) onChange();
    else edited(path);
  });
  return field(path, label, sel, { hint });
}

function boolField(path, label, { onChange } = {}) {
  const box = h("input", { type: "checkbox", checked: Boolean(getAt(S.draft, path)) });
  box.addEventListener("change", () => {
    setAt(S.draft, path, box.checked);
    onChange ? onChange() : edited(path);
  });
  return h("div", { class: "field check", "data-path": path }, h("label", {}, box, " ", label));
}

function textField(path, label, { max, placeholder, onInput, event = "input", hint } = {}) {
  const input = h("input", { type: "text", maxlength: max, placeholder, value: getAt(S.draft, path) ?? "", spellcheck: "false" });
  input.addEventListener(event, () => {
    if (onInput) onInput(input.value, input);
    else setAt(S.draft, path, input.value);
    edited(path);
  });
  return field(path, label, input, { hint });
}

/** Hex colour picker + text box. allowEmpty: "" is valid; themeDefault: "" means the theme colour, with a reset button. */
function colorField(path, label, { allowEmpty, themeDefault, hint } = {}) {
  const value = getAt(S.draft, path) || "";
  const valid6 = (v) => /^#[0-9a-f]{6}$/i.test(v.slice(0, 7));
  const placeholder = themeDefault ? t("ed.themeColor") : allowEmpty ? t("ed.noColor") : "#rrggbb";
  const pick = h("input", { type: "color", value: valid6(value) ? value.slice(0, 7) : "#ffcf8b", "aria-label": t("ed.colorPicker", { label }) });
  const text = h("input", { type: "text", class: "hex", maxlength: 9, value, placeholder, spellcheck: "false" });
  const reset = themeDefault
    ? h("button", { type: "button", class: "small", title: t("ed.themeColorReset"), text: t("ed.themeColorResetShort"), disabled: !value, onclick: () => {
      text.value = "";
      setAt(S.draft, path, "");
      sync();
      edited(path);
    } })
    : null;
  // An empty theme colour has no real swatch: dim the picker so it does not pretend to be the theme colour.
  const sync = () => {
    if (!reset) return;
    reset.disabled = !text.value.trim();
    pick.classList.toggle("is-empty", reset.disabled);
  };
  pick.addEventListener("input", () => {
    text.value = pick.value;
    setAt(S.draft, path, pick.value);
    sync();
    edited(path);
  });
  text.addEventListener("input", () => {
    const v = text.value.trim();
    if (valid6(v)) pick.value = v.slice(0, 7);
    setAt(S.draft, path, v);
    sync();
    edited(path);
  });
  sync();
  return field(path, label, h("div", { class: "color-row" }, pick, text, reset), { hint });
}

function schemaField(group, name) {
  const spec = FIELDS[group][name];
  const path = `presets[${S.presetIdx}].${group}.${name}`;
  if (spec.kind === "int" || spec.kind === "num") return numberField(path, spec);
  if (spec.kind === "enum") return selectField(path, spec.label, spec.options);
  if (spec.kind === "bool") return boolField(path, spec.label);
  if (spec.kind === "color") return colorField(path, spec.label);
  if (spec.kind === "optcolor") return colorField(path, spec.label, { allowEmpty: true, themeDefault: true });
  return textField(path, spec.label, { max: spec.max });
}

function applyFieldErrors(root) {
  for (const [path, messages] of Object.entries(S.errors.fields)) {
    const f = root.querySelector(`[data-path="${CSS.escape(path)}"]`);
    if (!f) continue;
    f.classList.add("has-error");
    for (const m of messages) f.append(h("div", { class: "field-error", text: m }));
  }
}

function renderErrorSummary() {
  const box = $("#errors");
  const list = S.errors.summary;
  box.hidden = !list.length;
  if (!list.length) return box.replaceChildren();
  box.replaceChildren(
    h("strong", { text: list.length === 1 ? t("ed.errors.one") : t("ed.errors.many", { n: list.length }) }),
    h("ul", {}, list.map((e) => h("li", {}, h("button", { type: "button", class: "link", onclick: () => goToError(e), text: describePath(e.path, S.draft) }), ` — ${e.message}`))),
  );
}

function goToError(e) {
  const p = e.target ?? e.path;
  const m = /^presets\[(\d+)\]/.exec(p);
  if (m) {
    S.presetIdx = Number(m[1]);
    location.hash = "#presets";
  } else if (p.startsWith("users")) location.hash = "#users";
  else location.hash = "#discord";
  setTab(location.hash.slice(1));
  requestAnimationFrame(() => {
    const f = e.target && document.querySelector(`[data-path="${CSS.escape(e.target)}"]`);
    if (!f) return;
    f.closest("details")?.setAttribute("open", "");
    f.scrollIntoView({ block: "center" });
    f.querySelector("input, select, button")?.focus();
  });
}

// ---------------------------------------------------------------- first steps

function goTo(tab, then) {
  if (location.hash !== `#${tab}`) history.replaceState(null, "", `#${tab}`);
  setTab(tab);
  if (then) requestAnimationFrame(then);
}

const STEP_ACTIONS = {
  discord: ["ed.steps.goDiscord", () => goTo("discord", () => $("#discord-id")?.focus())],
  preset: ["ed.steps.pickTemplate", () => goTo("presets", openGallery)],
  obs: ["ed.steps.copyObs", () => goTo("presets", () => $("#copy-obs")?.focus())],
};

function renderSteps() {
  const box = $("#steps");
  const toggle = $("#steps-toggle");
  toggle.setAttribute("aria-expanded", String(!S.flags.hidden));
  box.hidden = Boolean(S.flags.hidden) || !S.base;
  if (box.hidden) return box.replaceChildren();
  const steps = firstSteps({ status: S.status, config: S.base, flags: S.flags });
  const done = steps.filter((s) => s.done).length;
  box.replaceChildren(
    h("div", { class: "steps-head" },
      h("h2", { text: done === steps.length ? t("ed.steps.allDone") : t("ed.steps.title") }),
      h("span", { class: "steps-count", text: t("ed.steps.count", { done, total: steps.length }) }),
      h("button", { type: "button", class: "small", onclick: () => setFlag("hidden", true), text: t("ed.steps.hide") }),
    ),
    h("ol", { class: "checklist" }, steps.map((s, i) => h("li", { class: s.done ? "done" : "" },
      h("span", { class: "check-mark", "aria-hidden": "true", text: s.done ? "✔" : String(i + 1) }),
      h("div", { class: "check-text" },
        h("strong", { text: s.label }),
        h("span", { class: "sr-only", text: s.done ? t("ed.steps.srDone") : t("ed.steps.srPending") }),
        h("small", { class: "hint", text: s.done ? t("ed.steps.done") : s.hint }),
      ),
      s.done ? null : h("button", { type: "button", class: i === steps.findIndex((x) => !x.done) ? "small primary" : "small", onclick: STEP_ACTIONS[s.key][1], text: t(STEP_ACTIONS[s.key][0]) }),
    ))),
  );
}

// ---------------------------------------------------------------- Discord tab

const PORTAL_URL = "https://discord.com/developers/applications";

function renderDiscord() {
  const info = S.discord;
  const idInput = h("input", { type: "text", id: "discord-id", inputmode: "numeric", value: info?.clientId ?? "", placeholder: t("ed.discord.idPlaceholder"), spellcheck: "false", "aria-describedby": "discord-id-hint" });
  const secret = h("input", { type: "password", id: "discord-secret", value: "", autocomplete: "off", placeholder: info?.hasClientSecret ? t("ed.discord.secretKept") : t("ed.discord.secretPaste"), "aria-describedby": "discord-secret-hint" });
  const msg = S.discordMsg;
  const onSave = async (ev) => {
    ev.preventDefault();
    const body = { clientId: idInput.value.trim() };
    if (secret.value.trim()) body.clientSecret = secret.value.trim();
    const r = await api("/api/discord", { method: "PUT", body }).catch(() => null);
    if (r?.ok) {
      S.discord = r.data;
      S.status = r.data.status;
      // The server saved discord.clientId into the config: keep base and draft in sync with it.
      S.base.discord.clientId = r.data.clientId;
      S.draft.discord.clientId = r.data.clientId;
      S.discordMsg = { tone: "ok", key: "ed.discord.savedMsg" };
      toast(t("ed.discord.savedToast"));
    } else {
      S.discordMsg = { tone: "bad", key: r?.data?.error ? "ed.discord.badId" : "ed.discord.offline" };
      toast(t("ed.discord.failToast"), "bad");
    }
    render();
  };
  const logout = async () => {
    const r = await api("/api/discord/logout", { method: "POST" }).catch(() => null);
    if (r?.ok) {
      S.discord = r.data;
      S.status = r.data.status;
      S.discordMsg = { tone: "ok", key: "ed.discord.loggedOut" };
    }
    render();
  };
  const q = (word) => h("strong", { text: word });
  // The walkthrough leads until the app is set up; afterwards it folds away under the fields.
  const setUp = Boolean(info?.clientId && info?.hasClientSecret);
  const guide = h("details", { class: "guide", open: !setUp },
    h("summary", { text: t(setUp ? "ed.discord.guideAgain" : "ed.discord.guide") }),
    h("ol", { class: "steps numbered" },
        h("li", {}, parts("ed.discord.step1", { link: h("a", { href: PORTAL_URL, target: "_blank", rel: "noopener noreferrer", text: "discord.com/developers/applications" }) })),
        h("li", {}, parts("ed.discord.step2", { newApp: q("New Application"), name: h("code", { text: "Kosmik Voice" }), create: q("Create") })),
        h("li", {}, parts("ed.discord.step3", { oauth: q("OAuth2") })),
        h("li", {}, parts("ed.discord.step4", { clientId: q("Client ID") })),
        h("li", {}, parts("ed.discord.step5", { reset: q("Reset Secret"), secret: q("Client Secret") })),
        h("li", {}, parts("ed.discord.step6", { redirects: q("Redirects"), add: q("Add Redirect"), url: h("code", { text: "http://127.0.0.1" }), save: q("Save Changes") })),
        h("li", {}, parts("ed.discord.step7", { connect: q(t("ed.discord.submit")), authorize: q(t("ed.discord.authorize")) })),
    ),
    h("p", { class: "warn-box", role: "note" }, h("strong", { text: t("ed.discord.warnLead") }), t("ed.discord.warn")),
  );
  if (!setUp) guide.classList.add("first");
  return [
    h("div", { class: "card" },
      h("h2", { text: t("ed.discord.title") }),
      h("p", { class: "lead", text: t("ed.discord.lead") }),
      setUp ? null : guide,
      h("form", { class: "grid2", onsubmit: onSave },
        h("div", { class: "field", "data-path": "discord.clientId" },
          h("label", { for: "discord-id", text: "Client ID" }),
          idInput,
          h("small", { class: "hint", id: "discord-id-hint", text: t("ed.discord.idHint") }),
        ),
        h("div", { class: "field" },
          h("label", { for: "discord-secret" }, "Client Secret ", info?.hasClientSecret ? h("span", { class: "badge tone-ok", text: t("ed.discord.badgeSaved") }) : h("span", { class: "badge tone-warn", text: t("ed.discord.badgeMissing") })),
          secret,
          h("small", { class: "hint", id: "discord-secret-hint", text: t("ed.discord.secretHint") }),
        ),
        h("div", { class: "actions wide" },
          h("button", { type: "submit", class: "primary", text: t("ed.discord.submit") }),
          h("button", { type: "button", onclick: logout, disabled: !info?.hasToken, text: t("ed.discord.logout") }),
          msg ? h("span", { class: `msg tone-${msg.tone}`, role: "status", text: t(msg.key) }) : null,
        ),
      ),
      setUp ? guide : null,
    ),
    discordStatus(),
  ];
}

function discordStatus() {
  const info = S.discord;
  const st = statusText(S.status);
  const help = discordHelp(S.status);
  const voice = S.voice;
  return h("div", { class: "card", id: "discord-status" },
    h("h2", { text: t("ed.status.title") }),
    h("p", { class: "status-line" },
      h("span", { class: `pill tone-${st.tone}`, text: st.text }),
      info ? h("span", { class: `badge tone-${info.hasToken ? "ok" : "warn"}`, text: info.hasToken ? t("ed.status.authorized") : t("ed.status.unauthorized") }) : null,
    ),
    help ? h("div", { class: "help-box" }, h("strong", { text: help.title }), h("ol", {}, help.steps.map((s) => h("li", { text: s })))) : null,
    st.detail && S.status?.state !== "ready" ? h("details", { class: "detail" }, h("summary", { text: t("ed.status.detail") }), h("code", { class: "detail-code", text: st.detail })) : null,
    voice?.channel
      ? h("div", {},
          h("p", {}, t("ed.status.channel"), h("strong", { text: voice.channel.name || voice.channel.id }), ` · ${t(voice.members.length === 1 ? "ed.people.one" : "ed.people.many", { n: voice.members.length })}`),
          h("ul", { class: "members" }, voice.members.map((m) => h("li", {}, avatarImg(m.avatarUrl), h("span", { text: m.name }), m.speaking ? h("span", { class: "badge tone-ok", text: t("ed.badge.talking") }) : null))))
      : h("p", { class: "hint", text: S.status?.state === "ready" ? t("ed.status.readyHint") : t("ed.status.waitHint") }),
  );
}

function avatarImg(url) {
  return url ? h("img", { src: url, alt: "" }) : h("div", { class: "avatar-ph", "aria-hidden": "true" });
}

/** Live updates replace only their own box so inputs being typed in keep focus. */
function refreshLive() {
  renderConn();
  renderSteps();
  if (S.sim.source === "live") renderSim();
  schedulePreview();
  $("#discord-status")?.replaceWith(discordStatus());
  const panel = $("#call-panel");
  if (panel && !panel.contains(document.activeElement)) panel.replaceWith(callPanel());
}

// ---------------------------------------------------------------- Users tab

function imageSlot(i, state, label) {
  const path = `users[${i}].images.${state}`;
  const current = getAt(S.draft, path) || "";
  const who = S.draft.users[i].displayName || liveName(S.draft.users[i].id) || t("ed.thisPerson");
  const file = h("input", { type: "file", accept: "image/png,image/gif,image/webp,image/jpeg", hidden: true });
  const assign = async (f) => {
    try {
      const name = await uploadFile(f);
      setAt(S.draft, path, name);
      change(() => null);
      toast(t("ed.slot.assigned", { name, label }));
    } catch (err) {
      toast(err.message, "bad");
    }
  };
  file.addEventListener("change", () => file.files[0] && assign(file.files[0]));
  const zone = h("button", {
    type: "button", class: `drop-zone${current ? " has-image" : ""}`, onclick: () => file.click(),
    "aria-label": current ? t("ed.slot.ariaCurrent", { label, who, current }) : t("ed.slot.ariaEmpty", { label, who }),
  }, current ? h("img", { src: assetUrl(current), alt: "" }) : h("span", { class: "drop-text", text: t("ed.slot.drop") }));
  const sel = h("select", { "aria-label": t("ed.slot.ariaSelect", { label, who }) },
    h("option", { value: "", text: state === "idle" ? t("ed.slot.discordAvatar") : t("ed.slot.usesIdle", { idle: t("sim.idle") }) }),
    S.assets.map((a) => h("option", { value: a.name, text: a.name })),
    current && !S.assets.some((a) => a.name === current) ? h("option", { value: current, text: t("ed.slot.missing", { name: current }) }) : null,
  );
  sel.value = current;
  sel.addEventListener("change", () => {
    setAt(S.draft, path, sel.value);
    change(() => null);
  });
  const slot = h("div", { class: `slot field${state === "idle" ? " main" : ""}`, "data-path": path },
    h("div", { class: "slot-head" }, h("strong", { text: label }), h("span", { class: "hint", text: state === "idle" ? t("ed.slot.required") : t("ed.slot.optional") })),
    zone,
    sel,
    current ? h("button", { type: "button", class: "small", onclick: () => (setAt(S.draft, path, ""), change(() => null)), text: t("ed.slot.remove") }) : null,
    file,
  );
  dropTarget(slot, (files) => assign(files[0]));
  return slot;
}

function syncAliasInputs(idx, source) {
  const u = S.draft.users[idx];
  if (!u) return;
  const card = document.querySelector(`[data-path="users[${idx}].displayName"] input`);
  if (card && card !== source) card.value = u.displayName;
  const live = document.querySelector(`[data-alias="${CSS.escape(u.id)}"]`);
  if (live && live !== source) live.value = u.displayName;
  const title = document.querySelector(`[data-user-title="${idx}"]`);
  if (title) title.textContent = u.displayName || liveName(u.id) || t("ed.user.noAlias");
}

function userCard(u, i) {
  const p = (k) => `users[${i}].${k}`;
  const discordName = liveName(u.id);
  const idField = textField(p("id"), USER_LABELS.id, {
    max: 20,
    placeholder: t("ed.user.idPlaceholder"),
    event: "change",
    onInput: (v) => {
      S.draft = renameUserId(S.draft, S.draft.users[i].id, v.trim());
    },
  });
  const alias = textField(p("displayName"), USER_LABELS.displayName, {
    max: 40,
    placeholder: discordName || t("ed.user.aliasPlaceholder"),
    hint: t("ed.user.aliasHint"),
    onInput: (v, input) => {
      S.draft.users[i].displayName = v;
      syncAliasInputs(i, input);
    },
  });
  return h("div", { class: "card user" },
    h("div", { class: "row-between" },
      h("h3", { class: "user-title", "data-user-title": i, text: u.displayName || discordName || t("ed.user.noAlias") }),
      h("button", { type: "button", class: "danger small", onclick: () => confirm(t("ed.user.confirmRemove", { name: u.displayName || u.id || t("ed.thisPerson") })) && change((d) => removeUser(d, u.id)), text: t("ed.user.remove") }),
    ),
    h("div", { class: "user-head" },
      idField,
      alias,
      textField(p("role"), t("ed.user.roleOptional"), { max: 24, placeholder: t("ed.user.rolePlaceholder") }),
      colorField(p("roleColor"), USER_LABELS.roleColor, { allowEmpty: true }),
    ),
    h("div", { class: "slots" }, IMAGE_SLOTS.map((s) => imageSlot(i, s, t(`sim.${s}`)))),
    h("small", { class: "hint", text: t("ed.user.imagesHint", { idle: t("sim.idle") }) }),
  );
}

function onAliasInput(m, input) {
  const had = S.draft.users.some((u) => u.id === m.id);
  S.draft = setAlias(S.draft, m, input.value);
  const idx = S.draft.users.findIndex((u) => u.id === m.id);
  if (idx < 0) {
    if (input.value.trim() && S.draft.users.length >= 50) toast(t("ed.user.maxPeople"), "warn");
    return;
  }
  if (!had) {
    // A new user entry appeared: re-render the list and put the caret back where it was.
    const pos = input.selectionStart;
    render();
    const again = document.querySelector(`[data-alias="${CSS.escape(m.id)}"]`);
    again?.focus();
    again?.setSelectionRange(pos, pos);
    return;
  }
  syncAliasInputs(idx, input);
  edited(`users[${idx}].displayName`);
}

function callPanel() {
  const members = callMembers(S.voice, S.draft);
  return h("div", { class: "card picker", id: "call-panel" },
    h("h2", { text: t("ed.call.title") }),
    !S.voice?.channel
      ? h("p", { class: "empty", text: t("ed.call.none") })
      : h("div", {},
          h("p", { class: "hint", text: t("ed.call.hint", { name: S.voice.channel.name }) }),
          members.length
            ? h("ul", { class: "members live" }, members.map((m) => {
                const input = h("input", { type: "text", maxlength: 40, value: m.alias, placeholder: m.discordName || t("ed.call.aliasPlaceholder"), "data-alias": m.id, spellcheck: "false", "aria-label": t("ed.call.aliasAria", { name: m.discordName || m.id }) });
                input.addEventListener("input", () => onAliasInput(m, input));
                return h("li", {},
                  avatarImg(m.avatarUrl),
                  h("span", { class: "member-name" }, h("strong", { text: m.discordName || m.id }), m.speaking ? h("span", { class: "badge tone-ok", text: t("ed.badge.talking") }) : null),
                  input,
                  h("span", { class: `badge ${m.configured ? "tone-ok" : "tone-warn"}`, text: m.configured ? t("ed.call.onList") : t("ed.call.new") }),
                );
              }))
            : h("p", { class: "empty", text: t("ed.call.empty") }),
        ),
  );
}

function library() {
  const file = h("input", { type: "file", accept: "image/png,image/gif,image/webp,image/jpeg", multiple: true, hidden: true });
  const uploadMany = async (files) => {
    let ok = 0;
    for (const f of files) {
      try {
        await uploadFile(f);
        ok++;
      } catch (err) {
        toast(err.message, "bad");
      }
    }
    if (ok) toast(ok === 1 ? t("ed.lib.uploadedOne") : t("ed.lib.uploadedMany", { n: ok }));
    render();
  };
  file.addEventListener("change", () => uploadMany([...file.files]));
  const del = async (name) => {
    const local = assetUsers(S.draft, name);
    if (local.length) {
      S.libraryMsg = { key: "ed.lib.inUse", params: { name, users: local.join(", ") } };
      return render();
    }
    const r = await api(`/api/assets/${encodeURIComponent(name)}`, { method: "DELETE" }).catch(() => null);
    if (r?.status === 409) S.libraryMsg = { key: "ed.lib.inUseSaved", params: { name, users: (r.data?.users ?? []).join(", ") } };
    else if (r?.ok) S.libraryMsg = { key: "ed.lib.deleted", params: { name } };
    else S.libraryMsg = { key: "ed.lib.deleteFailed", params: { name } };
    await loadAssets();
    render();
  };
  const box = h("div", { class: "card library" },
    h("div", { class: "row-between" },
      h("h2", { text: t("ed.lib.title", { n: S.assets.length }) }),
      h("button", { type: "button", onclick: () => file.click(), text: t("ed.lib.upload") }),
      file,
    ),
    h("p", { class: "hint", text: t("ed.lib.hint") }),
    S.libraryMsg ? h("p", { class: "msg tone-warn", role: "status", text: t(S.libraryMsg.key, S.libraryMsg.params) }) : null,
    S.assets.length
      ? h("div", { class: "assets" }, S.assets.map((a) => h("figure", { class: "asset" },
          h("img", { src: assetUrl(a.name), alt: "", loading: "lazy" }),
          h("figcaption", {}, h("span", { class: "asset-name", text: a.name, title: a.name }), h("span", { class: "hint", text: fmtSize(a.size) })),
          h("button", { type: "button", class: "danger small", onclick: () => del(a.name), "aria-label": t("ed.lib.deleteAria", { name: a.name }), text: t("ed.delete") }),
        )))
      : h("p", { class: "empty", text: t("ed.lib.empty") }),
  );
  dropTarget(box, uploadMany);
  return box;
}

function renderUsers() {
  const addUser = () => {
    change((d) => void d.users.push(newUser()));
    requestAnimationFrame(() => $(`[data-path="users[${S.draft.users.length - 1}].id"] input`)?.focus());
  };
  return [
    h("div", { class: "card" },
      h("div", { class: "row-between", "data-path": "users" },
        h("h2", { text: t("ed.users.title", { n: S.draft.users.length }) }),
        h("button", { type: "button", onclick: addUser, text: t("ed.users.add") }),
      ),
      h("p", { class: "hint", text: t("ed.users.hint") }),
      h("details", { class: "detail" },
        h("summary", { text: t("ed.users.idHelpTitle") }),
        h("p", { class: "hint", text: t("ed.users.idHelp") }),
      ),
    ),
    callPanel(),
    S.draft.users.length ? S.draft.users.map(userCard) : h("p", { class: "empty card", text: t("ed.users.empty") }),
    library(),
  ];
}

// ---------------------------------------------------------------- Presets tab

function presetUsers() {
  const pr = preset();
  const i = S.presetIdx;
  const users = new Map(S.draft.users.map((u) => [u.id, u]));
  const available = S.draft.users.filter((u) => u.id && !pr.users.includes(u.id));
  const add = h("select", { "aria-label": t("ed.pu.addAria") },
    h("option", { value: "", text: t("ed.pu.add") }),
    available.map((u) => h("option", { value: u.id, text: u.displayName || liveName(u.id) || u.id })),
  );
  add.addEventListener("change", () => add.value && change((d) => void d.presets[i].users.push(add.value)));
  const hint = pr.mode === "slots"
    ? t("ed.pu.hintSlots")
    : t("ed.pu.hintReactive");
  const nameOf = (id) => users.get(id)?.displayName || liveName(id) || id;
  return h("div", { class: "field wide", "data-path": `presets[${i}].users` },
    h("label", { text: t("ed.pu.label") }),
    pr.users.length
      ? h("ol", { class: "order" }, pr.users.map((id, j) => h("li", {},
          h("span", { text: nameOf(id) }),
          h("span", { class: "spacer" }),
          h("button", { type: "button", class: "icon", "aria-label": t("ed.pu.upAria", { name: nameOf(id) }), title: t("ed.pu.up"), disabled: j === 0, onclick: () => change((d) => void (d.presets[i].users = moveItem(d.presets[i].users, j, -1))), text: "▲" }),
          h("button", { type: "button", class: "icon", "aria-label": t("ed.pu.downAria", { name: nameOf(id) }), title: t("ed.pu.down"), disabled: j === pr.users.length - 1, onclick: () => change((d) => void (d.presets[i].users = moveItem(d.presets[i].users, j, 1))), text: "▼" }),
          h("button", { type: "button", class: "icon danger", "aria-label": t("ed.pu.removeAria", { name: nameOf(id) }), title: t("ed.pu.remove"), onclick: () => change((d) => void d.presets[i].users.splice(j, 1)), text: "✕" }),
        )))
      : null,
    available.length ? add : null,
    h("small", { class: "hint", text: hint }),
  );
}

const posLabel = (x, y) => t(`pos.${y}.${x}`);

/** 3x3 position picker for alignX/alignY (a radio group with arrow-key navigation). */
function positionPicker(i) {
  const l = preset().layout;
  const X = ["left", "center", "right"];
  const Y = ["top", "center", "bottom"];
  const caption = h("small", { class: "hint", id: "pos-hint", text: t("ed.pos.caption", { pos: posLabel(l.alignX, l.alignY) }) });
  const cells = [];
  const select = (x, y, focus) => {
    S.draft.presets[i].layout.alignX = x;
    S.draft.presets[i].layout.alignY = y;
    for (const c of cells) {
      const on = c.dataset.x === x && c.dataset.y === y;
      c.setAttribute("aria-checked", String(on));
      c.tabIndex = on ? 0 : -1;
      c.classList.toggle("active", on);
      if (on && focus) c.focus();
    }
    caption.textContent = t("ed.pos.caption", { pos: posLabel(x, y) });
    edited(`presets[${i}].layout.alignX`);
    edited(`presets[${i}].layout.alignY`);
  };
  for (const y of Y) {
    for (const x of X) {
      const on = l.alignX === x && l.alignY === y;
      cells.push(h("button", {
        type: "button", role: "radio", class: `pos-cell${on ? " active" : ""}`, "aria-checked": String(on), tabindex: on ? 0 : -1,
        "aria-label": posLabel(x, y), title: posLabel(x, y), "data-x": x, "data-y": y,
        onclick: () => select(x, y, false),
        onkeydown: (ev) => {
          const { key } = ev;
          const dx = { ArrowLeft: -1, ArrowRight: 1 }[key] ?? 0;
          const dy = { ArrowUp: -1, ArrowDown: 1 }[key] ?? 0;
          if (!dx && !dy) return;
          ev.preventDefault();
          const nx = X[Math.max(0, Math.min(2, X.indexOf(x) + dx))];
          const ny = Y[Math.max(0, Math.min(2, Y.indexOf(y) + dy))];
          select(nx, ny, true);
        },
      }, h("span", { class: "pos-dot", "aria-hidden": "true" })));
    }
  }
  return h("div", { class: "field", "data-path": `presets[${i}].layout.alignX` },
    h("span", { class: "field-label", id: "pos-label", text: t("ed.pos.label") }),
    h("div", { class: "pos-grid", role: "radiogroup", "aria-labelledby": "pos-label", "aria-describedby": "pos-hint", "data-path": `presets[${i}].layout.alignY` }, cells),
    caption,
  );
}

function urlRow(label, url) {
  const id = `u${++uid}`;
  return h("div", { class: "url-row" },
    h("label", { class: "url-label", for: id, text: label }),
    h("input", { type: "text", id, readonly: true, value: url, onfocus: (e) => e.target.select() }),
    h("button", { type: "button", class: "small", onclick: () => copyText(url), "aria-label": t("ed.copyAria", { label }), text: t("ed.copy") }),
  );
}

async function copyForObs(pr) {
  const o = obsSetup(pr, location.origin);
  const saved = S.base.presets.some((p) => p.id === pr.id);
  await copyText(o.url, null);
  setFlag("obsCopied", true);
  if (saved) toast(t("ed.obs.copiedSaved", { width: o.width, height: o.height }));
  else toast(t("ed.obs.copiedUnsaved", { width: o.width, height: o.height }), "warn");
}

function obsCard(pr, saved) {
  const o = obsSetup(pr, location.origin);
  return h("div", { class: "card obs", id: "preset-urls" },
    h("h2", { text: t("ed.obs.title") }),
    h("div", { class: "obs-row" },
      h("button", { type: "button", class: "primary big", id: "copy-obs", onclick: () => copyForObs(preset()), text: t("ed.obs.copy") }),
      h("div", { class: "obs-size", "aria-label": t("ed.obs.sizeAria", { width: o.width, height: o.height }) },
        h("span", { class: "obs-dim" }, h("small", { text: t("ed.obs.width") }), h("strong", { text: o.width })),
        h("span", { class: "obs-dim" }, h("small", { text: t("ed.obs.height") }), h("strong", { text: o.height })),
      ),
    ),
    h("ol", { class: "steps numbered compact" },
      h("li", {}, parts("ed.obs.step1", { sources: h("strong", { text: t("ed.obs.sources") }), plus: h("strong", { text: "+" }), browser: h("strong", { text: t("ed.obs.browser") }) })),
      h("li", {}, parts("ed.obs.step2", { url: h("strong", { text: "URL" }) })),
      h("li", {}, t("ed.obs.step3", { width: o.width, height: o.height, canvas: canvasLabel(pr.canvas) })),
    ),
    saved ? null : h("p", { class: "msg tone-warn", text: t("ed.obs.unsaved") }),
    h("details", { class: "detail" },
      h("summary", { text: t("ed.obs.detail") }),
      urlRow("URL", o.url),
      urlRow(t("ed.obs.demo"), `${o.url}?demo=1`),
      h("small", { class: "hint", text: t("ed.obs.demoHint") }),
    ),
  );
}

const isAdvanced = (p) => {
  const m = /^presets\[\d+\]\.(layout|style)\.(\w+)$/.exec(p);
  if (m) return !BASIC[m[1]].includes(m[2]);
  return /^presets\[\d+\]\.(id|showUnlisted)$/.test(p);
};

function renderPresets() {
  const pr = preset();
  const i = S.presetIdx;
  const saved = S.base.presets.some((p) => p.id === pr.id);
  const errorCount = (k) => S.errors.summary.filter((e) => e.path.startsWith(`presets[${k}]`)).length;
  const onName = (v) => {
    S.draft.presets[i].name = v;
    if (!S.base.presets.some((p) => p.id === S.draft.presets[i].id)) {
      S.draft.presets[i].id = uniquePresetId(v, S.draft.presets.filter((_, k) => k !== i).map((p) => p.id));
      $("#preset-id").textContent = S.draft.presets[i].id;
      $("#preset-urls").replaceWith(obsCard(S.draft.presets[i], false));
    }
    const chip = document.querySelector(`[data-preset="${i}"] .chip-name`);
    if (chip) chip.textContent = v || t("ed.presets.noName");
    fillPresetSelect();
  };
  const onCanvas = () => {
    S.canvasOverride = null;
    edited(`presets[${i}].canvas`);
    $("#preset-urls").replaceWith(obsCard(S.draft.presets[i], saved));
    layoutPreview();
  };
  const advErrors = Object.keys(S.errors.fields).some((p) => p.startsWith(`presets[${i}].`) && isAdvanced(p));
  const pick = (group) => Object.keys(FIELDS[group]).filter((k) => !BASIC[group].includes(k) && !(group === "style" && THEME_COLOR_FIELDS.includes(k)));
  const sizeSpec = FIELDS.layout.size;
  return [
    h("div", { class: "card" },
      h("div", { class: "row-between", "data-path": "presets" },
        h("h2", { text: t("ed.presets.title") }),
        h("div", { class: "actions" },
          h("button", { type: "button", class: "primary", onclick: openGallery, disabled: S.draft.presets.length >= LIMIT_PRESETS, text: t("ed.presets.new") }),
          h("button", { type: "button", onclick: () => change((d) => { S.presetIdx = i + 1; return duplicatePreset(d, i); }), disabled: S.draft.presets.length >= LIMIT_PRESETS, text: t("ed.presets.duplicate") }),
          h("button", { type: "button", class: "danger", disabled: S.draft.presets.length <= 1, onclick: () => confirm(t("ed.presets.confirmDelete", { name: pr.name })) && change((d) => deletePreset(d, i)), text: t("ed.delete") }),
        ),
      ),
      h("p", { class: "hint", text: S.draft.presets.length >= LIMIT_PRESETS ? t("ed.presets.max", { max: LIMIT_PRESETS }) : t("ed.presets.hint") }),
      h("div", { class: "chips" }, S.draft.presets.map((p, k) => h("button", {
        type: "button", class: `chip${k === i ? " active" : ""}`, "data-preset": k, "aria-pressed": String(k === i),
        onclick: () => { S.presetIdx = k; S.canvasOverride = null; render(); },
      }, h("span", { class: "chip-name", text: p.name || t("ed.presets.noName") }), errorCount(k) ? h("span", { class: "badge tone-bad", text: errorCount(k) }) : null))),
    ),
    pr.mode === "slots" && !S.draft.users.length
      ? h("div", { class: "warn-box" }, parts("ed.presets.slotsNoUsers", { link: h("a", { href: "#users", text: t("ed.presets.addPeople") }) }))
      : null,
    h("div", { class: "card" },
      h("h2", { text: t("ed.presets.basics") }),
      h("div", { class: "grid2" },
        textField(`presets[${i}].name`, PRESET_LABELS.name, { max: 40, onInput: onName }),
        selectField(`presets[${i}].mode`, PRESET_LABELS.mode, [
          { value: "reactive", label: t("ed.mode.reactive") },
          { value: "slots", label: t("ed.mode.slots") },
        ], { onChange: () => change(() => null), hint: pr.mode === "slots" ? t("ed.mode.hintSlots") : t("ed.mode.hintReactive") }),
        selectField(`presets[${i}].canvas`, PRESET_LABELS.canvas, CANVASES, { onChange: onCanvas, hint: t("ed.canvasHint") }),
        themeField(i),
        positionPicker(i),
        h("div", { class: "stack" },
          numberField(`presets[${i}].layout.size`, sizeSpec, { label: t("ed.imageSize") }),
          schemaField("style", "talkAnimation"),
          schemaField("style", "showNames"),
        ),
        presetUsers(),
      ),
    ),
    obsCard(pr, saved),
    h("details", { class: "card advanced", open: S.advancedOpen || advErrors, ontoggle: (e) => (S.advancedOpen = e.target.open) },
      h("summary", { text: t("ed.advanced") }),
      h("p", { class: "hint", text: t("ed.advancedHint") }),
      h("h3", { text: t("ed.layoutTitle") }),
      h("div", { class: "grid2", "data-path": `presets[${i}].layout` },
        pick("layout").map((k) => schemaField("layout", k)),
        pr.mode === "reactive" ? boolField(`presets[${i}].showUnlisted`, PRESET_LABELS.showUnlisted) : null,
        h("div", { class: "field", "data-path": `presets[${i}].id` },
          h("span", { class: "field-label", text: PRESET_LABELS.id }),
          h("code", { id: "preset-id", class: "id", text: pr.id }),
          h("small", { class: "hint", text: saved ? t("ed.idLocked") : t("ed.idAuto") }),
        ),
      ),
      h("h3", { text: t("ed.styleTitle") }),
      h("div", { class: "grid2", "data-path": `presets[${i}].style` }, pick("style").map((k) => schemaField("style", k))),
      h("h3", { text: t("ed.colorsTitle") }),
      h("p", { class: "hint", text: t("ed.colorsHint") }),
      h("div", { class: "grid2" }, THEME_COLOR_FIELDS.map((k) => schemaField("style", k))),
    ),
  ];
}

/** Theme select plus a small colour sample and a one-line description of the chosen theme. */
function themeField(i) {
  const path = `presets[${i}].theme`;
  const theme = (v) => THEMES.find((x) => x.value === v) ?? THEMES[0];
  const sel = h("select", {}, THEMES.map((x) => h("option", { value: x.value, text: x.label })));
  sel.value = getAt(S.draft, path);
  const swatch = h("span", { class: "theme-swatch", "aria-hidden": "true" });
  const paint = () => {
    const th = theme(sel.value);
    swatch.className = `theme-swatch sw-${th.value}`;
    swatch.style.setProperty("--sw-bg", th.swatch[0]);
    swatch.style.setProperty("--sw-fg", th.swatch[1]);
    const hint = document.getElementById(`${sel.id}-hint`);
    if (hint) hint.textContent = th.description;
  };
  sel.addEventListener("change", () => {
    setAt(S.draft, path, sel.value);
    paint();
    edited(path);
  });
  const el = field(path, PRESET_LABELS.theme, h("div", { class: "theme-pick" }, sel, swatch), { hint: theme(sel.value).description });
  paint();
  return el;
}

// ---------------------------------------------------------------- template gallery

const dialog = $("#gallery");

/** Small schematic of a template: its canvas with the tiles where the overlay would put them. */
function schematic(tpl) {
  const { width, height } = canvasSize(tpl.canvas);
  const H = 96;
  const W = Math.round((H * width) / height);
  const k = W / width;
  const base = newPreset("x", "x");
  const l = { ...base.layout, ...tpl.preset.layout };
  const s = { ...base.style, ...tpl.preset.style };
  const count = tpl.maxUsers ?? (s.hideWhenSilent ? 1 : tpl.preset.mode === "slots" ? 6 : 3);
  const px = (v) => `${Math.max(1, Math.round(v * k * 10) / 10)}px`;
  return h("div", {
    class: `schem theme-${tpl.preset.theme ?? "pixel-cafe"} dir-${l.direction} ax-${l.alignX} ay-${l.alignY}${s.shape === "circle" ? " round" : ""}`,
    style: `width:${W}px;height:${H}px;padding:${px(l.padding)};--t:${px(l.size)};--g:${px(l.gap)};--cols:${l.columns}`,
    "aria-hidden": "true",
  }, h("div", { class: "schem-tiles" }, Array.from({ length: count }, (_, n) => h("span", { class: `schem-tile${n === 0 ? " talk" : ""}${s.showNames ? " named" : ""}` }))));
}

function openGallery() {
  if (S.draft.presets.length >= LIMIT_PRESETS) {
    toast(t("ed.gallery.limit", { max: LIMIT_PRESETS }), "warn");
    return;
  }
  const current = preset()?.canvas;
  S.galleryCanvas = CANVASES.some((c) => c.value === current && c.width > c.height) ? current : CANVASES[0].value;
  renderGallery();
  dialog.showModal();
  dialog.querySelector(".template")?.focus();
}

function renderGallery() {
  const landscape = CANVASES.filter((c) => c.width > c.height);
  const canvasText = (tpl) => canvasLabel(tpl.fixedCanvas ? tpl.canvas : S.galleryCanvas);
  dialog.replaceChildren(
    h("form", { method: "dialog", class: "gallery" },
      h("div", { class: "row-between" },
        h("h2", { id: "gallery-title", text: t("ed.gallery.title") }),
        h("button", { type: "submit", class: "small", value: "cancel", text: t("ed.gallery.close") }),
      ),
      h("p", { class: "hint", text: t("ed.gallery.hint") }),
      h("fieldset", { class: "canvas-pick" },
        h("legend", { text: t("ed.gallery.canvas") }),
        landscape.map((c) => h("label", {},
          h("input", { type: "radio", name: "g-canvas", value: c.value, checked: c.value === S.galleryCanvas, onchange: () => {
            S.galleryCanvas = c.value;
            dialog.querySelectorAll("[data-tpl-canvas]").forEach((el) => {
              const tpl = TEMPLATES.find((x) => x["key"] === el.dataset.tplCanvas);
              el.textContent = canvasText(tpl);
            });
          } }),
          " ", c.label,
        )),
        h("small", { class: "hint", text: t("ed.gallery.canvasHint") }),
      ),
      h("div", { class: "templates" }, TEMPLATES.map((tpl) => h("button", { type: "button", class: "template", onclick: () => pickTemplate(tpl) },
        schematic(tpl),
        h("strong", { class: "tpl-name", text: tpl.name }),
        h("span", { class: "tpl-desc", text: tpl.description }),
        h("span", { class: "tpl-canvas", "data-tpl-canvas": tpl["key"], text: canvasText(tpl) }),
      ))),
    ),
  );
}

function pickTemplate(tpl) {
  const r = presetFromTemplate(S.draft, tpl["key"], { canvas: S.galleryCanvas });
  if (r.error === "limit") return toast(t("ed.gallery.limit", { max: LIMIT_PRESETS }), "warn");
  if (r.error) return toast(t("ed.gallery.notFound"), "bad");
  dialog.close();
  S.draft = r.config;
  S.presetIdx = r.index;
  S.canvasOverride = null;
  setFlag("templatePicked", true);
  goTo("presets");
  if (r.needsUsers) toast(t("ed.gallery.createdSlots", { name: tpl.name }), "warn");
  else toast(t("ed.gallery.created", { name: tpl.name }));
  requestAnimationFrame(() => $(`[data-path="presets[${r.index}].name"] input`)?.focus());
}

// ---------------------------------------------------------------- drag & drop

function dropTarget(el, onFiles) {
  el.addEventListener("dragover", (e) => {
    if (![...(e.dataTransfer?.types ?? [])].includes("Files")) return;
    e.preventDefault();
    el.classList.add("drop");
  });
  el.addEventListener("dragleave", (e) => {
    if (!el.contains(e.relatedTarget)) el.classList.remove("drop");
  });
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove("drop");
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length) onFiles(files);
  });
}
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

// ---------------------------------------------------------------- preview

const frame = $("#pv-frame");
const stage = $("#pv-stage");
let frameReady = false;
let previewQueued = false;

function previewVoice() {
  const pr = preset();
  if (S.sim.source === "live") return simulationVoice(S.draft, pr, { source: "live", live: S.voice });
  if (S.sim.mode === "manual") return simulationVoice(S.draft, pr, { source: "manual", states: S.sim.states });
  return simulationVoice(S.draft, pr, { source: S.sim.mode, tick: S.sim.tick });
}

function postPreview() {
  previewQueued = false;
  if (!frameReady || !S.draft) return;
  // The selected preset is sent under a fixed id so unsaved/duplicate ids never confuse the overlay.
  const pr = { ...preset(), id: "preview" };
  const config = { ...S.draft, presets: [pr] };
  const v = previewVoice();
  frame.contentWindow.postMessage({ type: "preview", presetId: "preview", config, voice: v }, location.origin);
  const cv = effectiveCanvas();
  const source = S.sim.source === "live" ? (S.voice?.channel ? t("ed.pv.live", { n: v.members.length, channel: S.voice.channel.name }) : t("ed.pv.liveNone")) : t("ed.pv.sim");
  $("#pv-caption").textContent = `${preset().name || preset().id} · ${canvasLabel(cv)}${S.canvasOverride ? t("ed.pv.previewOnly") : ""} · ${source}`;
}

function schedulePreview() {
  if (previewQueued) return;
  previewQueued = true;
  requestAnimationFrame(postPreview);
}

function markFrameReady() {
  frameReady = true;
  schedulePreview();
}
window.addEventListener("message", (e) => {
  if (e.origin !== location.origin || e.source !== frame.contentWindow || e.data?.type !== "preview-ready") return;
  markFrameReady();
});
// The overlay may announce itself before this module runs; its load event (after its module ran) is the fallback.
frame.addEventListener("load", markFrameReady);
if (frame.contentDocument?.readyState === "complete" && frame.contentWindow.location.pathname.startsWith("/overlay/")) markFrameReady();

function layoutPreview() {
  const { width: w, height: hgt } = canvasSize(S.draft ? effectiveCanvas() : CANVASES[0].value);
  const sel = $("#pv-canvas");
  if (S.draft && sel.value !== effectiveCanvas()) sel.value = effectiveCanvas();
  const aside = stage.parentElement;
  const avail = aside.clientWidth - 2 * 12;
  const maxH = Math.max(240, window.innerHeight * (hgt > w ? 0.62 : 0.5));
  const scale = Math.min(avail / w, maxH / hgt);
  stage.style.width = `${Math.floor(w * scale)}px`;
  stage.style.height = `${Math.floor(hgt * scale)}px`;
  frame.style.width = `${w}px`;
  frame.style.height = `${hgt}px`;
  frame.style.transform = `scale(${scale})`;
  schedulePreview();
}
new ResizeObserver(layoutPreview).observe(stage.parentElement);
window.addEventListener("resize", layoutPreview);

applyLanguage(initialLanguage());
document.querySelectorAll("#lang-switch button").forEach((b) => b.addEventListener("click", () => switchLanguage(b.dataset.lang)));
$("#pv-canvas").addEventListener("change", (e) => {
  S.canvasOverride = e.target.value === preset()?.canvas ? null : e.target.value;
  layoutPreview();
});
$("#pv-bg").addEventListener("change", (e) => {
  stage.className = `stage bg-${e.target.value}`;
});
$("#pv-preset").addEventListener("change", (e) => {
  S.presetIdx = Number(e.target.value);
  S.canvasOverride = null;
  render();
});
document.querySelectorAll('input[name="pv-source"]').forEach((r) =>
  r.addEventListener("change", () => {
    S.sim.source = r.value;
    renderSim();
    schedulePreview();
  }),
);

function fillPresetSelect() {
  const sel = $("#pv-preset");
  sel.replaceChildren(...S.draft.presets.map((p, k) => h("option", { value: k, text: p.name || p.id || t("ed.pv.presetN", { n: k + 1 }) })));
  sel.value = String(S.presetIdx);
}

let rotateTimer = null;
function setSimMode(mode) {
  S.sim.mode = mode;
  clearInterval(rotateTimer);
  rotateTimer = null;
  if (mode === "rotate") {
    rotateTimer = setInterval(() => {
      S.sim.tick++;
      schedulePreview();
    }, 1400);
  }
  renderSim();
  schedulePreview();
}

function renderSim() {
  const body = $("#sim-body");
  document.querySelectorAll('input[name="pv-source"]').forEach((r) => (r.checked = r.value === S.sim.source));
  if (S.sim.source === "live") {
    clearInterval(rotateTimer);
    rotateTimer = null;
    const v = S.voice;
    body.replaceChildren(h("p", { class: "hint", text: v?.channel ? t("ed.sim.live", { n: v.members.length, name: v.channel.name }) : t("ed.sim.liveNone") }));
    return;
  }
  if (S.sim.mode === "rotate" && !rotateTimer) setSimMode("rotate");
  const modeBtn = (mode, label, title) => h("button", { type: "button", class: `small${S.sim.mode === mode ? " active" : ""}`, "aria-pressed": String(S.sim.mode === mode), title, onclick: () => setSimMode(mode), text: label });
  const rows = S.draft.users.map((u) => {
    const cur = S.sim.states[u.id] ?? "idle";
    const name = u.displayName || liveName(u.id) || u.id || t("ed.sim.noId");
    return h("div", { class: "sim-row" },
      h("span", { class: "sim-name", text: name }),
      h("div", { class: "seg small", role: "group", "aria-label": t("ed.sim.stateAria", { name }) }, SIM_STATES.map((s) => h("button", {
        type: "button", class: S.sim.mode === "manual" && cur === s.value ? "active" : "", "aria-pressed": String(S.sim.mode === "manual" && cur === s.value), text: s.label,
        onclick: () => {
          S.sim.states[u.id] = s.value;
          setSimMode("manual");
        },
      }))),
    );
  });
  body.replaceChildren(
    h("div", { class: "actions" },
      modeBtn("all", t("ed.sim.all"), t("ed.sim.allTitle")),
      modeBtn("rotate", t("ed.sim.rotate"), t("ed.sim.rotateTitle")),
      modeBtn("static", t("ed.sim.static"), t("ed.sim.staticTitle")),
      modeBtn("manual", t("ed.sim.manual"), t("ed.sim.manualTitle")),
    ),
    rows.length ? h("div", { class: "sim-rows" }, rows) : h("p", { class: "hint", text: t("ed.sim.empty") }),
  );
}

// ---------------------------------------------------------------- render + routing

function render() {
  if (!S.draft) return;
  document.querySelectorAll(".tabs a").forEach((a) => {
    const on = a.dataset.tab === S.tab;
    a.classList.toggle("active", on);
    if (on) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
    const n = S.errors.summary.filter((e) => (a.dataset.tab === "presets" ? e.path.startsWith("presets") : a.dataset.tab === "users" ? e.path.startsWith("users") : e.path.startsWith("discord") || !e.path)).length;
    a.dataset.errors = n || "";
  });
  const panel = $("#panel");
  const scroll = panel.scrollTop;
  const parts = S.tab === "discord" ? renderDiscord() : S.tab === "users" ? renderUsers() : renderPresets();
  panel.replaceChildren(...[parts].flat(Infinity).filter(Boolean));
  applyFieldErrors(panel);
  panel.scrollTop = scroll;
  fillPresetSelect();
  renderSim();
  refreshChrome();
  renderConn();
  renderSteps();
  layoutPreview();
}

function renderConn() {
  const st = statusText(S.status);
  const c = $("#conn");
  c.className = `pill tone-${st.tone}`;
  c.title = st.text;
  const text = S.voice?.channel && S.status?.state === "ready" ? `${st.text} · ${S.voice.channel.name} (${S.voice.members.length})` : st.text;
  c.replaceChildren(h("span", { class: "pill-text", text }));
}

function setTab(tab) {
  const next = TABS.includes(tab) ? tab : "discord";
  if (next !== S.tab) $("#panel").scrollTop = 0;
  S.tab = next;
  render();
}
window.addEventListener("hashchange", () => setTab(location.hash.slice(1)));

$("#save").addEventListener("click", save);
$("#discard").addEventListener("click", () => (!dirty() || confirm(t("ed.confirmDiscard"))) && discard());
$("#steps-toggle").addEventListener("click", () => setFlag("hidden", !S.flags.hidden));
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e["key"].toLowerCase() === "s") {
    e.preventDefault();
    save();
  }
});
window.addEventListener("beforeunload", (e) => {
  if (dirty()) e.preventDefault();
});

// ---------------------------------------------------------------- live connection

/** Banner when GitHub has a newer version. Dismissing hides it until there is an even newer one. */
function renderUpdate() {
  const box = $("#update");
  const u = S.update;
  const key = u?.state === "available" ? `${u.url}|${u.behind ?? u.latest?.version}` : "";
  let dismissed = "";
  try {
    dismissed = localStorage.getItem(UPDATE_DISMISS_KEY) ?? "";
  } catch {
    // storage blocked: the banner just shows again next time
  }
  box.hidden = !key || dismissed === key;
  if (box.hidden) return box.replaceChildren();
  const what = u.behind ? t(u.behind === 1 ? "ed.update.one" : "ed.update.many", { n: u.behind }) : t("ed.update.version", { version: u.latest.version });
  box.replaceChildren(
    h("strong", { text: t("ed.update.title") }),
    h("span", { text: what }),
    u.via === "git"
      ? h("span", {}, parts("ed.update.howGit", { cmd: h("code", { text: "git pull" }) }))
      : h("span", { text: t("ed.update.howZip") }),
    h("a", { href: u.url, target: "_blank", rel: "noopener noreferrer", text: u.via === "git" ? t("ed.update.changes") : t("ed.update.download") }),
    h("button", { type: "button", class: "small", text: t("ed.update.dismiss"), onclick: () => {
      try {
        localStorage.setItem(UPDATE_DISMISS_KEY, key);
      } catch {
        // ignore
      }
      renderUpdate();
    } }),
  );
}

function onMessage(msg) {
  if (msg.type === "hello" || msg.type === "update") {
    S.update = msg.update ?? null;
    renderUpdate();
    if (msg.type === "update") return;
  }
  if (msg.type === "hello" || msg.type === "config") {
    if (msg.type === "hello") {
      S.status = msg.status;
      S.voice = msg.voice ?? S.voice;
    }
    if (!S.draft || !dirty()) setBase(msg.config);
    else {
      // Keep the user's edits; only the Discord app id (saved from its own form) is synced.
      S.base.discord = clone(msg.config.discord);
      S.draft.discord = clone(msg.config.discord);
      if (isDirty(S.base, msg.config)) S.remote = clone(msg.config);
      refreshChrome();
      return;
    }
    render();
  } else if (msg.type === "voice") {
    S.voice = msg.voice;
    refreshLive();
  } else if (msg.type === "status") {
    S.status = msg.status;
    api("/api/discord").then((r) => r.ok && (S.discord = r.data)).catch(() => {}).finally(refreshLive);
  }
}

function connect() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.onmessage = (e) => {
    try {
      onMessage(JSON.parse(e.data));
    } catch (err) {
      console.error(err);
    }
  };
  ws.onclose = () => {
    S.status = null;
    renderConn();
    setTimeout(connect, 2000);
  };
}

async function start() {
  S.tab = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "discord";
  layoutPreview();
  const [cfg, disc] = await Promise.all([api("/api/config"), api("/api/discord"), loadAssets()]);
  if (cfg.ok) setBase(cfg.data);
  if (disc.ok) {
    S.discord = disc.data;
    S.status = disc.data.status;
  }
  // First run: start on the first step that is not done yet.
  if (!location.hash && S.base && S.status?.state === "ready") S.tab = "presets";
  // ?preset=<id> opens that preset (handy to link straight to one).
  const wanted = new URLSearchParams(location.search).get("preset");
  const idx = S.draft?.presets.findIndex((p) => p.id === wanted) ?? -1;
  if (idx >= 0) S.presetIdx = idx;
  render();
  connect();
  // ?gallery=1 opens the template gallery (used by the README screenshots and the checklist link).
  if (new URLSearchParams(location.search).get("gallery") === "1" && S.draft) {
    S.tab = "presets";
    render();
    openGallery();
  }
}
start();
