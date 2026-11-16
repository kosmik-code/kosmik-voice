// Overlay renderer. Live mode: /overlay/<preset> connects to /ws.
// Preview mode (?preview=1, inside the editor iframe): data arrives by postMessage from the same origin.
import { buildTiles, findPreset, demoVoice } from "/shared/model.js";

const params = new URLSearchParams(location.search);
let presetId = decodeURIComponent(location.pathname.split("/")[2] || "") || params.get("preset") || "main";
const preview = params.get("preview") === "1";
const debug = params.get("debug") === "1";
// ?demo=1 rotates a fake speaker over the configured users; ?demo=static freezes every state.
const demo = params.get("demo");
let demoTick = 0;
// ?bg=busy (colourful test pattern) or ?bg=404850 (hex) paints a backdrop to judge legibility; OBS never needs it.
const bg = params.get("bg");
if (bg === "busy") {
  document.body.style.background =
    "repeating-linear-gradient(45deg, rgba(255,255,255,0.25) 0 40px, transparent 40px 80px), linear-gradient(90deg, #ff4d6d, #ffd23f, #3ddc97, #2fb7ff, #9b5de5, #fff1e6)";
} else if (bg && /^[0-9a-f]{6}$/i.test(bg)) {
  document.body.style.background = `#${bg}`;
}

const stage = document.getElementById("stage");
const list = document.getElementById("tiles");
const debugBox = document.getElementById("debug");

const ICON_MIC_OFF =
  '<svg viewBox="0 0 16 16" shape-rendering="crispEdges" fill="currentColor"><path d="M6 1h4v1h1v6h-1v1H6V8H5V2h1zM3 6h1v2h1v1h1v1h4V9h1V8h1V6h1v2h-1v1h-1v1h-1v1H9v2h2v1H5v-1h2v-2H6v-1H5v-1H4V9H3z"/><path d="M1 1h2v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v2h-2v-1h-1v-1h-1v-1h-1v-1h-1v-1H9V9H8V8H7V7H6V6H5V5H4V4H3V3H2V2H1z"/></svg>';
const ICON_DEAF =
  '<svg viewBox="0 0 16 16" shape-rendering="crispEdges" fill="currentColor"><path d="M5 2h6v1h1v1h1v2h1v6h-3V8h2V6h-1V4h-1V3H5v1H4v2H3v2h2v4H2V6h1V4h1V3h1z"/><path d="M1 1h2v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v2h-2v-1h-1v-1h-1v-1h-1v-1h-1v-1H9V9H8V8H7V7H6V6H5V5H4V4H3V3H2V2H1z"/></svg>';

let state = { config: null, voice: { channel: null, members: [] }, status: null };
const nodes = new Map();

function applyPreset(p) {
  const { layout: l, style: s } = p;
  const radius = { square: "0px", rounded: `${Math.round(l.size * 0.16)}px`, circle: "50%" }[s.shape];
  const vars = {
    "--size": `${l.size}px`, "--gap": `${l.gap}px`, "--pad": `${l.padding}px`, "--cols": l.columns,
    "--talk": s.talkColor, "--idle-dim": s.idleDim, "--mute-dim": s.muteDim,
    "--name-size": `${s.nameSize}px`, "--radius": radius,
    "--frame-w": `${Math.max(3, Math.round(l.size / 26))}px`,
  };
  for (const [k, v] of Object.entries(vars)) stage.style.setProperty(k, String(v));
  stage.style.transform = l.offsetX || l.offsetY ? `translate(${l.offsetX}px, ${l.offsetY}px)` : "";
  stage.className = [
    `theme-${p.theme}`, `shape-${s.shape}`, `dir-${l.direction}`, `ax-${l.alignX}`, `ay-${l.alignY}`,
    s.frame ? "has-frame" : "", s.talkGlow ? "" : "no-glow",
    s.showNames ? "" : "no-names", s.showRoles ? "" : "no-roles", s.showMuteIcon ? "" : "no-mute-icon",
  ].filter(Boolean).join(" ");
}

