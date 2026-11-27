import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const running = (child) => Boolean(child?.pid) && child.exitCode === null && child.signalCode === null;

export async function stopOwnedProcess(child, { graceful = false } = {}) {
  const wait = () => once(child, "exit", { signal: AbortSignal.timeout(3000) });
  if (graceful && running(child)) {
    try { await wait(); } catch (error) { if (error.name !== "AbortError") throw error; }
  }
  if (running(child)) {
    const exited = wait();
    child.kill("SIGKILL");
    await exited;
  }
}

async function editorOrigin(child, logFile) {
  const deadline = Date.now() + 10000;
  let log = "";
  while (Date.now() < deadline) {
    try { log = await readFile(logFile, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!running(child)) throw new Error(`Rust app exited before serving (${child.signalCode ?? child.exitCode})\n${log}`);
    const match = log.match(/Editor:  (http:\/\/127\.0\.0\.1:[1-9]\d*)\/editor\//);
    if (match) return match[1];
    await delay(50);
  }
  throw new Error(`Rust app did not log its editor URL within 10s\n${log}`);
}

export async function startRustApp({ publicDir } = {}) {
  const binary = process.env.KV_TEST_BINARY
    ? resolve(process.env.KV_TEST_BINARY)
    : fileURLToPath(new URL("../../app/target/debug/kosmik-voice.exe", import.meta.url));
  const dataDir = await mkdtemp(join(tmpdir(), "kv-rust-test-"));
  let child;
  const close = async () => {
    try {
      await stopOwnedProcess(child);
      await rm(dataDir, { recursive: true, force: true, maxRetries: 3 });
    } catch (error) {
      throw new Error(`Could not clean up Rust app scratch: ${dataDir}`, { cause: error });
    }
  };
  try {
    child = spawn(binary, ["--headless"], {
      cwd: dataDir,
      env: {
        SystemRoot: process.env.SystemRoot,
        APPDATA: dataDir,
        LOCALAPPDATA: dataDir,
        KV_DATA_DIR: dataDir,
        KV_PORT: "0",
        KV_UPDATE_CHECK: "0",
        ...(publicDir ? { KV_PUBLIC_DIR: resolve(publicDir) } : {}),
      },
      stdio: "ignore",
      windowsHide: true,
    });
    await once(child, "spawn");
    const url = await editorOrigin(child, join(dataDir, "kosmik-voice.log"));
    const request = (path, { headers, ...options } = {}) => fetch(`${url}${path}`, {
      ...options,
      headers: { ...headers, Origin: url },
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    async function getConfig() {
      const response = await request("/api/config");
      if (response.status !== 200) throw new Error(`GET /api/config: ${response.status} ${await response.text()}`);
      return response.json();
    }
    async function putConfig(draft) {
      const response = await request("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      return { status: response.status, body: await response.json() };
    }
    return { url, defaults: await getConfig(), request, getConfig, putConfig, close };
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup]); }
    if (error.code === "ENOENT") throw new Error(`Build the Rust app first or set KV_TEST_BINARY (could not start ${binary})`, { cause: error });
    throw error;
  }
}
