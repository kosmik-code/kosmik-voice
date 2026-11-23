// Pure tile model shared by the overlay and the editor preview (and node tests).
// Input: validated config, one preset, a voice snapshot { members: [...] }.
// Output: ordered tiles with the state and image the overlay should draw.

const asset = (name) => (name ? `/assets/${encodeURIComponent(name)}` : "");

function stateOf(m) {
  if (!m) return "offline";
  if (m.deafened) return "deafened";
  if (m.muted) return "muted";
  return m.speaking ? "talking" : "idle";
}

function pickImage(images, state, avatar) {
  const order = {
    offline: [images.idle],
    idle: [images.idle],
    talking: [images.talking, images.idle],
    muted: [images.muted, images.idle],
    deafened: [images.deafened, images.muted, images.idle],
  }[state];
  const name = order.find(Boolean);
  return name ? asset(name) : avatar || null;
}

const EMPTY_IMAGES = { idle: "", talking: "", muted: "", deafened: "" };

function tile(user, member, slotIndex, style) {
  const state = stateOf(member);
  const images = user?.images ?? EMPTY_IMAGES;
  return {
    id: user?.id ?? member.id,
    state,
    name: user?.displayName || member?.name || `Slot ${slotIndex + 1}`,
    role: user?.role || "",
    roleColor: user?.roleColor || "",
    image: pickImage(images, state, member?.avatarUrl),
    hidden: Boolean(style?.hideWhenSilent) && state !== "talking",
  };
}

export function buildTiles(config, preset, voice) {
  const members = voice?.members ?? [];
  const byId = new Map(members.map((m) => [m.id, m]));
  const users = new Map((config?.users ?? []).map((u) => [u.id, u]));
  const style = preset?.style;

  if (preset?.mode === "slots") {
    const ids = preset.users?.length ? preset.users : [...users.keys()];
    return ids.map((id, i) => tile(users.get(id), byId.get(id), i, style));
  }

  const listed = preset?.users ?? [];
  const ordered = listed.filter((id) => byId.has(id)).map((id) => byId.get(id));
  if (!listed.length || preset.showUnlisted) {
    for (const m of members) if (!listed.includes(m.id)) ordered.push(m);
  }
  return ordered.map((m, i) => tile(users.get(m.id), m, i, style));
}

export function findPreset(config, id) {
  return config?.presets?.find((p) => p.id === id) ?? null;
}

const DEMO_COLORS = ["#6fc2b0", "#e98a9b", "#ffcf8b", "#b79cff", "#7b4a6e", "#9a6a4f"];

function demoAvatar(i, label) {
  const letter = (label || "?").trim().charAt(0).toUpperCase() || "?";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges"><rect width="16" height="16" fill="${DEMO_COLORS[i % DEMO_COLORS.length]}"/><text x="8" y="12" font-family="Consolas,monospace" font-weight="700" font-size="10" text-anchor="middle" fill="#100f1c">${letter.replace(/[<&"]/g, "")}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * Fake voice snapshot to position the overlay without a call.
 * tick = number: everyone present, speaker rotates. tick = "static": talking, idle, muted, deafened, then absent.
 * labels: names for sample guests and unnamed users (the editor passes them in its own language).
 */
export function demoVoice(config, preset, tick, labels = { guest: (n) => `Guest ${n}`, user: (n) => `User ${n}` }) {
  const users = config?.users ?? [];
  let ids = preset?.users?.length ? [...preset.users] : users.map((u) => u.id);
  const names = new Map(users.map((u) => [u.id, u.displayName]));
  // Reactive previews pad with guests; slots show exactly the configured slots.
  if (preset?.mode !== "slots") for (let n = 1; ids.length < 4; n++) ids.push(`demo-${n}`);
  if (tick === "static") ids = ids.slice(0, 4);
  const members = ids.map((id, i) => {
    const name = names.get(id) || (id.startsWith("demo-") ? labels.guest(id.slice(5)) : labels.user(i + 1));
    const s = tick === "static" ? i : -1;
    return {
      id,
      name,
      avatarUrl: demoAvatar(i, name),
      speaking: tick === "static" ? s === 0 : i === Number(tick) % ids.length,
      muted: s === 2,
      deafened: s === 3,
    };
  });
  return { channel: { id: "demo", name: "Demo", guildId: null }, members };
}

/** How many people a box-placed preset is sized for: every slot, or the preset's "room for" count. */
export function boxCount(config, preset) {
  if (preset?.mode === "slots") return Math.max(1, preset.users?.length || config?.users?.length || 1);
  return Math.max(1, preset?.layout?.room ?? 4);
}

/**
 * Box placement: the browser source is only as big as its people need, so it can be moved and resized in OBS
 * (by hand, or per game by Kosmik Layouts). Returns the source size to type in OBS, the grid columns and the
 * bleed: transparent room around the tiles for names wider than a tile, glows, badges and the talk bounce.
 * Generous on purpose; the overlay also shrinks the people to fit if a theme needs more.
 */
export function boxLayout(config, preset) {
  const l = preset?.layout ?? {};
  const s = preset?.style ?? {};
  const size = l.size ?? 160;
  const gap = l.gap ?? 24;
  const padding = l.padding ?? 24;
  const n = boxCount(config, preset);
  const cols = l.direction === "column" ? 1 : l.direction === "grid" ? Math.min(n, l.columns ?? 4) : n;
  const rows = Math.ceil(n / cols);
  const frameW = Math.max(3, Math.round(size / 26));
  const nameH = s.showNames === false ? 0 : Math.ceil((s.nameSize ?? 22) * 1.3 + 8 + frameW + 24);
  const bleed = Math.ceil(Math.max(24, size * 0.12));
  const edge = 2 * (padding + bleed);
  const even = (v) => Math.ceil(v / 2) * 2;
  return {
    count: n,
    cols,
    bleed,
    width: even(cols * size + (cols - 1) * gap + edge),
    height: even(rows * (size + nameH) + (rows - 1) * gap + edge),
  };
}
