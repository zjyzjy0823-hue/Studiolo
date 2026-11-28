mod fleet;
use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::Path,
    sync::{atomic::{AtomicBool, Ordering}, Mutex},
    time::{Duration, Instant},
};

use tauri::{Manager, WindowEvent};
use tauri_plugin_shell::{process::{CommandChild, CommandEvent}, ShellExt};
use tauri_plugin_opener::OpenerExt;

mod backend_startup;
use backend_startup::{startup_outcome, StartupOutcome};

#[cfg(target_os = "android")]
mod android;

struct DesktopState {
    child: Mutex<Option<CommandChild>>,
    status: Mutex<String>,
    quitting: AtomicBool,
}

impl Default for DesktopState {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            status: Mutex::new("starting".into()),
            quitting: AtomicBool::new(false),
        }
    }
}

#[tauri::command]
fn desktop_platform() -> &'static str {
    std::env::consts::OS
}

#[tauri::command]
fn backend_status(state: tauri::State<'_, DesktopState>) -> String {
    state.status.lock().unwrap().clone()
}

fn browser_url(value: &str) -> Result<tauri::Url, String> {
    let url = tauri::Url::parse(value).map_err(|_| "Invalid website URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("Only HTTP and HTTPS websites can be opened".into());
    }
    Ok(url)
}

#[tauri::command]
fn open_external_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().ok();
    let log = |message: &str| {
        if let Some(path) = &data_dir { log_desktop(path, message); }
    };
    log("External link: command received");
    let url = browser_url(&url).map_err(|error| {
        log("External link: rejected invalid or unsupported URL");
        error
    })?;
    app.opener().open_url(url.as_str(), None::<&str>).map_err(|error| {
        // Error Display may contain the URL. Record only the category and OS code.
        let detail = match &error {
            tauri_plugin_opener::Error::Io(error) => format!("io {:?}, OS code {:?}", error.kind(), error.raw_os_error()),
            #[cfg(windows)]
            tauri_plugin_opener::Error::Win32Error(error) => format!("Win32 HRESULT {:?}", error.code()),
            tauri_plugin_opener::Error::ForbiddenUrl { .. } => "URL scope denied".into(),
            tauri_plugin_opener::Error::UnknownProgramName(_) => "unknown program".into(),
            _ => "opener error".into(),
        };
        log(&format!("External link: system open failed ({detail})"));
        "Unable to open the default browser".to_string()
    })?;
    log("External link: system open request accepted");
    Ok(())
}

