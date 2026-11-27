// Kosmik Voice tray app. No window of its own: the editor opens in the default browser, so
// nothing heavy stays loaded while it sits in the tray.
//   --autostart  started with Windows: don't open the editor
//   --headless   no tray, just the server (development and checks)
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod updates;

use kosmik_voice::hotkeys::{self, Hotkeys};
use kosmik_voice::{App, Options, StartError, log, start};
use std::sync::{Arc, Mutex};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_opener::OpenerExt;

struct Text {
    hide: &'static str,
    open: &'static str,
    autostart: &'static str,
    quit: &'static str,
    update: &'static str,
    updating: &'static str,
    busy: &'static str,
    failed: &'static str,
}

fn spanish() -> bool {
    // LANG_SPANISH is primary language 0x0a.
    (unsafe { windows_sys::Win32::Globalization::GetUserDefaultUILanguage() } & 0x3ff) == 0x0a
}

fn text() -> Text {
    if spanish() {
        Text {
            hide: "Ocultar el overlay",
            open: "Abrir el editor",
            autostart: "Iniciar con Windows",
            quit: "Salir",
            update: "Instalar la actualización {version}",
            updating: "Actualizando…",
            busy: "Kosmik Voice no pudo arrancar: el puerto {port} está en uso.\n\n¿Ya está abierto Kosmik Voice? Fijate en la bandeja del sistema o cerrá la otra instancia.",
            failed: "Kosmik Voice no pudo arrancar:\n\n{error}",
        }
    } else {
        Text {
            hide: "Hide the overlay",
            open: "Open the editor",
            autostart: "Start with Windows",
            quit: "Quit",
            update: "Install update {version}",
            updating: "Updating…",
            busy: "Kosmik Voice couldn't start: port {port} is in use.\n\nIs Kosmik Voice already running? Check the system tray or close the other instance.",
            failed: "Kosmik Voice couldn't start:\n\n{error}",
        }
    }
}

fn status_label(state: &str) -> &'static str {
    let es = spanish();
    match (state, es) {
        ("ready", false) => "Discord: connected",
        ("ready", true) => "Discord: conectado",
        ("connecting", false) => "Discord: connecting…",
        ("connecting", true) => "Discord: conectando…",
        ("authorizing", false) => "Discord: waiting for your approval",
        ("authorizing", true) => "Discord: esperando tu aprobación",
        ("discord_closed", false) => "Discord isn't open",
        ("discord_closed", true) => "Discord no está abierto",
        ("setup_required", false) => "Discord: set it up in the editor",
        ("setup_required", true) => "Discord: configuralo en el editor",
        (_, false) => "Discord: needs attention, open the editor",
        (_, true) => "Discord: revisá el editor",
    }
}

/// "Hide the overlay (Ctrl+Alt+Shift+H)", or without the keys when it has none.
fn with_key(label: &str, key: &str) -> String {
    if key.is_empty() { label.to_string() } else { format!("{label} ({key})") }
}

/// Hotkeys registered with Windows right now, and what each one does.
type Bound = Arc<Mutex<Vec<(Shortcut, String)>>>;

/// (Re)registers the chosen hotkeys, telling the editor about any Windows refuses (another program has
/// that combination). Runs on the main thread, where the plugin's hotkey window lives.
fn bind_hotkeys(app: &AppHandle, hk: &Hotkeys, bound: &Bound) {
    let gs = app.global_shortcut();
    let mut b = bound.lock().unwrap_or_else(|e| e.into_inner());
    for (s, _) in b.drain(..) {
        let _ = gs.unregister(s);
    }
    if hk.paused() {
        return; // the editor is waiting for a new combination
    }
    for (id, key) in hk.keys() {
        if key.is_empty() {
            hk.set_error(&id, None);
            continue;
        }
        let Ok(s) = hotkeys::plugin_form(&key).parse::<Shortcut>() else {
            hk.set_error(&id, Some("unsupported_key"));
            continue;
        };
        match gs.register(s) {
            Ok(()) => {
                hk.set_error(&id, None);
                b.push((s, id));
            }
            Err(e) => {
                log::line(format!("hotkey {key} unavailable (another program uses it?): {e}"));
                hk.set_error(&id, Some("taken"));
            }
        }
    }
}

