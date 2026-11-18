# Kosmik Voice

A local, free Discord voice overlay for OBS. It covers both styles:

- **Reactive** (like FugiTech Reactive Images): everyone in your voice channel, and the image swaps while someone talks.
- **Slots** (like SKFix / OBS-Discord-Overlay): each person gets a fixed slot, and a slot shows `OFFLINE` while its person is away.

It runs on your PC and talks to your Discord client through **local RPC**, the same channel StreamKit uses. No bot joins the call and nothing is hosted online. Images are local files, so their URLs never expire.

## Features

- Per-user images for idle, talking, muted and deafened (PNG, GIF, WebP, JPG). A missing image falls back to the next one, ending at the live Discord avatar.
- Talking animations: bounce, shake, pulse or none. Optional glow, dimming while silent, dimming while muted, and mute/deafen badges. Animations always play in OBS, even when Windows has *Animation effects* turned off; pick **none** to stop them. A short pause between words (300 ms) does not count as silence, so the animation and glow don't flicker mid-sentence.
- **Theme colours** (*Ajustes avanzados › Colores del tema*): frame, image background, name text, name background, name outline and accent (mute badge, Neón stripe). Leave a colour empty to keep the theme's own; use 8-digit hex such as `#00000000` for transparent. The Neón stripe beside the name can be turned off.
- Names, roles and role colours. Row, column or grid layouts, with alignment, offsets, gap, padding and size.
- **Aliases**: show any name on screen instead of the Discord name. Set one per user, or type it straight next to whoever is in your call (**Usuarios › En la llamada ahora**). That also adds the person, with no images needed. An empty alias falls back to the Discord name.
- Five themes, selectable under **Presets → Lo básico → Tema**: **Pixel café**, **Clean**, **Neón** (bright outlines and speaking glow), **Cómic / sticker** (bold sticker outlines and speech labels), and **Glass / moderno** (translucent cards and soft highlights). Glass uses translucent fills, not blur of other OBS sources. All themes keep your images, aliases, roles and voice-state indicators.
- **Templates** for new presets: *Fila abajo*, *Columna al costado*, *Squad en grilla*, *PNGtuber solo*, *Solo quien habla*, *Burbujas*, *Vertical*, *En blanco*, *Neón abajo*, *Stickers* and *Tarjetas de vidrio*. Pick your OBS canvas in the gallery and the sizes are scaled for it (2K = ×4/3).
- Each preset remembers its **canvas**: Full HD 1920×1080, **2K 2560×1440**, HD 1280×720 or Vertical 1080×1920. The preview uses it, and the editor tells you the exact width and height to type in OBS.
- Up to 20 presets with one OBS URL each, up to 50 users, and up to 25 users per preset.
- Web editor in plain **Spanish or English**: switch with **ES / EN** in the top bar. The first time, it follows your browser language (Spanish if your browser is in Spanish, English otherwise); your choice is remembered in that browser and never touches your settings or overlays. It has a **Primeros pasos** checklist (connect Discord → pick a template → add to OBS), the essentials up front and the rest under *Ajustes avanzados*, plus a live preview. The preview can simulate the call: per-user states, everyone talking, rotating speaker, or all states at once.
- `?demo=1` and `?demo=static` on any overlay URL let you position it in OBS without a call. `?debug=1` shows the connection status. For contrast checks, `?demo=static&bg=busy` adds a colourful test background; `bg=404850` uses a six-digit hex colour. Omit `bg` in OBS to keep the source transparent.

## Requirements

- Windows with the Discord desktop app running (macOS and Linux pipes are supported but untested).
- Node.js 22 or newer.

## First run

```powershell
git clone https://github.com/kosmik-code/kosmik-voice
cd kosmik-voice
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

Changes show up in OBS on their own: saving in the editor updates open overlays right away, and after an app update (or a restart with new files) each open overlay reloads itself. You never need *Refresh cache of current page*. The one exception: if OBS opened the source while Kosmik Voice was not running, the page never loaded, so start Kosmik Voice first or tick **Refresh browser when scene becomes active** in the source's properties.

Kosmik Voice has to be running while you stream. A shortcut to `npm start`, or a Streamer.bot "run program" action, works well.

## Configuration

Everything is edited in the browser and stored in `data/config.json`. The file is validated before it is written: invalid values are rejected with the field that is wrong, and the previous file stays intact. If the file is corrupted by hand, it is moved aside to `config.broken-<time>.json` and defaults are loaded.

Uploaded images live in `data/assets/`. An image still used by a user cannot be deleted.

Each preset has an optional `canvas` (`1920x1080`, `2560x1440`, `1280x720` or `1080x1920`, default `1920x1080`). Older configs without it stay valid. The canvas only drives the editor preview and the OBS size guidance: the overlay itself fills whatever size OBS gives it.

The editor accepts `?preset=<id>` to open a specific preset, and `?gallery=1` to open the template gallery. The *Primeros pasos* progress (hidden, template picked, URL copied) is remembered per browser in `localStorage`.

Environment variables: `KV_PORT` (default `7429`), `KV_DATA_DIR` (default `./data`) and `KV_UPDATE_CHECK` (`0` turns off the update check).

## Updates

On every start, Kosmik Voice checks in the background whether this repository has something newer than your copy. If it does, the console says so and the editor shows a banner with the number of new changes and a link to see them. To update, close the app, run `git pull` in its folder and start it again; your `data/` folder is kept. *Hide* dismisses the banner until a newer update appears. Without a network connection, or if GitHub does not answer, nothing is shown and the app works as usual. A copy downloaded as a zip (no `.git` folder) compares the `version` in `package.json` instead.

## Security model

- The server listens on `127.0.0.1` only.
- The only outbound request besides Discord is the update check: one anonymous call to the GitHub API per start, carrying only the commit id of your copy. `KV_UPDATE_CHECK=0` turns it off.
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

The automated tests use a fake Discord IPC server that speaks the real protocol. Authorization and voice events have also been verified manually against a real Discord client. If Discord changes a payload, the place to adjust is `src/discord/voice.js`.

Optional Windows browser checks: `node scripts/check-themes.mjs` starts an isolated local server and headless Microsoft Edge, checks all five themes and saves screenshots under `data/theme-checks/`. It does not use your live Discord credentials or config. Set `KV_EDGE` for a custom Edge executable, and `KV_SCREENSHOTS` for a different screenshot directory.

## License

[MIT](LICENSE) © 2026 Kosmik
