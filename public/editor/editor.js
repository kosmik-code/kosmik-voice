// Kosmik Voice editor. Draft-based: every edit changes S.draft, the preview iframe gets the draft
// immediately, "Guardar" PUTs the whole config. User text is always rendered with textContent.
import {
  FIELDS, PRESET_LABELS, SIM_STATES, uniquePresetId, mapErrors, describePath, isDirty, simulationVoice,
  membersNotConfigured, newUser, removeUser, renameUserId, duplicatePreset, deletePreset, moveItem, assetUsers,
  statusText, getAt, setAt, knownPaths, newPreset,
} from "/editor/logic.js";

const $ = (sel, root = document) => root.querySelector(sel);
const TABS = ["discord", "users", "presets"];
const IMAGE_SLOTS = [
  ["idle", "Normal"],
  ["talking", "Hablando"],
  ["muted", "Muteado"],
  ["deafened", "Sordo"],
];

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
  canvas: "1920x1080",
  showCallPicker: false,
  libraryMsg: "",
  discordMsg: null,
};

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
  const t = $("#toast");
  t.textContent = text;
  t.className = `toast tone-${tone}`;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), tone === "bad" ? 6000 : 2500);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h("textarea", { value: text });
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  toast("Copiado");
}

const clone = (v) => structuredClone(v);
const preset = () => S.draft.presets[S.presetIdx];
const fmtSize = (n) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const assetUrl = (name) => `/assets/${encodeURIComponent(name)}`;

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
  if (r.status === 413) throw new Error(`«${file.name}» supera 10 MB`);
  if (!r.ok) throw new Error(`«${file.name}»: solo imágenes PNG, GIF, WebP o JPG`);
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
  n.textContent = S.remote ? "La configuración se guardó desde otra ventana. «Descartar» carga esa versión (perdés tus cambios sin guardar)." : "";
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
      f.querySelectorAll(".field-error").forEach((e) => e.remove());
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
    toast("No se pudo conectar con Kosmik Voice", "bad");
    refreshChrome();
    return;
  }
  if (r.ok) {
    setBase(r.data);
    S.errors = { fields: {}, summary: [] };
    toast("Guardado ✔");
    render();
  } else if (r.status === 400 && r.data?.errors) {
    S.errors = mapErrors(r.data.errors, knownPaths(S.draft));
    toast(`No se guardó: ${r.data.errors.length} error(es)`, "bad");
    render();
  } else {
    toast(`No se guardó (${r.status}${r.data?.error ? `: ${r.data.error}` : ""})`, "bad");
    refreshChrome();
  }
}

function discard() {
  setBase(S.remote ?? S.base);
  S.errors = { fields: {}, summary: [] };
  render();
}

// ---------------------------------------------------------------- field builders

function field(path, label, control, { hint, wide } = {}) {
  return h("div", { class: `field${wide ? " wide" : ""}`, "data-path": path }, h("label", { text: label }), control, hint ? h("small", { class: "hint", text: hint }) : null);
}

function numberField(path, spec) {
  const value = getAt(S.draft, path);
  const step = spec.step ?? 1;
  const range = h("input", { type: "range", min: spec.min, max: spec.max, step, value });
  const num = h("input", { type: "number", min: spec.min, max: spec.max, step, value, class: "num", "aria-label": spec.label });
  const set = (src, other) => {
    other.value = src.value;
    if (src.value === "" || !Number.isFinite(Number(src.value))) return;
    setAt(S.draft, path, Number(src.value));
    edited(path);
  };
  range.addEventListener("input", () => set(range, num));
  num.addEventListener("input", () => set(num, range));
  return field(path, spec.label, h("div", { class: "num-row" }, range, num));
}