fn sanitize_download_filename(name: &str) -> String {
    let leaf = name
        .split(|c| c == '/' || c == '\\')
        .filter(|s| !s.is_empty() && *s != "." && *s != "..")
        .last()
        .unwrap_or("download");
    let cleaned: String = leaf
        .chars()
        .filter(|c| !matches!(c, '/' | '\\' | '\0' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .collect();
    let sanitized = cleaned.replace("..", "");
    let trimmed = sanitized.trim().trim_matches('.');
    if trimmed.is_empty() {
        "download".to_string()
    } else {
        trimmed.to_string()
    }
}

fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    let mut out: Vec<u8> = Vec::with_capacity(input.len() / 4 * 3 + 3);
    let mut buf: u32 = 0;
    let mut bits: usize = 0;
    for ch in input.bytes() {
        if matches!(ch, b'=' | b'\n' | b'\r' | b' ' | b'\t') {
            continue;
        }
        let val: u32 = match ch {
            b'A'..=b'Z' => (ch - b'A') as u32,
            b'a'..=b'z' => (ch - b'a') as u32 + 26,
            b'0'..=b'9' => (ch - b'0') as u32 + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return Err("invalid base64 payload".to_string()),
        };
        buf = (buf << 6) | val;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Ok(out)
}

fn studiolo_download_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let base = app
        .path()
        .download_dir()
        .or_else(|_| app.path().home_dir().map(|h| h.join("Downloads")))
        .map_err(|e| format!("Failed to resolve downloads directory: {e}"))?;
    Ok(base.join("Studiolo"))
}

fn write_download(app: &tauri::AppHandle, name: &str, bytes: &[u8]) -> Result<String, String> {
    let clean_name = sanitize_download_filename(name);
    let studiolo_dir = studiolo_download_dir(app)?;
    std::fs::create_dir_all(&studiolo_dir)
        .map_err(|e| format!("Failed to create download folder: {e}"))?;

    let (stem, ext_suffix) = match clean_name.rfind('.') {
        Some(idx) if idx > 0 => {
            let (s, ext) = clean_name.split_at(idx);
            (s.to_string(), ext.to_string())
        }
        _ => (clean_name.clone(), String::new()),
    };

    let mut target_path = studiolo_dir.join(&clean_name);
    let mut counter = 1;
    while target_path.exists() {
        let candidate_name = format!("{stem} ({counter}){ext_suffix}");
        target_path = studiolo_dir.join(candidate_name);
        counter += 1;
    }

    std::fs::write(&target_path, bytes)
        .map_err(|e| format!("Failed to save file: {e}"))?;

    Ok(target_path.to_string_lossy().to_string())
}

#[tauri::command]
fn save_download_file(app: tauri::AppHandle, name: String, bytes: Vec<u8>) -> Result<String, String> {
    write_download(&app, &name, &bytes)
}

// 大文件走 base64：Vec<u8> 会被序列化成 JSON 数字数组（20MB 文件 ≈ 60MB 文本），
// 在 Android/桌面 WebView 里会卡死。base64 只有 33% 膨胀，且解码在 Rust 侧。
#[tauri::command]
fn save_download_file_b64(app: tauri::AppHandle, name: String, base64: String) -> Result<String, String> {
    let bytes = decode_base64(&base64)?;
    write_download(&app, &name, &bytes)
}

#[tauri::command]
fn open_saved_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let dir = studiolo_download_dir(&app)?;
    let raw = std::path::Path::new(&path);
    let candidate = if raw.is_absolute() { raw.to_path_buf() } else { dir.join(raw) };
    if !candidate.exists() {
        return Err("path_missing".to_string());
    }
    // 只允许打开下载目录内的文件，避免这条命令退化成任意文件打开器
    let allowed = dir.canonicalize().map_err(|_| "path_missing".to_string())?;
    let target = candidate.canonicalize().map_err(|_| "path_missing".to_string())?;
    if !target.starts_with(&allowed) {
        return Err("path_not_allowed".to_string());
    }
    app.opener()
        .open_path(target.to_string_lossy().as_ref(), None::<&str>)
        .map_err(|e| format!("Failed to open file: {e}"))
}

#[tauri::command]
fn reveal_in_folder(app: tauri::AppHandle, path: Option<String>) -> Result<(), String> {
    let dir = studiolo_download_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create download folder: {e}"))?;
    let path_str = path.unwrap_or_default();
    let raw = std::path::Path::new(&path_str);
    let candidate = if path_str.trim().is_empty() {
        dir.clone()
    } else if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        dir.join(raw)
    };
    if !candidate.exists() {
        return Err("path_missing".to_string());
    }
    let allowed = dir.canonicalize().map_err(|_| "path_missing".to_string())?;
    let target = candidate.canonicalize().map_err(|_| "path_missing".to_string())?;
    if !target.starts_with(&allowed) {
        return Err("path_not_allowed".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        let mut cmd = std::process::Command::new("open");
        if target == allowed || target.is_dir() {
            cmd.arg(&target);
        } else {
            cmd.arg("-R").arg(&target);
        }
        cmd.spawn().map_err(|e| format!("Failed to reveal path: {e}"))?;
        Ok(())
    }
    #[cfg(windows)]
    {
        let mut cmd = std::process::Command::new("explorer");
        if target == allowed || target.is_dir() {
            cmd.arg(&target);
        } else {
            cmd.arg(format!("/select,{}", target.to_string_lossy()));
        }
        cmd.spawn().map_err(|e| format!("Failed to reveal path: {e}"))?;
        Ok(())
    }
    #[cfg(all(not(target_os = "macos"), not(windows), not(target_os = "android")))]
    {
        let open_target = if target.is_dir() {
            &target
        } else {
            target.parent().unwrap_or(&target)
        };
        std::process::Command::new("xdg-open")
            .arg(open_target)
            .spawn()
            .map_err(|e| format!("Failed to reveal path: {e}"))?;
        Ok(())
    }
    #[cfg(target_os = "android")]
    {
        Err("reveal_in_folder is not supported on Android".to_string())
    }
}

