mod icon;
mod screen;

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};

/// 프런트가 '지금 종료해도 됨'을 확인했을 때만 true (코어타임 중 종료 방지)
static ALLOW_EXIT: AtomicBool = AtomicBool::new(false);

use tauri::{
    image::Image,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{TrayIcon, TrayIconBuilder},
    AppHandle, Emitter, Manager, RunEvent, Runtime, State, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

struct TrayState<R: Runtime> {
    tray: Mutex<Option<TrayIcon<R>>>,
    widget_item: Mutex<Option<CheckMenuItem<R>>>,
    menubar_item: Mutex<Option<CheckMenuItem<R>>>,
    autostart_item: Mutex<Option<CheckMenuItem<R>>>,
}

#[tauri::command]
fn update_tray(
    state: State<'_, TrayState<tauri::Wry>>,
    kind: String,
    progress: f64,
    title: String,
    tooltip: String,
    badge: Option<String>,
) -> Result<(), String> {
    let guard = state.tray.lock().map_err(|e| e.to_string())?;
    let Some(tray) = guard.as_ref() else { return Ok(()) };
    // Windows: 코어타임 중엔 아이콘 안에 남은 시간(분)을 숫자로
    let rgba = match badge.as_deref() {
        Some(text) if !text.is_empty() => icon::render_text(&kind, text),
        _ => icon::render(&kind, progress),
    };
    tray.set_icon(Some(Image::new_owned(rgba, icon::SIZE, icon::SIZE)))
        .map_err(|e| e.to_string())?;
    // macOS 메뉴 막대·리눅스 패널에만 글자가 보이고, Windows에서는 무시된다.
    let _ = tray.set_title(if title.is_empty() { None } else { Some(title) });
    let _ = tray.set_tooltip(Some(tooltip));
    Ok(())
}

#[tauri::command]
fn set_widget_checked(state: State<'_, TrayState<tauri::Wry>>, checked: bool) {
    if let Ok(g) = state.widget_item.lock() {
        if let Some(item) = g.as_ref() {
            let _ = item.set_checked(checked);
        }
    }
}

#[tauri::command]
fn set_menubar_checked(state: State<'_, TrayState<tauri::Wry>>, checked: bool) {
    if let Ok(g) = state.menubar_item.lock() {
        if let Some(item) = g.as_ref() {
            let _ = item.set_checked(checked);
        }
    }
}

/// 시스템 알림 (잠금 화면에도 표시될 수 있음: macOS 알림 설정 → '잠금 화면에 표시')
#[tauri::command]
fn notify(app: AppHandle, title: String, body: String) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(title).body(body).show();
}