function selectField(path, label, options, { onChange } = {}) {
  const sel = h("select", {}, options.map((o) => h("option", { value: o.value, text: o.label })));
  sel.value = getAt(S.draft, path);
  sel.addEventListener("change", () => {
    setAt(S.draft, path, sel.value);
    if (onChange) onChange();
    else edited(path);
  });
  return field(path, label, sel);
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

function colorField(path, label, { allowEmpty } = {}) {
  const value = getAt(S.draft, path) || "";
  const valid6 = (v) => /^#[0-9a-f]{6}$/i.test(v.slice(0, 7));
  const pick = h("input", { type: "color", value: valid6(value) ? value.slice(0, 7) : "#ffcf8b" });
  const text = h("input", { type: "text", class: "hex", maxlength: 9, value, placeholder: allowEmpty ? "sin color" : "#rrggbb", spellcheck: "false" });
  pick.addEventListener("input", () => {
    text.value = pick.value;
    setAt(S.draft, path, pick.value);
    edited(path);
  });
  text.addEventListener("input", () => {
    const v = text.value.trim();
    if (valid6(v)) pick.value = v.slice(0, 7);
    setAt(S.draft, path, v);
    edited(path);
  });
  return field(path, label, h("div", { class: "color-row" }, pick, text));
}

function schemaField(group, key) {
  const spec = FIELDS[group][key];
  const path = `presets[${S.presetIdx}].${group}.${key}`;
  if (spec.kind === "int" || spec.kind === "num") return numberField(path, spec);
  if (spec.kind === "enum") return selectField(path, spec.label, spec.options);
  if (spec.kind === "bool") return boolField(path, spec.label);
  if (spec.kind === "color") return colorField(path, spec.label);
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
    h("strong", { text: `No se pudo guardar. Corregí ${list.length === 1 ? "este campo" : `estos ${list.length} campos`}:` }),
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
    f.scrollIntoView({ block: "center" });
    f.querySelector("input, select, button")?.focus();
  });
}

// ---------------------------------------------------------------- Discord tab

function renderDiscord() {
  const info = S.discord;
  const st = statusText(S.status);
  const idInput = h("input", { type: "text", inputmode: "numeric", value: info?.clientId ?? "", placeholder: "ej. 1234567890123456789", spellcheck: "false" });
  const secret = h("input", { type: "password", value: "", autocomplete: "off", placeholder: info?.hasClientSecret ? "guardado — dejalo vacío para no cambiarlo" : "pegá el Client Secret" });
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
      S.discordMsg = { tone: "ok", text: "Guardado. Si Discord te muestra un pedido de autorización, aceptalo." };
    } else {
      S.discordMsg = { tone: "bad", text: r?.data?.error ? "El Application ID tiene que ser el número de tu aplicación (17 a 20 dígitos)." : "No se pudo guardar." };
    }
    render();
  };
  const logout = async () => {
    const r = await api("/api/discord/logout", { method: "POST" }).catch(() => null);
    if (r?.ok) {
      S.discord = r.data;
      S.status = r.data.status;
      S.discordMsg = { tone: "ok", text: "Sesión cerrada. Discord va a pedir autorización de nuevo." };
    }
    render();
  };
  return [
    h("div", { class: "card" },
      h("h2", { text: "Conectar con Discord" }),
      h("ol", { class: "steps" },
        h("li", {}, "Entrá a ", h("a", { href: "https://discord.com/developers/applications", target: "_blank", rel: "noopener noreferrer", text: "discord.com/developers/applications" }), " y creá una aplicación (New Application)."),
        h("li", { text: "En OAuth2 copiá el Application ID (Client ID) y el Client Secret (Reset Secret si no lo ves)." }),
        h("li", {}, "En OAuth2 › Redirects agregá ", h("code", { text: "http://127.0.0.1" }), " y guardá."),
        h("li", { text: "Pegá los dos datos acá, guardá y aceptá el pedido que aparece en Discord (tenés que tener Discord de escritorio abierto)." }),
      ),
      h("form", { class: "grid2", onsubmit: onSave },
        h("div", { class: "field", "data-path": "discord.clientId" }, h("label", { text: "Application ID" }), idInput),
        h("div", { class: "field" },
          h("label", {}, "Client Secret ", info?.hasClientSecret ? h("span", { class: "badge tone-ok", text: "guardado" }) : h("span", { class: "badge tone-warn", text: "falta" })),
          secret,
          h("small", { class: "hint", text: "Se guarda solo en esta PC y nunca se muestra." }),
        ),
        h("div", { class: "actions wide" },
          h("button", { type: "submit", class: "primary", text: "Guardar y conectar" }),
          h("button", { type: "button", onclick: logout, disabled: !info?.hasToken, text: "Cerrar sesión de Discord" }),
          msg ? h("span", { class: `msg tone-${msg.tone}`, text: msg.text }) : null,
        ),
      ),
    ),
    discordStatus(),
  ];
}