fn set_status(app: &tauri::AppHandle, value: &str) {
    *app.state::<DesktopState>().status.lock().unwrap() = value.into();
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        #[cfg(desktop)]
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn log_desktop(data_dir: &Path, message: &str) {
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .append(true).create(true).open(data_dir.join("logs").join("desktop.log"))
    {
        let _ = writeln!(file, "{message}");
    }
}

fn port_address() -> SocketAddr {
    "127.0.0.1:17800".parse().unwrap()
}

fn port_occupied() -> bool {
    TcpStream::connect_timeout(&port_address(), Duration::from_millis(300)).is_ok()
}

fn healthy() -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(&port_address(), Duration::from_millis(400)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    if stream.write_all(b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").is_err() {
        return false;
    }
    let mut result = String::new();
    stream.read_to_string(&mut result).is_ok()
        && result.starts_with("HTTP/1.1 200")
        && result.contains("\"status\":\"ok\"")
}

fn stop_backend(app: &tauri::AppHandle) {
    let state = app.state::<DesktopState>();
    state.quitting.store(true, Ordering::SeqCst);
    if state.child.lock().unwrap().is_none() {
        return;
    }
    if let Ok(data_dir) = app.path().app_data_dir() {
        let _ = std::fs::write(data_dir.join("backend.shutdown"), b"quit");
        // Uvicorn closes its listener before completing lifespan shutdown. Wait
        // for the owned process to exit, including its bounded HTTP sync work,
        // rather than treating an unavailable health endpoint as completion.
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline && state.child.lock().unwrap().is_some() {
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    let child = state.child.lock().unwrap().take();
    if let Some(child) = child {
        let _ = child.kill();
    }
}

fn start_backend(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let data_dir = match app.path().app_data_dir() {
            Ok(path) => path,
            Err(_) => {
                set_status(&app, "无法定位 Studiolo 用户数据目录。");
                show_main(&app);
                return;
            }
        };
        if std::fs::create_dir_all(data_dir.join("logs")).is_err() {
            set_status(&app, "无法创建 Studiolo 用户数据目录。");
            show_main(&app);
            return;
        }
        if port_occupied() {
            log_desktop(&data_dir, "Port 17800 is already in use");
            set_status(&app, "端口 17800 已被占用。请关闭占用该端口的程序后重启 Studiolo。");
            show_main(&app);
            return;
        }
        let command = match app.shell().sidecar("studiolo-backend") {
            Ok(command) => command,
            Err(error) => {
                log_desktop(&data_dir, &format!("Sidecar lookup failed: {error}"));
                set_status(&app, "Studiolo Backend 文件缺失。请重新安装 Studiolo。");
                show_main(&app);
                return;
            }
        };
        #[cfg(target_os = "macos")]
        let command = command.args(["--parent-pid", &std::process::id().to_string()]);
        if app.state::<DesktopState>().quitting.load(Ordering::SeqCst) {
            return;
        }
        let data_dir_arg = data_dir.to_string_lossy().into_owned();
        let (mut receiver, child) = match command.args(["--data-dir", data_dir_arg.as_str()]).spawn() {
            Ok(result) => result,
            Err(error) => {
                log_desktop(&data_dir, &format!("Sidecar spawn failed: {error}"));
                set_status(&app, "Studiolo Backend 启动失败。请查看 logs/backend.log。");
                show_main(&app);
                return;
            }
        };
        {
            let state = app.state::<DesktopState>();
            let mut owned_child = state.child.lock().unwrap();
            if state.quitting.load(Ordering::SeqCst) {
                let _ = child.kill();
                return;
            }
            owned_child.replace(child);
        }
        log_desktop(&data_dir, "Backend sidecar spawned");

        let monitor_app = app.clone();
        let monitor_dir = data_dir.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(event) = receiver.recv().await {
                if let CommandEvent::Terminated(payload) = event {
                    log_desktop(&monitor_dir, &format!("Backend exited with code {:?}", payload.code));
                    let state = monitor_app.state::<DesktopState>();
                    state.child.lock().unwrap().take();
                    if !state.quitting.load(Ordering::SeqCst) {
                        set_status(&monitor_app, "Studiolo Backend 已停止。请退出并重新启动 Studiolo，详情见 logs/backend.log。");
                        show_main(&monitor_app);
                    }
                    break;
                }
            }
        });

        let started = Instant::now();
        loop {
            let state = app.state::<DesktopState>();
            let starting = !state.quitting.load(Ordering::SeqCst)
                && state.status.lock().unwrap().as_str() == "starting";
            let ready = starting && healthy();
            match startup_outcome(started.elapsed(), ready, starting) {
                StartupOutcome::Ready => {
                    set_status(&app, "ready");
                    log_desktop(&data_dir, &format!("Backend is ready after {:.1}s", started.elapsed().as_secs_f64()));
                    show_main(&app);
                    return;
                }
                StartupOutcome::Cancelled => return,
                StartupOutcome::TimedOut => break,
                StartupOutcome::Waiting => std::thread::sleep(Duration::from_millis(250)),
            }
        }
        log_desktop(&data_dir, &format!("Backend readiness timed out after {:.1}s", started.elapsed().as_secs_f64()));
        stop_backend(&app);
        set_status(&app, "Studiolo Backend 启动超时。请查看 logs/backend.log；数据库迁移失败时请先备份 studiolo.db。");
        show_main(&app);
    });
}

