// Discord client local IPC (the transport StreamKit uses).
// Frame: [op int32 LE][length int32 LE][UTF-8 JSON]. Ops: 0 HANDSHAKE, 1 FRAME, 2 CLOSE, 3 PING, 4 PONG.
import net from "node:net";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import path from "node:path";

export const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };
const MAX_FRAME = 16 * 1024 * 1024;

export function encodeFrame(op, data) {
  const body = Buffer.from(JSON.stringify(data), "utf8");
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

export class FrameDecoder {
  constructor() {
    this.buf = Buffer.alloc(0);
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    while (this.buf.length >= 8) {
      const op = this.buf.readInt32LE(0);
      const len = this.buf.readInt32LE(4);
      if (len < 0 || len > MAX_FRAME) throw new Error(`frame too large (${len} bytes)`);
      if (this.buf.length < 8 + len) break;
      out.push({ op, data: JSON.parse(this.buf.subarray(8, 8 + len).toString("utf8")) });
      this.buf = this.buf.subarray(8 + len);
    }
    return out;
  }
}

export function defaultPipePaths() {
  const ids = Array.from({ length: 10 }, (_, i) => i);
  if (process.platform === "win32") return ids.map((i) => `\\\\?\\pipe\\discord-ipc-${i}`);
  const base = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || process.env.TEMP || "/tmp";
  return ids.map((i) => path.join(base, `discord-ipc-${i}`));
}

function openPipe(p) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(p);
    socket.once("connect", () => {
      socket.removeAllListeners("error");
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

export class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Events: "event" (evt, data) for DISPATCH frames, "close" (reason).
 */
export class IpcClient extends EventEmitter {
  constructor({ clientId, pipePaths = defaultPipePaths(), timeoutMs = 15000 }) {
    super();
    this.clientId = clientId;
    this.pipePaths = pipePaths;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.socket = null;
  }

  async connect() {
    let socket = null;
    for (const p of this.pipePaths) {
      try {
        socket = await openPipe(p);
        break;
      } catch {
        // try the next discord-ipc-N
      }
    }
    if (!socket) throw Object.assign(new Error("Discord is not running (no IPC pipe answered)"), { code: "DISCORD_CLOSED" });
    this.socket = socket;
    const decoder = new FrameDecoder();

    const ready = new Promise((resolve, reject) => {
      this._ready = { resolve, reject };
    });
    socket.on("data", (chunk) => {
      let frames;
      try {
        frames = decoder.push(chunk);
      } catch (err) {
        this._shutdown(err.message);
        return;
      }
      for (const f of frames) this._onFrame(f);
    });
    socket.on("close", () => this._shutdown("connection closed"));
    socket.on("error", () => {});
    socket.write(encodeFrame(OP.HANDSHAKE, { v: 1, client_id: this.clientId }));
    const timer = setTimeout(() => this._shutdown("handshake timed out"), this.timeoutMs);
    try {
      return await ready;
    } finally {
      clearTimeout(timer);
    }
  }

  _onFrame({ op, data }) {
    if (op === OP.PING) {
      this.socket?.write(encodeFrame(OP.PONG, data));
      return;
    }
    if (op === OP.CLOSE) {
      this._shutdown(`Discord closed the connection (${data?.code ?? "no code"}): ${data?.message || "no message"}`);
      return;
    }
    if (op !== OP.FRAME) return;
    if (data.cmd === "DISPATCH" && data.evt === "READY") {
      this._ready?.resolve(data.data);
      this._ready = null;
      return;
    }
    if (data.nonce && this.pending.has(data.nonce)) {
      const { resolve, reject, timer } = this.pending.get(data.nonce);
      clearTimeout(timer);
      this.pending.delete(data.nonce);
      if (data.evt === "ERROR") reject(new RpcError(data.data?.code, data.data?.message || "RPC error"));
      else resolve(data.data);
      return;
    }
    if (data.cmd === "DISPATCH" && data.evt) this.emit("event", data.evt, data.data);
  }

  request(cmd, args = {}, evt) {
    if (!this.socket) return Promise.reject(new Error("connection closed"));
    const nonce = randomUUID();
    const payload = { cmd, args, nonce };
    if (evt) payload.evt = evt;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(nonce);
        reject(new Error(`${cmd} timed out`));
      }, cmd === "AUTHORIZE" ? 5 * 60_000 : this.timeoutMs);
      this.pending.set(nonce, { resolve, reject, timer });
      this.socket.write(encodeFrame(OP.FRAME, payload));
    });
  }

  subscribe(evt, args = {}) {
    return this.request("SUBSCRIBE", args, evt);
  }

  unsubscribe(evt, args = {}) {
    return this.request("UNSUBSCRIBE", args, evt);
  }

  _shutdown(reason) {
    if (!this.socket) return;
    const socket = this.socket;
    this.socket = null;
    socket.destroy();
    this._ready?.reject(new Error(reason));
    this._ready = null;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error(reason));
    }
    this.pending.clear();
    this.emit("close", reason);
  }

  close() {
    this._shutdown("connection closed");
  }
}
