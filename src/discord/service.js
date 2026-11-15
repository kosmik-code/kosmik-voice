// Keeps a live connection to the local Discord client and publishes voice snapshots.
// Events: "status" ({ state, message }), "state" (snapshot).
// States: setup_required | discord_closed | connecting | authorizing | ready | error
import { EventEmitter } from "node:events";
import { IpcClient, defaultPipePaths } from "./ipc.js";
import { authenticate } from "./auth.js";
import { VoiceRoom } from "./voice.js";

const CHANNEL_EVENTS = ["VOICE_STATE_CREATE", "VOICE_STATE_UPDATE", "VOICE_STATE_DELETE", "SPEAKING_START", "SPEAKING_STOP"];

export class DiscordService extends EventEmitter {
  constructor({ clientId, secrets, pipePaths = defaultPipePaths(), retryMs = 5000, fetch }) {
    super();
    this.clientId = clientId;
    this.secrets = secrets;
    this.pipePaths = pipePaths;
    this.retryMs = retryMs;
    this.fetch = fetch;
    this.room = new VoiceRoom();
    this.status = { state: "connecting", message: "" };
    this.ipc = null;
    this.running = false;
    this.timer = null;
    this.subscribed = null;
    this.selecting = Promise.resolve();
  }

  _setStatus(state, message = "") {
    this.status = { state, message };
    this.emit("status", this.status);
  }

  _publish() {
    this.emit("state", this.room.snapshot());
  }

  snapshot() {
    return this.room.snapshot();
  }

  start() {
    if (this.running) return;
    this.running = true;
    if (!this.clientId) {
      this._setStatus("setup_required", "Set your Discord application id in the editor.");
      this.running = false;
      return;
    }
    this._connect();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.ipc?.close();
    this.ipc = null;
  }

  /** Reconnect with new credentials (after the editor saved client id/secret). */
  restart(clientId = this.clientId) {
    this.stop();
    this.clientId = clientId;
    this.start();
  }

  _retry() {
    if (!this.running) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._connect(), this.retryMs);
  }

  async _connect() {
    if (!this.running) return;
    this._setStatus("connecting");
    const ipc = new IpcClient({ clientId: this.clientId, pipePaths: this.pipePaths });
    try {
      await ipc.connect();
    } catch (err) {
      this._setStatus(err.code === "DISCORD_CLOSED" ? "discord_closed" : "error", err.message);
      this._retry();
      return;
    }
    if (!this.running) return ipc.close();
    this.ipc = ipc;
    ipc.on("event", (evt, data) => this._onEvent(evt, data));
    ipc.on("close", () => {
      if (this.ipc !== ipc) return;
      this.ipc = null;
      this.subscribed = null;
      this.room.setChannel(null);
      this._publish();
      this._setStatus("discord_closed", "Lost connection to Discord");
      this._retry();
    });
    try {
      this._setStatus("authorizing", "Approve the request in Discord if it asks.");
      await authenticate({ ipc, clientId: this.clientId, store: this.secrets, fetch: this.fetch });
      await ipc.subscribe("VOICE_CHANNEL_SELECT");
      const channel = await ipc.request("GET_SELECTED_VOICE_CHANNEL");
      await this._follow(channel);
      this._setStatus("ready");
    } catch (err) {
      if (this.ipc !== ipc) return;
      if (err.code === "SETUP_REQUIRED") {
        this._setStatus("setup_required", err.message);
        this.running = false;
        ipc.close();
        return;
      }
      this._setStatus("error", err.message);
      this.ipc = null;
      ipc.close();
      this._retry();
    }
  }

  async _follow(channel) {
    const ipc = this.ipc;
    if (!ipc) return;
    const nextId = channel?.id ?? null;
    if (this.subscribed && this.subscribed !== nextId) {
      const old = this.subscribed;
      this.subscribed = null;
      await Promise.allSettled(CHANNEL_EVENTS.map((e) => ipc.unsubscribe(e, { channel_id: old })));
    }
    this.room.setChannel(channel);
    if (nextId && this.subscribed !== nextId) {
      await Promise.all(CHANNEL_EVENTS.map((e) => ipc.subscribe(e, { channel_id: nextId })));
      this.subscribed = nextId;
    }
    this._publish();
  }

  _onEvent(evt, data) {
    if (evt === "VOICE_CHANNEL_SELECT") {
      // Serialize channel switches so fast hops never interleave subscriptions.
      this.selecting = this.selecting.then(async () => {
        try {
          const channel = data?.channel_id ? await this.ipc?.request("GET_SELECTED_VOICE_CHANNEL") : null;
          await this._follow(channel ?? null);
        } catch (err) {
          this._setStatus("error", err.message);
        }
      });
      return;
    }
    if (this.room.apply(evt, data)) this._publish();
  }
}
