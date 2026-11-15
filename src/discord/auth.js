// OAuth for Discord local RPC. The streamer's own Discord application is used;
// as its owner they are an allowed RPC tester. Secrets stay in data/secrets.json.
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";

export const SCOPES = ["rpc", "rpc.voice.read", "identify"];
const TOKEN_URL = "https://discord.com/api/oauth2/token";
const DEFAULT_REDIRECT = "http://127.0.0.1";

export class SecretStore {
  constructor(dataDir) {
    this.dir = dataDir;
    this.file = path.join(dataDir, "secrets.json");
  }

  async read() {
    try {
      const data = JSON.parse(await readFile(this.file, "utf8"));
      return data && typeof data === "object" ? data : {};
    } catch {
      return {};
    }
  }

  async write(data) {
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    await rename(tmp, this.file);
  }

  async update(patch) {
    const next = { ...(await this.read()), ...patch };
    await this.write(next);
    return next;
  }

  /** Public view: never returns the secret or tokens themselves. */
  async status() {
    const s = await this.read();
    return { hasClientSecret: Boolean(s.clientSecret), hasToken: Boolean(s.token?.accessToken) };
  }
}

function setupError(message) {
  return Object.assign(new Error(message), { code: "SETUP_REQUIRED" });
}

async function tokenRequest(fetch, form) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  let body = {};
  try {
    body = await res.json();
  } catch {
    // keep empty body
  }
  if (!res.ok || !body.access_token) {
    const reason = body.error_description || body.error || `HTTP ${res.status}`;
    throw Object.assign(new Error(`Discord token request failed: ${reason}`), { code: "TOKEN_FAILED" });
  }
  return body;
}

function toToken(body, now) {
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? "",
    expiresAt: now() + (Number(body.expires_in) || 0) * 1000,
  };
}

/**
 * Authenticate the IPC connection. Order: saved token -> refresh -> interactive AUTHORIZE.
 * A rejected saved token falls back to AUTHORIZE once.
 */
export async function authenticate({ ipc, clientId, store, fetch = globalThis.fetch, now = Date.now }) {
  const secrets = await store.read();
  if (!secrets.clientSecret) {
    throw setupError("Missing Discord client secret: paste it in the editor (Discord tab).");
  }
  const base = { client_id: clientId, client_secret: secrets.clientSecret };
  const redirect = secrets.redirectUri || DEFAULT_REDIRECT;

  const saveToken = async (token) => {
    await store.update({ token });
    return token;
  };

  const interactive = async () => {
    // Discord rejects AUTHORIZE without redirect_uri ("Missing redirect_uri") and requires the
    // same value, registered under OAuth2 > Redirects, in the token exchange.
    const { code } = await ipc.request("AUTHORIZE", { client_id: clientId, scopes: SCOPES, redirect_uri: redirect });
    const body = await tokenRequest(fetch, { ...base, grant_type: "authorization_code", code, redirect_uri: redirect });
    return saveToken(toToken(body, now));
  };

  let token = secrets.token;
  let fromSaved = Boolean(token?.accessToken);
  if (token?.accessToken && token.expiresAt - 60_000 <= now()) {
    token = null;
    if (secrets.token.refreshToken) {
      try {
        const body = await tokenRequest(fetch, { ...base, grant_type: "refresh_token", refresh_token: secrets.token.refreshToken });
        token = await saveToken(toToken(body, now));
      } catch {
        token = null;
      }
    }
  }
  if (!token?.accessToken) {
    fromSaved = false;
    token = await interactive();
  }

  try {
    return await ipc.request("AUTHENTICATE", { access_token: token.accessToken });
  } catch (err) {
    // A token we just obtained interactively is not retried: surface the error.
    if (!fromSaved) throw err;
    // Saved/refreshed token rejected (revoked, scopes changed): ask once more.
    token = await interactive();
    return ipc.request("AUTHENTICATE", { access_token: token.accessToken });
  }
}
