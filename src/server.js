// Local HTTP + WebSocket server. Loopback only; every request must carry a local Host,
// every mutation a same-origin Origin, so web pages cannot drive or read it.
import http from "node:http";
import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { readFile, writeFile, readdir, stat, unlink, mkdir } from "node:fs/promises";
import path from "node:path";
import { WebSocketServer } from "ws";
import { IMAGE_NAME, InvalidConfigError, validateConfig } from "./config.js";

const MAX_JSON = 1024 * 1024;
const MAX_IMAGE = 10 * 1024 * 1024;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
};

function isImage(buf) {
  const ascii = (a, b) => buf.subarray(a, b).toString("latin1");
  if (buf.length < 12) return false;
  if (buf[0] === 0x89 && ascii(1, 4) === "PNG") return true;
  if (ascii(0, 4) === "GIF8") return true;
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return true;
  return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

export function sanitizeImageName(raw) {
  const ext = path.extname(String(raw)).toLowerCase();
  if (![".png", ".gif", ".webp", ".jpg", ".jpeg"].includes(ext)) return null;
  const stem = path
    .basename(String(raw), path.extname(String(raw)))
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${stem || "image"}${ext}`;
}

class HttpError extends Error {
  constructor(status, body) {
    super(typeof body === "string" ? body : JSON.stringify(body));
    this.status = status;
    this.body = typeof body === "string" ? { error: body } : body;
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] || 0);
    if (declared > limit) {
      reject(new HttpError(413, "payload too large"));
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, "payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req) {
  if (!String(req.headers["content-type"] || "").startsWith("application/json")) {
    throw new HttpError(415, "expected application/json");
  }
  try {
    return JSON.parse((await readBody(req, MAX_JSON)).toString("utf8"));
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, "invalid JSON");
  }
}

function send(res, status, body, headers = {}) {
  const isJson = body !== undefined && !Buffer.isBuffer(body) && typeof body !== "string";
  res.writeHead(status, {
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    ...(isJson ? { "Content-Type": "application/json; charset=utf-8" } : {}),
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

/** Resolve a URL path inside root, or null when it escapes or is malformed. */
function safeJoin(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const full = path.resolve(root, "." + path.posix.normalize("/" + decoded.replace(/\\/g, "/")));
  const rel = path.relative(root, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return full;
}

async function serveFile(res, file) {
  try {
    const info = await stat(file);
    if (!info.isFile()) return false;
    const type = TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
    // Only our own editor may frame our pages (it embeds the overlay preview).
    const frame = type.startsWith("text/html") ? { "Content-Security-Policy": "frame-ancestors 'self'" } : {};
    send(res, 200, await readFile(file), { "Content-Type": type, ...frame });
    return true;
  } catch {
    return false;
  }
}

// Folders whose files make up the running overlay page. Their content hash is the overlay "build":
// an open OBS source reloads itself when it changes, so app updates need no "Refresh cache of current page".
const OVERLAY_DIRS = ["overlay", "shared"];

/** Short content hash of the overlay files (missing folders count as empty). */
export async function overlayBuild(publicDir) {
  const hash = createHash("sha1");
  for (const dir of OVERLAY_DIRS) {
    let names = [];
    try {
      names = (await readdir(path.join(publicDir, dir))).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        const body = await readFile(path.join(publicDir, dir, name));
        hash.update(`${dir}/${name}\0`).update(body).update("\0");
      } catch {
        // subfolder or file removed while hashing: skip
      }
    }
  }
  return hash.digest("hex").slice(0, 12);
}

export async function startServer({ port = 7429, host = "127.0.0.1", dataDir, publicDir, config, secrets, discord }) {
  const assetsDir = path.join(dataDir, "assets");
  await mkdir(assetsDir, { recursive: true });
  let allowedHosts = new Set();
  let allowedOrigins = new Set();

  const wss = new WebSocketServer({ noServer: true });
  const broadcast = (msg) => {
    const data = JSON.stringify(msg);
    for (const c of wss.clients) if (c.readyState === 1) c.send(data);
  };
  // Result of the startup update check (src/update.js), shown by the editor.
  let update = { state: "checking" };
  let build = await overlayBuild(publicDir);
  let buildTimer = null;
  const recheckBuild = () => {
    clearTimeout(buildTimer);
    // Editors and git write files in bursts: wait for the burst to end, then compare content.
    buildTimer = setTimeout(async () => {
      const next = await overlayBuild(publicDir);
      if (next === build) return;
      build = next;
      broadcast({ type: "build", build });
    }, 300);
  };
  const watchers = [];
  for (const dir of OVERLAY_DIRS) {
    try {
      const w = watch(path.join(publicDir, dir), recheckBuild);
      w.on("error", () => {});
      watchers.push(w);
    } catch {
      // folder missing or watching unsupported: a server restart still reloads overlays via hello
    }
  }
  const onVoice = (voice) => broadcast({ type: "voice", voice });
  const onStatus = (status) => broadcast({ type: "status", status });
  discord.on("state", onVoice);
  discord.on("status", onStatus);

  async function listAssets() {
    const names = (await readdir(assetsDir)).filter((n) => IMAGE_NAME.test(n)).sort();
    return Promise.all(names.map(async (name) => ({ name, size: (await stat(path.join(assetsDir, name))).size })));
  }

  async function uniqueName(name) {
    const existing = new Set(await readdir(assetsDir));
    if (!existing.has(name)) return name;
    const ext = path.extname(name);
    const stem = name.slice(0, -ext.length);
    for (let i = 2; ; i++) {
      const candidate = `${stem}-${i}${ext}`;
      if (!existing.has(candidate)) return candidate;
    }
  }

  async function saveConfig(next) {
    try {
      const saved = await config.save(next);
      broadcast({ type: "config", config: saved });
      return saved;
    } catch (err) {
      if (err instanceof InvalidConfigError) throw new HttpError(400, { errors: err.errors });
      throw err;
    }
  }

  async function discordView() {
    return { clientId: config.current.discord.clientId, ...(await secrets.status()), status: discord.status };
  }

  async function api(req, res, url) {
    const route = `${req.method} ${url.pathname}`;
    if (route === "GET /api/config") return send(res, 200, config.current);
    if (route === "PUT /api/config") return send(res, 200, await saveConfig(await readJson(req)));
    if (route === "GET /api/assets") return send(res, 200, await listAssets());
    if (route === "POST /api/assets") {
      const name = sanitizeImageName(url.searchParams.get("name") || "");
      if (!name) throw new HttpError(400, "only PNG, GIF, WebP or JPG images");
      const buf = await readBody(req, MAX_IMAGE);
      if (!isImage(buf)) throw new HttpError(400, "file is not a PNG, GIF, WebP or JPG image");
      const finalName = await uniqueName(name);
      await writeFile(path.join(assetsDir, finalName), buf, { flag: "wx" });
      return send(res, 201, { name: finalName });
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/api/assets/")) {
      const name = url.pathname.slice("/api/assets/".length);
      if (!IMAGE_NAME.test(name)) throw new HttpError(404, "not found");
      const users = config.current.users.filter((u) => Object.values(u.images).includes(name)).map((u) => u.displayName || u.id);
      if (users.length) throw new HttpError(409, { error: "image in use", users });
      try {
        await unlink(path.join(assetsDir, name));
      } catch {
        throw new HttpError(404, "not found");
      }
      return send(res, 204);
    }
    if (route === "GET /api/discord") return send(res, 200, await discordView());
    if (route === "PUT /api/discord") {
      const body = await readJson(req);
      const clientId = typeof body?.clientId === "string" ? body.clientId.trim() : "";
      const next = structuredClone(config.current);
      next.discord.clientId = clientId;
      if (!validateConfig(next).ok || !clientId) throw new HttpError(400, "clientId must be your Discord application id (17-20 digits)");
      const changedApp = clientId !== config.current.discord.clientId;
      const current = await secrets.read();
      const secret = typeof body.clientSecret === "string" ? body.clientSecret.trim() : "";
      const updated = { ...current };
      if (secret) updated.clientSecret = secret;
      if (changedApp || secret) delete updated.token;
      await secrets.write(updated);
      await saveConfig(next);
      discord.restart(clientId);
      return send(res, 200, await discordView());
    }
    if (route === "POST /api/discord/logout") {
      const current = await secrets.read();
      delete current.token;
      await secrets.write(current);
      discord.restart(config.current.discord.clientId);
      return send(res, 200, await discordView());
    }
    throw new HttpError(404, "not found");
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://local");
    if (!allowedHosts.has(String(req.headers.host || "").toLowerCase())) throw new HttpError(403, "forbidden host");
    if (req.method !== "GET" && req.method !== "HEAD") {
      if (!allowedOrigins.has(String(req.headers.origin || "").toLowerCase())) throw new HttpError(403, "forbidden origin");
    }
    if (url.pathname.startsWith("/api/")) return api(req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "method not allowed");

    if (url.pathname === "/") return send(res, 302, "", { Location: "/editor/" });
    if (url.pathname.startsWith("/assets/")) {
      const name = url.pathname.slice("/assets/".length);
      if (IMAGE_NAME.test(name) && (await serveFile(res, path.join(assetsDir, name)))) return;
      throw new HttpError(404, "not found");
    }
    // /overlay/<preset> renders the same page; the preset id is read client-side.
    if (/^\/overlay\/[a-z0-9-]*$/.test(url.pathname)) {
      if (await serveFile(res, path.join(publicDir, "overlay", "index.html"))) return;
    }
    let p = url.pathname;
    if (p.endsWith("/")) p += "index.html";
    const file = safeJoin(publicDir, p);
    if (file && (await serveFile(res, file))) return;
    throw new HttpError(404, "not found");
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) return res.destroy();
      if (err instanceof HttpError) send(res, err.status, err.body);
      else {
        console.error("[server]", err);
        send(res, 500, { error: "internal error" });
      }
    });
  });

  server.on("upgrade", (req, socket, head) => {
    // A peer can reset the raw socket at any time; without a listener that crashes the process.
    socket.on("error", () => socket.destroy());
    const url = new URL(req.url, "http://local");
    const hostOk = allowedHosts.has(String(req.headers.host || "").toLowerCase());
    const origin = req.headers.origin ? String(req.headers.origin).toLowerCase() : null;
    // OBS browser sources load our own pages, so a browser always sends our origin.
    if (url.pathname !== "/ws" || !hostOk || (origin !== null && !allowedOrigins.has(origin))) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send(JSON.stringify({ type: "hello", build, update, config: config.current, status: discord.status, voice: discord.snapshot() }));
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const actual = server.address().port;
  allowedHosts = new Set([`127.0.0.1:${actual}`, `localhost:${actual}`]);
  allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`));

  return {
    url: `http://127.0.0.1:${actual}`,
    port: actual,
    broadcast,
    setUpdate(next) {
      update = next;
      broadcast({ type: "update", update });
    },
    close: () =>
      new Promise((resolve) => {
        discord.off("state", onVoice);
        discord.off("status", onStatus);
        clearTimeout(buildTimer);
        for (const w of watchers) w.close();
        for (const c of wss.clients) c.terminate();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
