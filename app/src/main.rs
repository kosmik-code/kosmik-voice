// Kosmik Voice tray app. No window of its own: the editor opens in the default browser, so
// nothing heavy stays loaded while it sits in the tray.
//   --autostart  started with Windows: don't open the editor
//   --headless   no tray, just the server (development and checks)
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod updates;

use kosmik_voice::{App, Options, StartError, log, start};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_opener::OpenerExt;

struct Text {
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
            open: "Abrir el editor",
            autostart: "Iniciar con Windows",
            quit: "Salir",
            update: "Instalar la actualización {version}",
            updating: "Actualizando…",
            busy: "Kosmik Voice no pudo arrancar: el puerto {port} está en uso.\n\n¿Ya está abierto Kosmik Voice? Fijate en la bandeja del sistema, o cerrá la versión de terminal (npm start).",
            failed: "Kosmik Voice no pudo arrancar:\n\n{error}",
        }
    } else {
        Text {
            open: "Open the editor",
            autostart: "Start with Windows",
            quit: "Quit",
            update: "Install update {version}",
            updating: "Updating…",
            busy: "Kosmik Voice couldn't start: port {port} is in use.\n\nIs Kosmik Voice already running? Check the system tray, or close the terminal version (npm start).",
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
            // First run: start with Windows, so the overlay is there whenever OBS is.
            // Already on: write it again, so it follows the program if it was installed somewhere else.
            if started.fresh || launcher.is_enabled().unwrap_or(false) {
                let _ = launcher.enable();
            }
            let status = MenuItem::with_id(app, "status", status_label(&started.discord.status().state), false, None::<&str>)?;
            let open = MenuItem::with_id(app, "open", t.open, true, None::<&str>)?;
            let auto = CheckMenuItem::with_id(app, "autostart", t.autostart, true, launcher.is_enabled().unwrap_or(false), None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", t.quit, true, None::<&str>)?;
            let sep = || PredefinedMenuItem::separator(app);
            let menu = Menu::with_items(app, &[&open, &sep()?, &status, &sep()?, &auto, &quit])?;
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

            // Keep the status line and tooltip in step with Discord.
            let mut watch = started.discord.status_watch();
            tauri::async_runtime::spawn(async move {
                while watch.changed().await.is_ok() {
                    let label = status_label(&watch.borrow_and_update().state);
                    let _ = status.set_text(label);
                    let _ = tray.set_tooltip(Some(format!("Kosmik Voice · {label}")));
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
