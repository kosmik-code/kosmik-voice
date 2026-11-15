# Kosmik Voice

A local, free Discord voice overlay for OBS. It covers both styles:

- **Reactive** (like FugiTech Reactive Images): everyone in your voice channel, and the image swaps while someone talks.
- **Slots** (like SKFix / OBS-Discord-Overlay): each person gets a fixed slot, and a slot shows `OFFLINE` while its person is away.

It runs on your PC and talks to your Discord client through **local RPC**, the same channel StreamKit uses. No bot joins the call and nothing is hosted online. Images are local files, so their URLs never expire.

## Features

- Per-user images for idle, talking, muted and deafened (PNG, GIF, WebP, JPG). A missing image falls back to the next one, ending at the live Discord avatar.
- Talking animations: bounce, shake, pulse or none. Optional glow, dimming while silent, dimming while muted, and mute/deafen badges.
- Names, roles and role colours. Row, column or grid layouts, with alignment, offsets, gap, padding and size.
- Themes: **Pixel café**, which matches the Kosmik overlays, and **Clean**.
- Up to 20 presets with one OBS URL each, up to 50 users, and up to 25 users per preset.
- Web editor with a live preview at 1920×1080 / 1280×720 / 1080×1920. It can simulate the call: per-user states, everyone talking, rotating speaker, or all states at once.
- `?demo=1` and `?demo=static` on any overlay URL let you position it in OBS without a call. `?debug=1` shows the connection status.

## Requirements

- Windows with the Discord desktop app running (macOS and Linux pipes are supported but untested).
- Node.js 22 or newer.

## First run

```powershell
cd D:\Streaming\StreamTools\kosmik-voice
npm install
npm start
```

Open the editor at <http://127.0.0.1:7429/editor/>.

### Create your Discord application (one time)

Discord only lets an application's owner and its testers use local RPC, so you make your own app:

1. Go to <https://discord.com/developers/applications> → **New Application**. Any name works, for example `Kosmik Voice`.
2. **OAuth2** → copy the **Client ID** and **Client Secret** (Reset Secret if needed).
3. **OAuth2 → Redirects** → add `http://127.0.0.1` and save.
4. In the editor's **Discord** tab, paste the Application ID and the Client Secret, then save.
5. Discord shows an authorization popup. Accept it. The status changes to *Conectado*.

The secret and the tokens are stored in `data/secrets.json` and are never sent to the browser. To start over, use *Cerrar sesión* in the editor or delete that file.

## Add it to OBS

1. In the editor, pick a preset and copy its **OBS** URL, for example `http://127.0.0.1:7429/overlay/main`.
2. In OBS, add **Sources → Browser**, paste the URL, and set width/height to your canvas size (for example 1920×1080). Then position the overlay with the preset's alignment and offsets.
3. Join a voice channel. The overlay follows whichever channel your Discord client is in.

Kosmik Voice has to be running while you stream. A shortcut to `npm start`, or a Streamer.bot "run program" action, works well.

## Configuration

Everything is edited in the browser and stored in `data/config.json`. The file is validated before it is written: invalid values are rejected with the field that is wrong, and the previous file stays intact. If the file is corrupted by hand, it is moved aside to `config.broken-<time>.json` and defaults are loaded.

Uploaded images live in `data/assets/`. An image still used by a user cannot be deleted.

Environment variables: `KV_PORT` (default `7429`) and `KV_DATA_DIR` (default `./data`).

## Security model

- The server listens on `127.0.0.1` only.
- Every request must carry a `127.0.0.1:<port>` or `localhost:<port>` Host header. This blocks DNS rebinding.
- Every change needs a same-origin `Origin` header, and JSON bodies need `Content-Type: application/json`. Other websites cannot change your config.
- The WebSocket refuses foreign origins, so other websites cannot read who is in your call.
- Uploads are checked by content (magic bytes), capped at 10 MB and renamed safely. Static routes refuse path traversal.

## Development

```powershell
npm test
```

| Path | Role |
|---|---|
| `src/discord/ipc.js` | Discord IPC framing, handshake and requests |
| `src/discord/auth.js` | OAuth: AUTHORIZE → token exchange → AUTHENTICATE, refresh, secret store |
| `src/discord/voice.js` | Reduces RPC voice events into a snapshot |
| `src/discord/service.js` | Reconnects, follows the selected channel, re-subscribes on switch |
| `src/config.js` | Config schema, validation and atomic store |
| `src/server.js` | HTTP + WebSocket server and its guards |
| `public/shared/model.js` | Pure tile model and demo voice, shared by the overlay and the editor |
| `public/overlay/` | OBS overlay page and themes |
| `public/editor/` | Web editor (`logic.js` is pure and tested) |

The tests use a fake Discord IPC server that speaks the real protocol. They have not been checked against a live Discord client yet. If Discord changes a payload, the place to adjust is `src/discord/voice.js`.