/// Registers now, and again whenever the editor changes a key or pauses them.
fn watch_hotkeys(app: AppHandle, hk: Arc<Hotkeys>, bound: Bound) {
    bind_hotkeys(&app, &hk, &bound);
    let (mut keys, mut paused) = (hk.keys_watch(), hk.paused_watch());
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                r = keys.changed() => if r.is_err() { return },
                r = paused.changed() => if r.is_err() { return },
            }
            keys.borrow_and_update();
            paused.borrow_and_update();
            let (a, h, b) = (app.clone(), hk.clone(), bound.clone());
            let _ = app.run_on_main_thread(move || bind_hotkeys(&a, &h, &b));
        }
    });
}

fn message_box(msg: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONWARNING, MB_OK, MessageBoxW};
    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let (body, title) = (wide(msg), wide("Kosmik Voice"));
    unsafe { MessageBoxW(std::ptr::null_mut(), body.as_ptr(), title.as_ptr(), MB_OK | MB_ICONWARNING) };
}

fn start_error(e: &StartError, port: u16) -> String {
    let t = text();
    match e {
        StartError::PortBusy(p) => t.busy.replace("{port}", &p.to_string()),
        StartError::Other(m) => t.failed.replace("{error}", m).replace("{port}", &port.to_string()),
    }
}

fn open_editor(app: &AppHandle) {
    if let Some(url) = app.try_state::<String>() {
        let _ = app.opener().open_url(format!("{}/editor/", url.inner()), None::<&str>);
    }
}

fn runtime() -> tokio::runtime::Runtime {
    // Two worker threads are plenty for a handful of local connections.
    tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("tokio runtime")
}