#[tauri::command]
fn get_autostart(app: AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn set_autostart(app: AppHandle, state: State<'_, TrayState<tauri::Wry>>, enabled: bool) -> Result<bool, String> {
    let al = app.autolaunch();
    if enabled { al.enable() } else { al.disable() }.map_err(|e| e.to_string())?;
    let now = al.is_enabled().unwrap_or(enabled);
    if let Ok(g) = state.autostart_item.lock() {
        if let Some(item) = g.as_ref() {
            let _ = item.set_checked(now);
        }
    }
    Ok(now)
}

/// 처음 실행할 때 한 번만 '로그인 시 자동 실행'을 켜 둔다 (이후엔 사용자 선택을 존중)
fn enable_autostart_on_first_run<R: Runtime>(app: &AppHandle<R>) {
    let Ok(dir) = app.path().app_config_dir() else { return };
    let marker = dir.join("autostart-initialized");
    if marker.exists() {
        return;
    }
    let _ = std::fs::create_dir_all(&dir);
    let _ = app.autolaunch().enable();
    let _ = std::fs::write(marker, b"1");
}

/// 프런트에서 코어타임이 아님을 확인한 뒤 호출
#[tauri::command]
fn quit_app(app: AppHandle) {
    ALLOW_EXIT.store(true, Ordering::SeqCst);
    app.exit(0);
}

#[tauri::command]
fn lock_screen() -> Result<(), String> {
    screen::lock_now()
}

fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let _ = app.emit("open-settings", ());
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_notification::init())
        .manage(TrayState::<tauri::Wry> {
            tray: Mutex::new(None),
            widget_item: Mutex::new(None),
            menubar_item: Mutex::new(None),
            autostart_item: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            update_tray,
            set_widget_checked,
            set_menubar_checked,
            lock_screen,
            quit_app,
            get_autostart,
            set_autostart,
            notify
        ])
        .setup(|app| {
            // macOS: Dock 아이콘 없이 메뉴 막대에서만 동작
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            enable_autostart_on_first_run(app.handle());
            let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);

            let widget = CheckMenuItem::with_id(app, "toggle-widget", "플로팅 위젯 표시", true, true, None::<&str>)?;
            let menubar = CheckMenuItem::with_id(
                app,
                "toggle-menubar-text",
                if cfg!(target_os = "windows") { "남은 시간 글자 (macOS·Linux 전용)" } else { "메뉴 막대에 남은 시간 표시" },
                !cfg!(target_os = "windows"),
                true,
                None::<&str>,
            )?;
            let settings = MenuItem::with_id(app, "open-settings", "설정…", true, None::<&str>)?;
            let lock = MenuItem::with_id(app, "request-lock", "화면 잠금…", true, None::<&str>)?;
            let clock_in = MenuItem::with_id(app, "set-clock-in", "오늘 출근 시각 설정…", true, None::<&str>)?;
            let celebrate = MenuItem::with_id(app, "preview-celebrate", "코어타임 종료 미리보기", true, None::<&str>)?;
            let start_preview = MenuItem::with_id(app, "preview-lock-start", "코어타임 시작 미리보기", true, None::<&str>)?;
            let sim_day = MenuItem::with_id(app, "simulate-day", "하루 빠르게 미리보기", true, None::<&str>)?;
            let sep4 = PredefinedMenuItem::separator(app)?;
            let autostart = CheckMenuItem::with_id(app, "autostart", "로그인 시 자동 실행", true, autostart_on, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
            let sep1 = PredefinedMenuItem::separator(app)?;
            let sep3 = PredefinedMenuItem::separator(app)?;

            let menu = Menu::with_items(
                app,
                &[&clock_in, &lock, &sep4, &widget, &menubar, &sep1, &settings, &start_preview, &celebrate, &sim_day, &autostart, &sep3, &quit],
            )?;

            let autostart_item = autostart.clone();
            let initial = icon::render("idle", 0.0);
            let tray = TrayIconBuilder::with_id("lockin")
                .icon(Image::new_owned(initial, icon::SIZE, icon::SIZE))
                .icon_as_template(false)
                .tooltip("코어타이머")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    // 바로 끄지 않고 프런트에 물어본다 (코어타임 중이면 거절)
                    "quit" => {
                        show_main(app);
                        let _ = app.emit("request-quit", ());
                    }
                    "autostart" => {
                        let al = app.autolaunch();
                        let on = al.is_enabled().unwrap_or(false);
                        let _ = if on { al.disable() } else { al.enable() };
                        let _ = autostart_item.set_checked(al.is_enabled().unwrap_or(!on));
                    }
                    "open-settings" | "request-lock" | "preview-lock-start" | "set-clock-in" | "simulate-day" => {
                        show_main(app);
                        let _ = app.emit(event.id().as_ref(), ());
                    }
                    id @ ("toggle-widget" | "toggle-menubar-text" | "preview-celebrate") => {
                        let _ = app.emit(id, ());
                    }
                    _ => {}
                })
                .build(app)?;

            let state = app.state::<TrayState<tauri::Wry>>();
            *state.tray.lock().unwrap() = Some(tray);
            *state.widget_item.lock().unwrap() = Some(widget);
            *state.menubar_item.lock().unwrap() = Some(menubar);
            *state.autostart_item.lock().unwrap() = Some(autostart);

            // 화면 잠금/해제 감지 → 프런트로 "screen-lock" 이벤트
            screen::spawn_monitor(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Alt+F4 등으로 위젯 창을 닫으려 할 때도 같은 확인을 거친다
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" && !ALLOW_EXIT.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.app_handle().emit("request-quit", ());
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("코어타이머 실행 중 오류")
        .run(|app, event| {
            // ⌘Q·시스템 종료 요청 등 앱 종료 시도도 확인을 거친다
            if let RunEvent::ExitRequested { api, .. } = event {
                if !ALLOW_EXIT.load(Ordering::SeqCst) {
                    api.prevent_exit();
                    let _ = app.emit("request-quit", ());
                }
            }
        });
}
