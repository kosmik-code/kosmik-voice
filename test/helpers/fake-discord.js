// Fake Discord client IPC server for tests. Speaks the real framing:
// [op int32 LE][length int32 LE][JSON]. Handlers decide replies per command.
import net from "node:net";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

export function pipePath() {
  const name = `kv-test-${randomUUID()}`;
  return process.platform === "win32" ? `\\\\?\\pipe\\${name}` : path.join(tmpdir(), `${name}.sock`);
}

function frame(op, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

export async function startFakeDiscord(handlers = {}) {
  const pipe = pipePath();
  const received = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let buf = Buffer.alloc(0);
    const api = {
      send: (op, obj) => socket.write(frame(op, obj)),
      dispatch: (evt, data) => socket.write(frame(1, { cmd: "DISPATCH", evt, data })),
      close: () => socket.destroy(),
    };
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 8) {
        const op = buf.readInt32LE(0);
        const len = buf.readInt32LE(4);
        if (buf.length < 8 + len) break;
        const msg = JSON.parse(buf.subarray(8, 8 + len).toString("utf8"));
        buf = buf.subarray(8 + len);
        received.push({ op, msg });
        if (op === 0) {
          if (handlers.handshake) handlers.handshake(msg, api);
          else api.dispatch("READY", { v: 1, user: { id: "100000000000000001", username: "streamer" } });
        } else if (op === 4) {
          // pong
        } else if (op === 1) {
          const reply = (data) => api.send(1, { cmd: msg.cmd, nonce: msg.nonce, evt: null, data });
          const fail = (code, message) => api.send(1, { cmd: msg.cmd, nonce: msg.nonce, evt: "ERROR", data: { code, message } });
          const h = handlers[msg.cmd];
          if (h) h(msg, { reply, fail, ...api });
          else reply({});
        }
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    handlers.connection?.(api);
  });
  await new Promise((resolve) => server.listen(pipe, resolve));
  return {
    pipe,
    received,
    commands: () => received.filter((r) => r.op === 1).map((r) => r.msg),
    stop: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

export const waitFor = async (fn, ms = 2000) => {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};