function discordStatus() {
  const info = S.discord;
  const st = statusText(S.status);
  const voice = S.voice;
  return h("div", { class: "card", id: "discord-status" },
      h("h2", { text: "Estado" }),
      h("p", { class: "status-line" }, h("span", { class: `pill tone-${st.tone}`, text: st.text }), info ? h("span", { class: `badge tone-${info.hasToken ? "ok" : "warn"}`, text: info.hasToken ? "autorizado" : "sin autorizar" }) : null),
      st.detail && ["error", "discord_closed", "auth_failed"].includes(S.status?.state) ? h("p", { class: "hint", text: `Detalle: ${st.detail}` }) : null,
      voice?.channel
        ? h("div", {},
            h("p", {}, "Canal de voz: ", h("strong", { text: voice.channel.name || voice.channel.id }), ` · ${voice.members.length} ${voice.members.length === 1 ? "persona" : "personas"}`),
            h("ul", { class: "members" }, voice.members.map((m) => h("li", {}, h("img", { src: m.avatarUrl || "", alt: "" }), h("span", { text: m.name }), m.speaking ? h("span", { class: "badge tone-ok", text: "hablando" }) : null))))
        : h("p", { class: "hint", text: "No estás en un canal de voz (o Discord no está conectado)." }),
  );
}

/** Live updates replace only their own box so inputs being typed in keep focus. */
function refreshLive() {
  renderConn();
  if (S.sim.source === "live") renderSim();
  schedulePreview();
  $("#discord-status")?.replaceWith(discordStatus());
  $("#call-picker")?.replaceWith(callPicker());
}

// ---------------------------------------------------------------- Users tab

function imageSlot(i, state, label) {
  const path = `users[${i}].images.${state}`;
  const current = getAt(S.draft, path) || "";
  const thumb = h("div", { class: "thumb" }, current ? h("img", { src: assetUrl(current), alt: "" }) : h("span", { text: state === "idle" ? "avatar" : "—" }));
  const sel = h("select", { "aria-label": `${label} de ${S.draft.users[i].displayName || "usuario"}` },
    h("option", { value: "", text: state === "idle" ? "(avatar de Discord)" : "(usa la normal)" }),
    S.assets.map((a) => h("option", { value: a.name, text: a.name })),
    current && !S.assets.some((a) => a.name === current) ? h("option", { value: current, text: `${current} (no existe)` }) : null,
  );
  sel.value = current;
  sel.addEventListener("change", () => {
    setAt(S.draft, path, sel.value);
    change(() => null);
  });
  const file = h("input", { type: "file", accept: "image/png,image/gif,image/webp,image/jpeg", hidden: true });
  const assign = async (f) => {
    try {
      const name = await uploadFile(f);
      setAt(S.draft, path, name);
      change(() => null);
    } catch (err) {
      toast(err.message, "bad");
    }
  };
  file.addEventListener("change", () => file.files[0] && assign(file.files[0]));
  const slot = h("div", { class: "slot field", "data-path": path },
    h("label", { text: label }),
    thumb,
    sel,
    h("button", { type: "button", class: "small", onclick: () => file.click(), text: "Subir…" }),
    file,
  );
  dropTarget(slot, (files) => assign(files[0]));
  return slot;
}

