# Kosmik Voice

**Show who's talking in your Discord call, right on your stream.**

A free Discord voice overlay for OBS. Everyone in your voice channel appears on screen with their avatar or a picture you choose, and it reacts when they talk, mute or deafen. Set it up once in a simple web page; after that it just follows whatever call you're in.

![The Kosmik Voice editor](docs/editor.png)

- **Your own pictures**, or just Discord avatars. A different image for talking, idle, muted and deafened, so PNGtuber-style setups work too.
- **Ready-made looks**: a row at the bottom, a column on the side, a squad grid, speech bubbles, only whoever is talking… pick a template and adjust it.
- **Five styles**: Clean, Pixel café, Neón, Cómic / sticker and Glass.
- **Nicknames on screen** instead of Discord names, if you like.
- **Place it in the editor or in OBS.** Pick a spot on the screen here, or make it a free box you drag and resize in OBS like any other source (and that [Kosmik Layouts](https://github.com/kosmik-code/kosmik-layouts) can move per game).
- **Live preview** in the editor that can fake a call, so you can design it without anyone online.
- **Private and free.** It runs on your PC and talks to your own Discord app. No bot joins your call and nothing is uploaded anywhere.

The editor is in Spanish or English and comes in three looks (Studio, Daylight, Pixel), shared with [Kosmik Layouts](https://github.com/kosmik-code/kosmik-layouts) and [Kosmik Stagehand](https://github.com/kosmik-code/kosmik-stagehand).

## What you need

- Windows 10 or 11 with the Discord desktop app.
- OBS (any recent version).

## Install

1. Download **`Kosmik-Voice_…_x64-setup.exe`** from the [latest release](https://github.com/kosmik-code/kosmik-voice/releases/latest) and run it. No admin rights needed.
2. Windows may say *"Windows protected your PC"*, because the installer isn't signed yet. Press **More info → Run anyway**.
3. The editor opens in your browser. Kosmik Voice now lives in the tray, next to the clock: click its icon to open the editor again, right-click it to hide the overlay, quit, or stop it starting with Windows.

It's tiny: about a 2.5 MB download, and a few MB of memory while it waits in the tray. To build and launch it yourself, see [Run from source](#run-from-source).

## Set it up

The editor's **First steps** walk you through these three, and tick them off as you go.

### 1. Connect Discord (one time, about 5 minutes)

Discord only lets you read your own voice channel through an app you own, so you create a small one. It's free and nobody else sees it.

1. Go to <https://discord.com/developers/applications> → **New Application**. Any name works.
2. Open **OAuth2**. Copy the **Client ID** and the **Client Secret** (press *Reset Secret* if it's hidden).
3. Still in **OAuth2**, under **Redirects**, add `http://127.0.0.1` and press **Save Changes**.
4. In the editor's **Discord** tab, paste both and press **Save and connect**.
5. Discord asks for permission. Accept, and the status turns green.

If something goes wrong, the Discord tab says what happened in plain words and what to do about it.

### 2. Pick a look

In **Presets**, pick a template, then change the style, size, position and animation. The preview on the right shows the result. Under **Users** you can give people their own pictures and nicknames.

### 3. Add it to OBS

1. With OBS open, press **Add it to OBS**. The overlay appears in the scene you're on, with the right size. (OBS's WebSocket server must be on: **Tools › WebSocket Server Settings › Enable WebSocket server**. Kosmik Voice finds its password by itself.)
2. Join a voice call. That's it.

Prefer doing it by hand, or OBS runs on another PC? Press **Copy for OBS**, then in OBS go to **Sources → + → Browser**, paste the address and type the width and height shown next to the button.

Changes you save in the editor show up in OBS straight away; no need to refresh anything.

## Good to know

- **Kosmik Voice must be running while you stream.** It starts with Windows and waits in the tray, so normally you don't have to think about it. If you quit it, open it again from the Start menu, or let [Kosmik Stagehand](https://github.com/kosmik-code/kosmik-stagehand) start it when OBS opens.
- **Several overlays:** each preset has its own OBS address, so you can have a bottom row in one scene and a big grid in another.
- **Hide it for a moment:** **Ctrl+Alt+Shift+H** (or *Hide the overlay* in the tray menu) fades every overlay out, for a private call or a screen share. Press it again to bring them back. Change the keys (or turn the hotkey off) in **Presets › Hide the overlay**, which also has a button to do it from the editor. A Stream Deck's *Hotkey* action can press it for you. While it's hidden the editor says so, with a button to show it again.
- **Pressing *Add it to OBS* again** doesn't make a copy: it updates the size of the source that's already there, and adds it to the current scene if it isn't in it yet.
- **Moving it around in OBS:** set *Placement* to **Free box**. The source then only covers its people, so you can drag and resize it in OBS. *Room for* sets how many people the box is made for; if more join, everyone shrinks to fit. If you change the image size or the room later, update the width and height in OBS too.
- **Positioning without a call:** add `?demo=1` to the end of the overlay address in OBS to see sample people while you place it.
- **Updates:** when there's a new version, the tray menu shows *Install update* and the editor shows a banner with **Install now**. One click installs it and Kosmik Voice restarts by itself; your settings and pictures are kept, and OBS picks it up on its own.
- **Your settings** live in `%APPDATA%\Kosmik Voice` (paste that into the Explorer address bar). Uninstalling keeps them unless you tick *Delete the application data*.
- **The overlay stays blank in OBS?** Start Kosmik Voice before opening OBS, or tick *Refresh browser when scene becomes active* in the source's properties. When Discord restarts (it does for its own updates), the overlay is back about a second later.

---

## Technical details

### How it connects

Kosmik Voice talks to the Discord desktop client through **local RPC**, the same channel StreamKit uses. Discord only lets an application's owner and its testers use local RPC, which is why you register your own app. The overlay pages get updates from the local server over a WebSocket. While Discord is closed, the app checks every second whether it has started (reading the Windows process list) and connects right away when it has, instead of waiting for its next retry.

*Add it to OBS* uses OBS's own WebSocket server (obs-websocket v5, built into OBS 28+), with the port and password read from OBS's settings on this PC (`%APPDATA%\obs-studio\plugin_config\obs-websocket\config.json`). It opens one short connection per press: it looks for a Browser source already showing that overlay (and updates its size), or creates one named *Kosmik Voice* in the current scene. Nothing else in OBS is touched, and the password never reaches the browser.

About the redirect: without a registered redirect, Discord answers the authorization with `Missing "redirect_uri" in request`. The app must not send a redirect itself, because Discord rejects that with `Redirect URI cannot be used in the RPC OAuth2 Authorization flow`. If authorization fails, the app stops retrying, so Discord doesn't show one popup after another. The raw error is under *Technical details* in the Discord tab. Fix the cause, then press **Save and connect** to retry.

The secret and the tokens are stored in `secrets.json` in the app's data folder and never sent to the browser. To start over, use **Log out of Discord** in the editor or delete that file.

### Features in depth

- **Two kinds of overlay.** *Reactive*: everyone in the channel shows up and the picture swaps while they talk. *Slots*: each person has a fixed place, which shows `OFFLINE` while they're away.
- **Images** per user for idle, talking, muted and deafened (PNG, GIF, WebP, JPG). A missing image falls back to the next one, ending at the live Discord avatar. Images are local files, so their URLs never expire.
- **Talking animations**: bounce, shake, pulse or none. Optional glow, dimming while silent, dimming while muted, and mute/deafen badges. Animations always play in OBS, even when Windows has *Animation effects* turned off. A pause shorter than 300 ms doesn't count as silence, so the animation and glow don't flicker mid-sentence.
- **Theme colours** (*Advanced settings › Theme colours*): frame, image background, name text, name background, name outline and accent. Leave one empty to keep the theme's own; use 8-digit hex such as `#00000000` for transparent. The Neón stripe beside the name can be turned off. Glass uses translucent fills, not a blur of other OBS sources.
- **Names, roles and role colours.** Row, column or grid layouts with alignment, offsets, gap, padding and size.
- **Aliases** per user, or typed straight next to whoever is in your call (**Users › In the call now**), which also adds the person. An empty alias falls back to the Discord name.
- **Templates**: bottom row, side column, squad grid, PNGtuber solo, only whoever talks, bubbles, vertical, blank, Neón row, stickers and glass cards. Pick your OBS canvas in the gallery and sizes are scaled for it.
- **Placement**: *Fixed spot on the canvas* (the source covers the whole canvas; position and offsets are set in the editor) or *Free box* (the source is sized for `room` people, or one per slot, plus a margin for names, glows and badges; the 3×3 picker sets where people gather inside it; if more people join than it was sized for, the overlay scales them down towards that corner). Offsets don't apply to a box.
- **Canvas per preset**: Full HD 1920×1080, 2K 2560×1440, HD 1280×720 or Vertical 1080×1920. It drives the preview and the size the editor tells you to type in OBS; the overlay itself fills whatever size OBS gives it.
- **Limits**: up to 20 presets (one OBS address each), 50 users, and 25 users per preset.
- **Editor**: Spanish or English, and three looks (Studio, Daylight, Pixel), both under the round button at the top right. The language follows your browser the first time. Both choices are remembered per browser and never touch your settings or overlays. The preview can simulate a call: per-user states, everyone talking, a rotating speaker, or all states at once.

### Overlay and editor URL options

| Option | Where | What it does |
|---|---|---|
| `?demo=1` | overlay | Sample people that talk, to position it in OBS without a call |
| `?demo=static` | overlay | Sample people, no movement |
| `?debug=1` | overlay | Shows the connection status |
| `&bg=busy` / `&bg=404850` | overlay, with demo | A colourful test background or a hex colour, for contrast checks. Leave it out in OBS to keep the source transparent |
| `?preset=<id>` | editor | Opens that preset |
| `?gallery=1` | editor | Opens the template gallery |
| `?look=studio\|daylight\|pixel` | editor | Picks the editor look |

### The app

Kosmik Voice is a small Rust program ([Tauri](https://tauri.app/) for the tray, the installer and starting with Windows). It has no window of its own: the program runs a local server and opens the editor in your browser. The editor and overlay pages are built into the program. Both the installer and source builds use the same data folder, `%APPDATA%\Kosmik Voice`, which holds config, secrets, pictures, `hotkeys.json`, and `kosmik-voice.log` (replaced on each start). Opening the tray app a second time just opens the editor.

### Configuration

Everything is edited in the browser and stored in `config.json` in the data folder. The file is validated before it's written: invalid values are rejected with the field that's wrong, and the previous file stays intact. If the file gets corrupted by hand, it's moved aside to `config.broken-<time>.json` and defaults are loaded. Uploaded images live in the data folder's `assets/` subfolder; an image still used by a user can't be deleted.

Environment variables: `KV_PORT` (default `7429`), `KV_DATA_DIR` (default `%APPDATA%\Kosmik Voice`), `KV_UPDATE_CHECK` (`0` turns off update checks), and `KV_PUBLIC_DIR` (serve pages from this folder instead of the embedded copies).

### Updates

The tray app checks the [latest GitHub release](https://github.com/kosmik-code/kosmik-voice/releases/latest) shortly after it starts and then every 6 hours. Tauri's updater reads `latest.json` and installs only an installer signed with the project's update key (the public half is in `app/tauri.conf.json`). The installer shows a progress bar, then starts the app again. In `--headless` mode the app checks GitHub once on startup and links to a newer release instead of installing it. *Hide* dismisses the editor banner until a newer update appears. Without a network connection the app works as usual. After an update, open overlays reload themselves.

### Security

- The server listens on `127.0.0.1` only.
- Besides Discord and, when you press *Add it to OBS*, OBS on this PC, the only outbound request is the update check to GitHub. `KV_UPDATE_CHECK=0` turns it off.
- Every request must carry a `127.0.0.1:<port>` or `localhost:<port>` Host header, which blocks DNS rebinding.
- Every change needs a same-origin `Origin` header, and JSON bodies need `Content-Type: application/json`, so other websites can't change your config.
- The WebSocket refuses foreign origins, so other websites can't read who is in your call.
- Uploads are checked by content (magic bytes), capped at 10 MB and renamed safely. Static routes refuse path traversal.

### Run from source

On Windows, install [Rust](https://rustup.rs/) and the Visual Studio C++ Build Tools. Clone or download this repository, then run this from its root:

```powershell
cargo run --manifest-path app/Cargo.toml
```

This launches the tray app and opens the editor at **<http://127.0.0.1:7429/editor/>**. For just the local server, append `-- --headless`, open that address yourself, and press Ctrl+C to stop it. Node.js is not required to build or run the app.

### Development

From the repository root:

```powershell
cargo test --manifest-path app/Cargo.toml --locked
```

The Rust tests include a fake Discord IPC server that speaks the real protocol. Authorization and voice events have also been checked against a real Discord client. If Discord changes its voice payload, start with `app/src/voice.rs`.

Optional frontend checks use Node.js 22.7 or newer with no npm install. They launch an isolated Rust server and don't use your Discord credentials or settings:

```powershell
cargo build --manifest-path app/Cargo.toml --locked
node --test test/editor.test.js test/model.test.js test/i18n.test.js
node scripts/check-themes.mjs  # Microsoft Edge required; saves screenshots in data/theme-checks/
```

Set `KV_EDGE` to use a different Edge executable, `KV_SCREENSHOTS` to change the screenshot directory, or `KV_TEST_BINARY` to test a different build of `kosmik-voice.exe`.

To build an installer locally, install the Tauri CLI with `cargo install tauri-cli --version '^2' --locked`, then run `cargo tauri build` from `app/`. The NSIS installer is written to `app/target/release/bundle/nsis/`. To sign the updater artifact, set `TAURI_SIGNING_PRIVATE_KEY` to the signing key before building.

Pushing a `v*` tag that matches the version in `app/Cargo.toml` builds and signs the installer on GitHub and publishes it with `latest.json` (`.github/workflows/release.yml`). The signing key lives outside the repository (`~/.tauri/kosmik-voice.key`, shared with Kosmik Layouts and Kosmik Stagehand, also the repository secret `TAURI_SIGNING_PRIVATE_KEY`). Keep a backup: without it, installed copies can't be updated automatically.

| Path | Role |
|---|---|
| `app/src/` | The app: `ipc.rs`, `auth.rs`, `voice.rs`, `service.rs` (Discord), `procs.rs` (spots Discord starting), `obs.rs` (*Add it to OBS*), `config.rs`, `server.rs`, `update.rs`, `main.rs` (tray, hotkey) and `updates.rs` (the app's updater) |
| `app/tauri.conf.json`, `app/windows/hooks.nsh` | Installer settings; uninstall removes the autostart entry |
| `public/shared/model.js` | Pure tile model and demo voice, shared by the overlay and the editor |
| `public/overlay/` | OBS overlay page and themes |
| `public/editor/` | Web editor (`logic.js` is pure and tested) |
| `public/editor/kosmik-ui.*` | Look shared with Kosmik Layouts and Kosmik Stagehand (keep all three copies identical) |

## License

[MIT](LICENSE) © 2026 Kosmik