#[cfg(desktop)]
fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::{menu::{Menu, MenuItem}, tray::TrayIconBuilder};
    let open = MenuItem::with_id(app, "open", "打开 Studiolo", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 Studiolo", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut builder = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("Studiolo")
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "quit" => {
                stop_backend(app);
                app.exit(0);
            }
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn setup_macos_menu(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{AboutMetadata, Menu, PredefinedMenuItem, Submenu};
    let menu = Menu::default(app.handle())?;
    // The default uses Cargo's package name; native menus should use the product name.
    let app_menu = Submenu::with_items(app, "Studiolo", true, &[
        &PredefinedMenuItem::about(app, Some("About Studiolo"), Some(AboutMetadata {
            name: Some("Studiolo".into()),
            version: Some(app.package_info().version.to_string()),
            ..Default::default()
        }))?,
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::services(app, None)?,
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::hide(app, Some("Hide Studiolo"))?,
        &PredefinedMenuItem::hide_others(app, None)?,
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::quit(app, Some("Quit Studiolo"))?,
    ])?;
    menu.remove_at(0)?;
    menu.prepend(&app_menu)?;
    app.set_menu(menu)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "android")]
    let builder = builder
        .plugin(android::plugin())
        .plugin(android::notifications_plugin())
        .plugin(android::downloads_plugin())
        .plugin(android::media_plugin())
        .invoke_handler(tauri::generate_handler![
        desktop_platform, backend_status, open_external_url,
        fleet::fleet_connect, fleet::fleet_disconnect, fleet::fleet_send, fleet::fleet_notifications,
        android::android_validate_core_url, android::android_core_status, android::android_core_prepare,
        android::android_core_connect, android::android_core_cancel_pending, android::android_core_disconnect,
        android::android_core_new_replica, android::android_websites_list, android::android_website_create,
        android::android_website_update, android::android_website_delete, android::android_website_visit,
        android::android_website_categories_list, android::android_website_categories_create,
        android::android_website_categories_update, android::android_website_categories_delete,
        android::android_sync_status, android::android_sync_run, android::android_sync_resync,
        android::android_sync_conflicts_list, android::android_sync_conflict_resolve,
        android::android_sync_rejected_list, android::android_sync_rejected_dismiss, android::android_sync_rejected_retry,
        android::android_notifications_enabled, android::android_set_notifications_enabled, android::android_show_fleet_notification,
        android::android_show_fleet_approval, android::android_listen_fleet_approval,
        android::android_read_device_space, android::android_save_attachment,
        android::android_open_download, save_download_file, save_download_file_b64, open_saved_path, reveal_in_folder,
        android::android_capture_photo, android::android_pick_images,
    ]);
    #[cfg(not(target_os = "android"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        desktop_platform, backend_status, open_external_url,
        save_download_file, save_download_file_b64, open_saved_path,
        reveal_in_folder,
        fleet::fleet_connect, fleet::fleet_disconnect, fleet::fleet_send, fleet::fleet_notifications,
        fleet::fleet_notify_attention,
    ]);
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if app.state::<DesktopState>().status.lock().unwrap().as_str() != "starting" {
                show_main(app);
            }
        }));
    let app = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build())
        .manage(DesktopState::default())
        .manage(fleet::FleetTransport::default())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            setup_macos_menu(app)?;
            #[cfg(desktop)]
            setup_tray(app)?;
            #[cfg(desktop)]
            start_backend(app.handle().clone());
            #[cfg(mobile)]
            set_status(app.handle(), "ready");
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if !window.state::<DesktopState>().quitting.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build Studiolo Desktop");
    app.run(|app, event| {
        match event {
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => show_main(app),
            #[cfg(target_os = "macos")]
            tauri::RunEvent::ExitRequested { .. } => stop_backend(app),
            #[cfg(not(target_os = "macos"))]
            tauri::RunEvent::ExitRequested { api, .. }
                if !app.state::<DesktopState>().quitting.load(Ordering::SeqCst) => api.prevent_exit(),
            tauri::RunEvent::Exit => stop_backend(app),
            _ => {}
        }
    });
}