function userCard(u, i) {
  const p = (k) => `users[${i}].${k}`;
  const idField = textField(p("id"), "ID de Discord", {
    max: 20,
    placeholder: "17-20 dígitos",
    event: "change",
    onInput: (v) => {
      S.draft = renameUserId(S.draft, S.draft.users[i].id, v.trim());
    },
  });
  return h("div", { class: "card user" },
    h("div", { class: "user-head" },
      idField,
      textField(p("displayName"), "Nombre", { max: 40, placeholder: "como figura en Discord" }),
      textField(p("role"), "Rol", { max: 24, placeholder: "opcional" }),
      colorField(p("roleColor"), "Color del rol", { allowEmpty: true }),
      h("button", { type: "button", class: "danger small", title: "Quitar usuario", onclick: () => confirm(`¿Quitar a ${u.displayName || u.id || "este usuario"}?`) && change((d) => removeUser(d, u.id)), text: "Quitar" }),
    ),
    h("div", { class: "slots" }, IMAGE_SLOTS.map(([s, l]) => imageSlot(i, s, l))),
  );
}

function callPicker() {
  const missing = membersNotConfigured(S.voice, S.draft);
  return h("div", { class: "card picker", id: "call-picker" },
    h("h3", { text: "Personas en la llamada" }),
    !S.voice?.channel
      ? h("p", { class: "hint", text: "No hay llamada activa. Entrá a un canal de voz con Discord conectado." })
      : missing.length
        ? h("ul", { class: "members" }, missing.map((m) => h("li", {}, h("img", { src: m.avatarUrl || "", alt: "" }), h("span", { text: m.name }), h("button", {
            type: "button", class: "small", text: "Agregar",
            onclick: () => change((d) => void d.users.push(newUser(m.id, String(m.name ?? "").slice(0, 40)))),
          }))))
        : h("p", { class: "hint", text: "Todas las personas de la llamada ya están configuradas." }),
  );
}

function library() {
  const file = h("input", { type: "file", accept: "image/png,image/gif,image/webp,image/jpeg", multiple: true, hidden: true });
  const uploadMany = async (files) => {
    for (const f of files) {
      try {
        await uploadFile(f);
      } catch (err) {
        toast(err.message, "bad");
      }
    }
    render();
  };
  file.addEventListener("change", () => uploadMany([...file.files]));
  const del = async (name) => {
    const local = assetUsers(S.draft, name);
    if (local.length) {
      S.libraryMsg = `«${name}» está en uso por ${local.join(", ")}.`;
      return render();
    }
    const r = await api(`/api/assets/${encodeURIComponent(name)}`, { method: "DELETE" }).catch(() => null);
    if (r?.status === 409) S.libraryMsg = `«${name}» está en uso por ${(r.data?.users ?? []).join(", ")} (en la config guardada).`;
    else if (r?.ok) S.libraryMsg = `Borrada «${name}».`;
    else S.libraryMsg = `No se pudo borrar «${name}».`;
    await loadAssets();
    render();
  };
  const box = h("div", { class: "card library" },
    h("div", { class: "row-between" },
      h("h2", { text: `Imágenes (${S.assets.length})` }),
      h("button", { type: "button", onclick: () => file.click(), text: "Subir imágenes…" }),
      file,
    ),
    h("p", { class: "hint", text: "PNG, GIF (animados también), WebP o JPG, hasta 10 MB. Arrastrá archivos acá o a cada casillero." }),
    S.libraryMsg ? h("p", { class: "msg tone-warn", text: S.libraryMsg }) : null,
    h("div", { class: "assets" }, S.assets.map((a) => h("figure", { class: "asset" },
      h("img", { src: assetUrl(a.name), alt: "", loading: "lazy" }),
      h("figcaption", {}, h("span", { class: "asset-name", text: a.name, title: a.name }), h("span", { class: "hint", text: fmtSize(a.size) })),
      h("button", { type: "button", class: "danger small", onclick: () => del(a.name), text: "Borrar" }),
    ))),
  );
  dropTarget(box, uploadMany);
  return box;
}

