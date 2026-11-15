# Kosmik Voice

A local, free Discord voice overlay for OBS. It covers both styles:

- **Reactive** (like FugiTech Reactive Images): everyone in your voice channel, and the image swaps while someone talks.
- **Slots** (like SKFix / OBS-Discord-Overlay): each person gets a fixed slot, and a slot shows `OFFLINE` while its person is away.

It runs on your PC and talks to your Discord client through **local RPC**, the same channel StreamKit uses. No bot joins the call and nothing is hosted online. Images are local files, so their URLs never expire.

## Features

- Per-user images for idle, talking, muted and deafened (PNG, GIF, WebP, JPG). A missing image falls back to the next one, ending at the live Discord avatar.
- Talking animations: bounce, shake, pulse or none. Optional glow, dimming while silent, dimming while muted, and mute/deafen badges.
- Names, roles and role colours. Row, column or grid layouts, with alignment, offsets, gap, padding and size.
- **Aliases**: show any name on screen instead of the Discord name. Set one per user, or type it straight next to whoever is in your call (**Usuarios › En la llamada ahora**). That also adds the person, with no images needed. An empty alias falls back to the Discord name.
- Themes: **Pixel café**, which matches the Kosmik overlays, and **Clean**.
- **Templates** for new presets: *Fila abajo*, *Columna al costado*, *Squad en grilla*, *PNGtuber solo*, *Solo quien habla*, *Burbujas*, *Vertical* and *En blanco*. Pick your OBS canvas in the gallery and the sizes are scaled for it (2K = ×4/3).
- Each preset remembers its **canvas**: Full HD 1920×1080, **2K 2560×1440**, HD 1280×720 or Vertical 1080×1920. The preview uses it, and the editor tells you the exact width and height to type in OBS.
- Up to 20 presets with one OBS URL each, up to 50 users, and up to 25 users per preset.
- Web editor in plain Spanish, with a **Primeros pasos** checklist (connect Discord → pick a template → add to OBS), the essentials up front and the rest under *Ajustes avanzados*, plus a live preview. The preview can simulate the call: per-user states, everyone talking, rotating speaker, or all states at once.
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
3. **OAuth2 → Redirects** → add `http://127.0.0.1` and press **Save Changes**. Without a registered redirect, Discord answers the authorization with `Missing "redirect_uri" in request`. The app must not send a redirect itself: Discord rejects that with `Redirect URI cannot be used in the RPC OAuth2 Authorization flow`.
4. In the editor's **Discord** tab, paste the Application ID and the Client Secret, then save.
5. Discord shows an authorization popup. Accept it. The status changes to *Conectado*.

If authorization fails, the status turns to *La autorización falló* and the app stops retrying, so Discord does not show one popup after another. The **Discord** tab explains the known errors in plain words (`Missing redirect_uri`, a refused authorization, Discord closed, `handshake timed out`) and says what to do. The raw message stays under *Detalle técnico*. Fix the cause, then press **Guardar y conectar** to retry.

The secret and the tokens are stored in `data/secrets.json` and are never sent to the browser. To start over, use *Cerrar sesión* in the editor or delete that file.

## Add it to OBS

1. In the editor's **Presets** tab, pick a preset and press **Copiar para OBS**. This copies its URL, for example `http://127.0.0.1:7429/overlay/main`. The card next to the button shows the width and height of the preset's canvas.
2. In OBS, add **Sources → Browser**, paste the URL, and set that width and height (for example 2560×1440 for a 2K canvas). The preset's canvas should match OBS **Settings → Video → Base (Canvas) Resolution**.
3. Join a voice channel. The overlay follows whichever channel your Discord client is in.

Kosmik Voice has to be running while you stream. A shortcut to `npm start`, or a Streamer.bot "run program" action, works well.

## Configuration

Everything is edited in the browser and stored in `data/config.json`. The file is validated before it is written: invalid values are rejected with the field that is wrong, and the previous file stays intact. If the file is corrupted by hand, it is moved aside to `config.broken-<time>.json` and defaults are loaded.

Uploaded images live in `data/assets/`. An image still used by a user cannot be deleted.

Each preset has an optional `canvas` (`1920x1080`, `2560x1440`, `1280x720` or `1080x1920`, default `1920x1080`). Older configs without it stay valid. The canvas only drives the editor preview and the OBS size guidance: the overlay itself fills whatever size OBS gives it.

The editor accepts `?preset=<id>` to open a specific preset, and `?gallery=1` to open the template gallery. The *Primeros pasos* progress (hidden, template picked, URL copied) is remembered per browser in `localStorage`.

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