#[cfg(test)]
mod tests {
    use super::browser_url;

    #[test]
    fn accepts_browser_websites_and_preserves_query_and_fragment() {
        for value in ["https://example.com/docs?q=hello%20world#intro", "http://localhost:8080/"] {
            assert_eq!(browser_url(value).unwrap().as_str(), value);
        }
    }

    #[test]
    fn rejects_files_commands_custom_protocols_and_relative_paths() {
        for value in ["file:///C:/Windows/System32/cmd.exe", "javascript:alert(1)",
                      "ms-settings:defaultapps", "mailto:test@example.com", "C:\\Windows\\System32\\cmd.exe", "/websites", "invalid"] {
            assert!(browser_url(value).is_err(), "accepted unsupported link: {value}");
        }
    }

    #[test]
    fn sanitizes_download_filenames() {
        use super::sanitize_download_filename;
        assert_eq!(sanitize_download_filename("test.pdf"), "test.pdf");
        assert_eq!(sanitize_download_filename("../test.pdf"), "test.pdf");
        assert_eq!(sanitize_download_filename("foo/bar/baz.png"), "baz.png");
        assert_eq!(sanitize_download_filename("foo\\bar\\baz.png"), "baz.png");
        assert_eq!(sanitize_download_filename(".."), "download");
        assert_eq!(sanitize_download_filename(""), "download");
        assert_eq!(sanitize_download_filename("   "), "download");
        assert_eq!(sanitize_download_filename("invalid:name*?.txt"), "invalidname.txt");
    }
}

#[cfg(test)]
mod download_cmd_tests {
    use super::{decode_base64, sanitize_download_filename};

    #[test]
    fn base64_roundtrip_of_known_vectors() {
        assert_eq!(decode_base64("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(decode_base64("").unwrap(), Vec::<u8>::new());
        assert_eq!(decode_base64("AAEC").unwrap(), vec![0u8, 1, 2]);
        assert_eq!(decode_base64("aGVs\nbG8=").unwrap(), b"hello");
        assert!(decode_base64("!!!").is_err());
    }

    #[test]
    fn filename_sanitization_blocks_traversal_and_reserved_chars() {
        assert_eq!(sanitize_download_filename("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_download_filename("C:\\Users\\x\\a.txt"), "a.txt");
        assert_eq!(sanitize_download_filename("a*b?c.txt"), "abc.txt");
        assert_eq!(sanitize_download_filename(".."), "download");
        assert_eq!(sanitize_download_filename(""), "download");
    }
}