function renderUsers() {
  return [
    h("div", { class: "card" },
      h("div", { class: "row-between", "data-path": "users" },
        h("h2", { text: `Usuarios (${S.draft.users.length})` }),
        h("div", { class: "actions" },
          h("button", { type: "button", onclick: () => change((d) => void d.users.push(newUser())), text: "+ Agregar usuario" }),
          h("button", { type: "button", class: S.showCallPicker ? "active" : "", onclick: () => ((S.showCallPicker = !S.showCallPicker), render()), text: "Agregar desde la llamada" }),
        ),
      ),
      h("p", { class: "hint", text: "El ID de Discord se copia con clic derecho sobre la persona › Copiar ID de usuario (activá el Modo desarrollador en Ajustes › Avanzado). Sin imágenes propias se usa el avatar de Discord." }),
    ),
    S.showCallPicker ? callPicker() : null,
    S.draft.users.length ? S.draft.users.map(userCard) : h("p", { class: "empty", text: "Todavía no hay usuarios. Agregalos a mano o desde la llamada." }),
    library(),
  ];
}

// ---------------------------------------------------------------- Presets tab

function presetUsers() {
  const pr = preset();
  const i = S.presetIdx;
  const users = new Map(S.draft.users.map((u) => [u.id, u]));
  const available = S.draft.users.filter((u) => u.id && !pr.users.includes(u.id));
  const add = h("select", { "aria-label": "Agregar usuario al preset" },
    h("option", { value: "", text: "+ Agregar usuario…" }),
    available.map((u) => h("option", { value: u.id, text: u.displayName || u.id })),
  );
  add.addEventListener("change", () => add.value && change((d) => void d.presets[i].users.push(add.value)));
  const hint = pr.mode === "slots"
    ? "Modo slots: un casillero fijo por usuario en este orden (si la lista está vacía, todos los usuarios). Los ausentes muestran el texto offline."
    : "Modo reactivo: muestra a quien esté en la llamada. Los de esta lista van primero, en este orden.";
  return h("div", { class: "field wide", "data-path": `presets[${i}].users` },
    h("label", { text: "Usuarios y orden" }),
    h("ol", { class: "order" }, pr.users.map((id, j) => h("li", {},
      h("span", { text: users.get(id)?.displayName || id }),
      h("span", { class: "spacer" }),
      h("button", { type: "button", class: "icon", title: "Subir", disabled: j === 0, onclick: () => change((d) => void (d.presets[i].users = moveItem(d.presets[i].users, j, -1))), text: "▲" }),
      h("button", { type: "button", class: "icon", title: "Bajar", disabled: j === pr.users.length - 1, onclick: () => change((d) => void (d.presets[i].users = moveItem(d.presets[i].users, j, 1))), text: "▼" }),
      h("button", { type: "button", class: "icon danger", title: "Sacar del preset", onclick: () => change((d) => void d.presets[i].users.splice(j, 1)), text: "✕" }),
    ))),
    available.length ? add : null,
    h("small", { class: "hint", text: hint }),
  );
}

function urlRow(label, url) {
  return h("div", { class: "url-row" },
    h("span", { class: "url-label", text: label }),
    h("input", { type: "text", readonly: true, value: url, onfocus: (e) => e.target.select() }),
    h("button", { type: "button", class: "small", onclick: () => copyText(url), text: "Copiar" }),
  );
}

function presetUrls(pr, saved) {
  const base = `${location.origin}/overlay/${encodeURIComponent(pr.id)}`;
  return h("div", { class: "urls", id: "preset-urls" },
    urlRow("OBS", base),
    urlRow("Demo", `${base}?demo=1`),
    h("small", { class: "hint", text: `En OBS: Fuente › Navegador, pegá la URL y poné el ancho y alto del lienzo (ej. 1920×1080).${saved ? "" : " Guardá primero para que la URL funcione."}` }),
  );
}