function makeNode() {
  const el = document.createElement("div");
  el.className = "tile";
  el.innerHTML = '<div class="box"><img alt=""><div class="ph"></div><div class="mute"></div><div class="role"></div></div><div class="name"></div>';
  const img = el.querySelector("img");
  img.addEventListener("error", () => {
    img.hidden = true;
  });
  return el;
}

function render() {
  const preset = findPreset(state.config, presetId);
  if (!preset) {
    list.replaceChildren();
    showDebug(`preset "${presetId}" not found`);
    return;
  }
  applyPreset(preset);
  const voice = demo ? demoVoice(state.config, preset, demo === "static" ? "static" : demoTick) : state.voice;
  const tiles = buildTiles(state.config, preset, voice);
  const seen = new Set();
  const ordered = tiles.map((t) => {
    seen.add(t.id);
    let el = nodes.get(t.id);
    if (!el) {
      el = makeNode();
      nodes.set(t.id, el);
    }
    el.dataset.state = t.state;
    const asset = Boolean(t.image?.startsWith("/assets/"));
    // has-asset: custom image (maybe a transparent cut-out); themes can outline its alpha instead of the box.
    el.className = `tile anim-${preset.style.talkAnimation}${t.hidden ? " is-hidden" : ""}${asset ? " has-asset" : ""}`;
    const img = el.querySelector("img");
    if (t.image) {
      // Only touch src when it changes so GIFs keep playing and nothing flickers.
      if (img.getAttribute("src") !== t.image) {
        img.hidden = false;
        img.setAttribute("src", t.image);
      }
      img.classList.toggle("is-asset", asset);
    } else {
      img.removeAttribute("src");
      img.hidden = true;
    }
    el.querySelector(".ph").textContent = preset.style.offlineText;
    el.querySelector(".mute").innerHTML = t.state === "deafened" ? ICON_DEAF : t.state === "muted" ? ICON_MIC_OFF : "";
    const role = el.querySelector(".role");
    role.textContent = t.role;
    role.style.setProperty("--role-bg", t.roleColor || "");
    if (!t.roleColor) role.style.removeProperty("--role-bg");
    el.querySelector(".name").textContent = t.name;
    return el;
  });
  for (const [id, el] of nodes) if (!seen.has(id)) nodes.delete(id) && el.remove();
  // Reorder without recreating nodes.
  ordered.forEach((el, i) => {
    if (list.children[i] !== el) list.insertBefore(el, list.children[i] ?? null);
  });
  showDebug();
}

function showDebug(extra = "") {
  if (!debug) return;
  debugBox.hidden = false;
  const s = state.status ? `${state.status.state}${state.status.message ? ` (${state.status.message})` : ""}` : "no server";
  const ch = state.voice?.channel ? `#${state.voice.channel.name} · ${state.voice.members.length}` : "no channel";
  debugBox.textContent = `${presetId} · ${s} · ${ch}${extra ? ` · ${extra}` : ""}`;
}

function onMessage(msg) {
  if (msg.type === "hello") state = { config: msg.config, voice: msg.voice, status: msg.status };
  else if (msg.type === "config") state.config = msg.config;
  else if (msg.type === "voice") state.voice = msg.voice;
  else if (msg.type === "status") state.status = msg.status;
  else return;
  render();
}

function connect() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  ws.onclose = () => {
    state.status = null;
    showDebug("reconnecting");
    setTimeout(connect, 2000);
  };
}

if (preview) {
  window.addEventListener("message", (e) => {
    if (e.origin !== location.origin || e.data?.type !== "preview") return;
    if (e.data.presetId) presetId = e.data.presetId;
    state = { config: e.data.config, voice: e.data.voice, status: { state: "preview", message: "" } };
    render();
  });
  window.parent.postMessage({ type: "preview-ready" }, location.origin);
} else {
  connect();
  if (demo && demo !== "static") {
    setInterval(() => {
      demoTick++;
      if (state.config) render();
    }, 1400);
  }
}