fn headless(opts: Options) {
    let rt = runtime();
    rt.block_on(async {
        let port = opts.port;
        match start(opts).await {
            Ok(_app) => {
                let _ = tokio::signal::ctrl_c().await;
            }
            Err(e) => {
                log::line(start_error(&e, port));
                std::process::exit(1);
            }
        }
    });
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut opts = Options::from_env();
    if args.iter().any(|a| a == "--headless") {
        return headless(opts);
    }
    let autostarted = args.iter().any(|a| a == "--autostart");
    opts.app_updater = opts.update_check;

    // Has this data folder been used by the app before?
    let ran_before = opts.data_dir.join("kosmik-voice.log").exists();
    let rt = runtime();
    tauri::async_runtime::set(rt.handle().clone());
    let port = opts.port;
    let started_update_check = opts.update_check;

    let t = text();
    let app = tauri::Builder::default()
        // A second launch (Start menu, desktop shortcut) just opens the editor in the running copy.
        // Plugins are set up before `setup`, so a second copy exits here, before touching the port.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| open_editor(app)))
        // The entry is named after productName; the uninstall hook (windows/hooks.nsh) removes it.
        .plugin(tauri_plugin_autostart::Builder::new().arg("--autostart").build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(move |app| {
            let started: App = match tauri::async_runtime::block_on(start(opts)) {
                Ok(app) => app,
                Err(e) => {
                    log::line(start_error(&e, port));
                    message_box(&start_error(&e, port));
                    std::process::exit(1);
                }
            };
            app.manage(started.url.clone());
            app.manage(started.server.clone());

            let launcher = app.autolaunch();
            // On first run, start with Windows so the overlay is there whenever OBS is. If already on,
            // refresh the entry to follow the executable if it moved. Turned off stays off.
            let marker = started.data_dir.join("app-first-run.done");
            if (!marker.exists() && !ran_before) || launcher.is_enabled().unwrap_or(false) {
                let _ = launcher.enable();
            }
            let _ = std::fs::write(&marker, "");
            let status = MenuItem::with_id(app, "status", status_label(&started.discord.status().state), false, None::<&str>)?;
            let open = MenuItem::with_id(app, "open", t.open, true, None::<&str>)?;
            let hide = CheckMenuItem::with_id(app, "hide", with_key(t.hide, &started.hotkeys.key("hide")), true, started.server.hidden(), None::<&str>)?;
            let auto = CheckMenuItem::with_id(app, "autostart", t.autostart, true, launcher.is_enabled().unwrap_or(false), None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", t.quit, true, None::<&str>)?;
            let sep = || PredefinedMenuItem::separator(app);
            let menu = Menu::with_items(app, &[&open, &sep()?, &status, &hide, &sep()?, &auto, &quit])?;

            // The hide hotkey (Ctrl+Alt+Shift+H unless changed in the editor) hides every overlay at once and
            // brings them back, also from a Stream Deck's hotkey button.
            let bound: Bound = Arc::new(Mutex::new(Vec::new()));
            let (srv, b) = (started.server.clone(), bound.clone());
            app.handle().plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(move |_app, shortcut, event| {
                        if event.state() != ShortcutState::Pressed {
                            return;
                        }
                        let action = b.lock().unwrap_or_else(|e| e.into_inner()).iter().find(|(s, _)| s == shortcut).map(|(_, a)| a.clone());
                        if action.as_deref() == Some("hide") {
                            srv.set_hidden(!srv.hidden());
                        }
                    })
                    .build(),
            )?;
            watch_hotkeys(app.handle().clone(), started.hotkeys.clone(), bound);
            // An "Install update" line joins the top of this menu when there is one.
            let updates = updates::Updates::new(
                app.handle().clone(),
                started.server.clone(),
                menu.clone(),
                updates::Labels { install: t.update, installing: t.updating },
                started.data_dir.clone(),
            )?;
            if started_update_check {
                updates.watch();
            }
            // Restarted by an update: the editor that started it is still open and reloads by itself.
            let updated = std::fs::remove_file(started.data_dir.join(updates::UPDATED_FLAG)).is_ok();

            let menu_srv = started.server.clone();
            let tray = TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().cloned().ok_or("no app icon")?)
                .tooltip("Kosmik Voice")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        open_editor(tray.app_handle());
                    }
                })
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "open" => open_editor(app),
                    "update" => updates.install(),
                    "hide" => menu_srv.set_hidden(!menu_srv.hidden()),
                    "autostart" => {
                        let l = app.autolaunch();
                        let on = l.is_enabled().unwrap_or(false);
                        let _ = if on { l.disable() } else { l.enable() };
                        let _ = auto.set_checked(l.is_enabled().unwrap_or(!on));
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            // Keep the status line, the "hidden" tick and the tooltip in step with Discord and hiding
            // (which the editor can change too).
            let mut watch = started.discord.status_watch();
            let mut hidden = started.server.hidden_watch();
            let mut keys = started.hotkeys.keys_watch();
            let hide_text = t.hide;
            let hidden_text = if spanish() { "overlay oculto" } else { "overlay hidden" };
            tauri::async_runtime::spawn(async move {
                loop {
                    let label = status_label(&watch.borrow_and_update().state);
                    let off = *hidden.borrow_and_update();
                    let key = keys.borrow_and_update().iter().find(|(a, _)| a == "hide").map(|(_, k)| k.clone()).unwrap_or_default();
                    let _ = hide.set_text(with_key(hide_text, &key));
                    let _ = status.set_text(label);
                    // Set every time: Windows ticks or unticks a clicked item by itself.
                    let _ = hide.set_checked(off);
                    let tip = if off { format!("Kosmik Voice · {label} · {hidden_text}") } else { format!("Kosmik Voice · {label}") };
                    let _ = tray.set_tooltip(Some(tip));
                    tokio::select! {
                        r = watch.changed() => if r.is_err() { return },
                        r = hidden.changed() => if r.is_err() { return },
                        r = keys.changed() => if r.is_err() { return },
                    }
                }
            });

            if !autostarted && !updated {
                open_editor(app.handle());
            }
            Ok(())
        })
        .build(tauri::generate_context!());
    let app = match app {
        Ok(app) => app,
        Err(e) => {
            log::line(format!("tray app failed: {e}"));
            message_box(&start_error(&StartError::Other(e.to_string()), port));
            std::process::exit(1);
        }
    };
    app.run(|_app, event| {
        // There are no windows, so only an explicit Quit (exit with a code) ends the app.
        if let RunEvent::ExitRequested { api, code: None, .. } = event {
            api.prevent_exit();
        }
    });
}