function renderPresets() {
  const pr = preset();
  const i = S.presetIdx;
  const saved = S.base.presets.some((p) => p.id === pr.id);
  const errorCount = (k) => S.errors.summary.filter((e) => e.path.startsWith(`presets[${k}]`)).length;
  const urls = presetUrls(pr, saved);
  const onName = (v) => {
    S.draft.presets[i].name = v;
    if (!S.base.presets.some((p) => p.id === S.draft.presets[i].id)) {
      S.draft.presets[i].id = uniquePresetId(v, S.draft.presets.filter((_, k) => k !== i).map((p) => p.id));
      $("#preset-id").textContent = S.draft.presets[i].id;
      $("#preset-urls").replaceWith(presetUrls(S.draft.presets[i], false));
    }
    const chip = document.querySelector(`[data-preset="${i}"] .chip-name`);
    if (chip) chip.textContent = v || "(sin nombre)";
    fillPresetSelect();
  };
  return [
    h("div", { class: "card" },
      h("div", { class: "row-between", "data-path": "presets" },
        h("h2", { text: "Presets" }),
        h("div", { class: "actions" },
          h("button", { type: "button", onclick: () => change((d) => {
            const id = uniquePresetId("Nuevo", d.presets.map((p) => p.id));
            d.presets.push(newPreset(id, "Nuevo"));
            S.presetIdx = d.presets.length - 1;
          }), text: "+ Nuevo" }),
          h("button", { type: "button", onclick: () => change((d) => { S.presetIdx = i + 1; return duplicatePreset(d, i); }), text: "Duplicar" }),
          h("button", { type: "button", class: "danger", disabled: S.draft.presets.length <= 1, onclick: () => confirm(`¿Borrar el preset «${pr.name}»?`) && change((d) => deletePreset(d, i)), text: "Borrar" }),
        ),
      ),
      h("div", { class: "chips" }, S.draft.presets.map((p, k) => h("button", {
        type: "button", class: `chip${k === i ? " active" : ""}`, "data-preset": k,
        onclick: () => { S.presetIdx = k; render(); },
      }, h("span", { class: "chip-name", text: p.name || "(sin nombre)" }), errorCount(k) ? h("span", { class: "badge tone-bad", text: errorCount(k) }) : null))),
    ),
    h("div", { class: "card" },
      h("div", { class: "grid2" },
        textField(`presets[${i}].name`, "Nombre", { max: 40, onInput: onName }),
        h("div", { class: "field", "data-path": `presets[${i}].id` }, h("label", { text: "ID (va en la URL)" }), h("code", { id: "preset-id", class: "id", text: pr.id }), h("small", { class: "hint", text: saved ? "Fijo una vez guardado, para no romper la URL en OBS." : "Se arma solo a partir del nombre." })),
        selectField(`presets[${i}].mode`, PRESET_LABELS.mode, [{ value: "reactive", label: "Reactivo (quien esté en la llamada)" }, { value: "slots", label: "Slots fijos por usuario" }], { onChange: () => change(() => null) }),
        selectField(`presets[${i}].theme`, PRESET_LABELS.theme, [{ value: "pixel-cafe", label: "Pixel café" }, { value: "clean", label: "Clean (neutro)" }]),
        pr.mode === "reactive" ? boolField(`presets[${i}].showUnlisted`, "Mostrar también a quienes no están en la lista") : null,
        presetUsers(),
      ),
      urls,
    ),
    h("details", { class: "card", open: true }, h("summary", { text: "Disposición" }), h("div", { class: "grid2", "data-path": `presets[${i}].layout` }, Object.keys(FIELDS.layout).map((k) => schemaField("layout", k)))),
    h("details", { class: "card", open: true }, h("summary", { text: "Estilo" }), h("div", { class: "grid2", "data-path": `presets[${i}].style` }, Object.keys(FIELDS.style).map((k) => schemaField("style", k)))),
  ];
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
  frame.contentWindow.postMessage({ type: "preview", presetId: "preview", config, voice: previewVoice() }, location.origin);
  const v = previewVoice();
  $("#pv-caption").textContent = `${preset().name || preset().id} · ${S.canvas.replace("x", "×")} · ${S.sim.source === "live" ? (S.voice?.channel ? `llamada real: ${v.members.length} en ${S.voice.channel.name}` : "llamada real: sin canal") : "simulación"}`;
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
  const [w, hgt] = S.canvas.split("x").map(Number);
  const aside = stage.parentElement;
  const avail = aside.clientWidth - 2 * 12;
  const maxH = Math.max(240, window.innerHeight * (hgt > w ? 0.62 : 0.5));
  const scale = Math.min(avail / w, maxH / hgt);
  stage.style.width = `${Math.floor(w * scale)}px`;
  stage.style.height = `${Math.floor(hgt * scale)}px`;
  frame.style.width = `${w}px`;
  frame.style.height = `${hgt}px`;
  frame.style.transform = `scale(${scale})`;
}
new ResizeObserver(layoutPreview).observe(stage.parentElement);
window.addEventListener("resize", layoutPreview);

$("#pv-canvas").addEventListener("change", (e) => {
  S.canvas = e.target.value;
  layoutPreview();
  schedulePreview();
});
$("#pv-bg").addEventListener("change", (e) => {
  stage.className = `stage bg-${e.target.value}`;
});
$("#pv-preset").addEventListener("change", (e) => {
  S.presetIdx = Number(e.target.value);
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
  sel.replaceChildren(...S.draft.presets.map((p, k) => h("option", { value: k, text: p.name || p.id || `Preset ${k + 1}` })));
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
    body.replaceChildren(h("p", { class: "hint", text: v?.channel ? `Mostrando la llamada real: ${v.members.length} en «${v.channel.name}».` : "Sin llamada activa: la vista previa queda vacía en modo reactivo." }));
    return;
  }
  if (S.sim.mode === "rotate" && !rotateTimer) setSimMode("rotate");
  const modeBtn = (mode, label, title) => h("button", { type: "button", class: `small${S.sim.mode === mode ? " active" : ""}`, title, onclick: () => setSimMode(mode), text: label });
  const rows = S.draft.users.map((u) => {
    const cur = S.sim.states[u.id] ?? "idle";
    return h("div", { class: "sim-row" },
      h("span", { class: "sim-name", text: u.displayName || u.id || "(sin ID)" }),
      h("div", { class: "seg small" }, SIM_STATES.map((s) => h("button", {
        type: "button", class: S.sim.mode === "manual" && cur === s.value ? "active" : "", text: s.label,
        onclick: () => {
          S.sim.states[u.id] = s.value;
          setSimMode("manual");
        },
      }))),
    );
  });
  body.replaceChildren(
    h("div", { class: "actions" },
      modeBtn("all", "Todos hablando", "Todos los usuarios (o invitados) hablando a la vez"),
      modeBtn("rotate", "Rotar", "Cambia quién habla cada 1,4 s"),
      modeBtn("static", "Estados", "Uno hablando, uno callado, uno muteado y uno sordo"),
      modeBtn("manual", "Manual", "Usá los botones de cada usuario"),
    ),
    rows.length ? h("div", { class: "sim-rows" }, rows) : h("p", { class: "hint", text: "Agregá usuarios para simular cada uno; mientras tanto usá Rotar o Estados (con invitados de ejemplo)." }),
  );
}

// ---------------------------------------------------------------- render + routing

function render() {
  if (!S.draft) return;
  document.querySelectorAll(".tabs a").forEach((a) => {
    a.classList.toggle("active", a.dataset.tab === S.tab);
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
  schedulePreview();
}

function renderConn() {
  const st = statusText(S.status);
  const c = $("#conn");
  c.className = `pill tone-${st.tone}`;
  c.textContent = S.voice?.channel && S.status?.state === "ready" ? `${st.text} · ${S.voice.channel.name} (${S.voice.members.length})` : st.text;
}

function setTab(tab) {
  const next = TABS.includes(tab) ? tab : "discord";
  if (next !== S.tab) $("#panel").scrollTop = 0;
  S.tab = next;
  render();
}
window.addEventListener("hashchange", () => setTab(location.hash.slice(1)));

$("#save").addEventListener("click", save);
$("#discard").addEventListener("click", () => (!dirty() || confirm("¿Descartar los cambios sin guardar?")) && discard());
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    save();
  }
});
window.addEventListener("beforeunload", (e) => {
  if (dirty()) e.preventDefault();
});

// ---------------------------------------------------------------- live connection

function onMessage(msg) {
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
  render();
  connect();
}
start();
