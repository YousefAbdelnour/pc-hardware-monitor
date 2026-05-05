use std::{
    env, fs, io,
    net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command},
    sync::Mutex,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{
    menu::MenuBuilder,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, LogicalSize, Manager, Size, WebviewUrl, WebviewWindowBuilder,
};

#[cfg(windows)]
use std::os::windows::{io::AsRawHandle, process::CommandExt};
#[cfg(windows)]
use std::{mem::size_of, ptr::null};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;
const MAIN_WINDOW_LABEL: &str = "pc-hardware-monitor-main";
const SPLASH_WINDOW_LABEL: &str = "pc-hardware-monitor-splash";
const SETTINGS_FILE_NAME: &str = "settings.json";
const AUTOSTART_REGISTRY_PATH: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const AUTOSTART_ENTRY_NAME: &str = "PC Hardware Monitor";
const TRAY_SHOW_ID: &str = "tray_show";
const TRAY_HIDE_ID: &str = "tray_hide";
const TRAY_QUIT_ID: &str = "tray_quit";
const RELEASES_URL: &str = "https://github.com/YousefAbdelnour/pc-hardware-monitor/releases";
const BACKEND_PORT: u16 = 8000;
const SENSOR_READER_PORT: u16 = 8095;
const SENSOR_READER_EAGER_WAIT_TIMEOUT: Duration = Duration::from_millis(3500);
const BACKEND_EAGER_WAIT_TIMEOUT: Duration = Duration::from_millis(3000);
const PORT_POLL_INTERVAL: Duration = Duration::from_millis(250);
const PORT_CONNECT_TIMEOUT: Duration = Duration::from_millis(150);
const MAIN_WINDOW_WIDTH: f64 = 1400.0;
const MAIN_WINDOW_HEIGHT: f64 = 900.0;
const MAIN_WINDOW_MIN_WIDTH: f64 = 1120.0;
const MAIN_WINDOW_MIN_HEIGHT: f64 = 760.0;
const SPLASH_WINDOW_WIDTH: f64 = 560.0;
const SPLASH_WINDOW_HEIGHT: f64 = 380.0;
const SPLASH_CLOSE_DELAY: Duration = Duration::from_millis(180);
const SPLASH_FAILSAFE_TIMEOUT: Duration = Duration::from_secs(12);

#[cfg(windows)]
type Handle = *mut std::ffi::c_void;
#[cfg(windows)]
type Bool = i32;
#[cfg(windows)]
type Dword = u32;
#[cfg(windows)]
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS: i32 = 9;
#[cfg(windows)]
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: Dword = 0x00002000;

#[cfg(windows)]
#[repr(C)]
#[derive(Default)]
struct IoCounters {
    read_operation_count: u64,
    write_operation_count: u64,
    other_operation_count: u64,
    read_transfer_count: u64,
    write_transfer_count: u64,
    other_transfer_count: u64,
}

#[cfg(windows)]
#[repr(C)]
#[derive(Default)]
struct JobObjectBasicLimitInformation {
    per_process_user_time_limit: i64,
    per_job_user_time_limit: i64,
    limit_flags: Dword,
    minimum_working_set_size: usize,
    maximum_working_set_size: usize,
    active_process_limit: Dword,
    affinity: usize,
    priority_class: Dword,
    scheduling_class: Dword,
}

#[cfg(windows)]
#[repr(C)]
#[derive(Default)]
struct JobObjectExtendedLimitInformation {
    basic_limit_information: JobObjectBasicLimitInformation,
    io_info: IoCounters,
    process_memory_limit: usize,
    job_memory_limit: usize,
    peak_process_memory_used: usize,
    peak_job_memory_used: usize,
}

#[cfg(windows)]
#[link(name = "Kernel32")]
unsafe extern "system" {
    fn AssignProcessToJobObject(job: Handle, process: Handle) -> Bool;
    fn CloseHandle(handle: Handle) -> Bool;
    fn CreateJobObjectW(job_attributes: *const std::ffi::c_void, name: *const u16) -> Handle;
    fn SetInformationJobObject(
        job: Handle,
        information_class: i32,
        information: *mut std::ffi::c_void,
        information_length: Dword,
    ) -> Bool;
}

#[cfg(windows)]
struct JobHandle(Handle);

#[cfg(windows)]
unsafe impl Send for JobHandle {}
#[cfg(windows)]
unsafe impl Sync for JobHandle {}

#[cfg(windows)]
impl JobHandle {
    fn create_kill_on_close() -> io::Result<Self> {
        unsafe {
            let handle = CreateJobObjectW(null(), null());
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }

            let mut info = JobObjectExtendedLimitInformation::default();
            info.basic_limit_information.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

            if SetInformationJobObject(
                handle,
                JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
                (&mut info as *mut JobObjectExtendedLimitInformation).cast(),
                size_of::<JobObjectExtendedLimitInformation>() as Dword,
            ) == 0
            {
                let error = io::Error::last_os_error();
                let _ = CloseHandle(handle);
                return Err(error);
            }

            Ok(Self(handle))
        }
    }

    fn assign_process_handle(&self, process: Handle) -> io::Result<()> {
        unsafe {
            if AssignProcessToJobObject(self.0, process) == 0 {
                return Err(io::Error::last_os_error());
            }
        }

        Ok(())
    }
}

#[cfg(windows)]
impl Drop for JobHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppSettings {
    launch_at_startup: bool,
    start_minimized: bool,
    close_to_tray: bool,
    background_logging: bool,
    refresh_interval_ms: u64,
    temperature_unit: String,
    capacity_unit: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            launch_at_startup: false,
            start_minimized: false,
            close_to_tray: true,
            background_logging: true,
            refresh_interval_ms: 500,
            temperature_unit: "c".into(),
            capacity_unit: "gb".into(),
        }
    }
}

impl AppSettings {
    fn normalized(mut self) -> Self {
        self.refresh_interval_ms = match self.refresh_interval_ms {
            250 | 500 | 1000 | 2000 => self.refresh_interval_ms,
            value if value < 375 => 250,
            value if value < 750 => 500,
            value if value < 1500 => 1000,
            _ => 2000,
        };

        self.temperature_unit = match self.temperature_unit.as_str() {
            "f" => "f".into(),
            _ => "c".into(),
        };

        self.capacity_unit = match self.capacity_unit.as_str() {
            "mb" => "mb".into(),
            _ => "gb".into(),
        };

        self
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessSnapshot {
    running: bool,
    pid: Option<u32>,
    exit_code: Option<i32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeDiagnostics {
    mode: String,
    captured_at_ms: u64,
    backend_process: ProcessSnapshot,
    backend_port_open: bool,
    sensor_reader_process: ProcessSnapshot,
    sensor_reader_port_open: bool,
    last_backend_error: Option<String>,
    last_sensor_reader_error: Option<String>,
    settings_path: Option<String>,
    local_data_dir: Option<String>,
    launch_at_startup: bool,
}

struct AppProcesses {
    sensor_reader: Mutex<Option<Child>>,
    backend: Mutex<Option<Child>>,
    last_sensor_reader_error: Mutex<Option<String>>,
    last_backend_error: Mutex<Option<String>>,
    is_quitting: Mutex<bool>,
    #[cfg(windows)]
    job: Option<JobHandle>,
}

impl Drop for AppProcesses {
    fn drop(&mut self) {
        if let Some(mut sensor_reader) = self.sensor_reader.get_mut().unwrap().take() {
            let _ = sensor_reader.kill();
            let _ = sensor_reader.wait();
        }

        if let Some(mut backend) = self.backend.get_mut().unwrap().take() {
            let _ = backend.kill();
            let _ = backend.wait();
        }
    }
}

impl AppProcesses {
    fn new() -> Self {
        Self {
            sensor_reader: Mutex::new(None),
            backend: Mutex::new(None),
            last_sensor_reader_error: Mutex::new(None),
            last_backend_error: Mutex::new(None),
            is_quitting: Mutex::new(false),
            #[cfg(windows)]
            job: JobHandle::create_kill_on_close().ok(),
        }
    }

    fn clear_sensor_reader_error(&self) {
        *self.last_sensor_reader_error.lock().unwrap() = None;
    }

    fn clear_backend_error(&self) {
        *self.last_backend_error.lock().unwrap() = None;
    }

    fn set_sensor_reader_error(&self, message: impl Into<String>) {
        *self.last_sensor_reader_error.lock().unwrap() = Some(message.into());
    }

    fn set_backend_error(&self, message: impl Into<String>) {
        *self.last_backend_error.lock().unwrap() = Some(message.into());
    }

    fn is_quitting(&self) -> bool {
        *self.is_quitting.lock().unwrap()
    }

    fn mark_quitting(&self) {
        *self.is_quitting.lock().unwrap() = true;
    }
}

fn current_unix_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn first_existing_path(candidates: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    candidates.into_iter().find(|path| path.exists())
}

fn resolve_sensor_reader_path(resource_dir: &Path) -> Option<PathBuf> {
    let parent_dir = resource_dir.parent();

    first_existing_path(
        [
            Some(resource_dir.join("sensor-runtime").join("monitor-sensor-reader.exe")),
            Some(resource_dir.join("sensor-reader").join("monitor-sensor-reader.exe")),
            Some(
                resource_dir
                    .join("resources")
                    .join("sensor-runtime")
                    .join("monitor-sensor-reader.exe"),
            ),
            Some(
                resource_dir
                    .join("resources")
                    .join("sensor-reader")
                    .join("monitor-sensor-reader.exe"),
            ),
            parent_dir.map(|dir| {
                dir.join("resources")
                    .join("sensor-runtime")
                    .join("monitor-sensor-reader.exe")
            }),
            parent_dir.map(|dir| {
                dir.join("resources")
                    .join("sensor-reader")
                    .join("monitor-sensor-reader.exe")
            }),
            parent_dir.map(|dir| dir.join("sensor-runtime").join("monitor-sensor-reader.exe")),
            parent_dir.map(|dir| dir.join("sensor-reader").join("monitor-sensor-reader.exe")),
        ]
        .into_iter()
        .flatten(),
    )
}

fn resolve_backend_path(resource_dir: &Path) -> Option<PathBuf> {
    let parent_dir = resource_dir.parent();

    first_existing_path(
        [
            Some(resource_dir.join("pc-monitor-backend.exe")),
            parent_dir.map(|dir| dir.join("pc-monitor-backend.exe")),
            Some(resource_dir.join("binaries").join("pc-monitor-backend.exe")),
            parent_dir.map(|dir| dir.join("binaries").join("pc-monitor-backend.exe")),
            Some(
                resource_dir
                    .join("binaries")
                    .join("pc-monitor-backend-x86_64-pc-windows-msvc.exe"),
            ),
            parent_dir.map(|dir| {
                dir.join("binaries")
                    .join("pc-monitor-backend-x86_64-pc-windows-msvc.exe")
            }),
        ]
        .into_iter()
        .flatten(),
    )
}

fn spawn_process(
    executable: &Path,
    working_dir: &Path,
    hide_window: bool,
) -> std::io::Result<Child> {
    let mut command = Command::new(executable);
    command.current_dir(working_dir);

    #[cfg(windows)]
    if hide_window {
        command.creation_flags(CREATE_NO_WINDOW);
    }

    command.spawn()
}

fn cleanup_processes(processes: &AppProcesses) {
    {
        let mut sensor_reader = processes.sensor_reader.lock().unwrap();
        if let Some(mut sensor_reader) = sensor_reader.take() {
            let _ = sensor_reader.kill();
            let _ = sensor_reader.wait();
        }
    }

    {
        let mut backend = processes.backend.lock().unwrap();
        if let Some(mut child) = backend.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[cfg(windows)]
fn assign_child_to_job(processes: &AppProcesses, child: &Child) {
    if let Some(job) = &processes.job {
        if let Err(error) = job.assign_process_handle(child.as_raw_handle() as Handle) {
            eprintln!("Failed to assign child process to job object: {error}");
        }
    }
}

#[cfg(not(windows))]
fn assign_child_to_job(_processes: &AppProcesses, _child: &Child) {}

fn wait_for_port(port: u16, timeout: Duration) -> bool {
    let address: SocketAddr = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port).into();
    let deadline = Instant::now() + timeout;

    while Instant::now() < deadline {
        if TcpStream::connect_timeout(&address, PORT_CONNECT_TIMEOUT).is_ok() {
            return true;
        }

        thread::sleep(PORT_POLL_INTERVAL);
    }

    false
}

fn is_port_open(port: u16) -> bool {
    let address: SocketAddr = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port).into();
    TcpStream::connect_timeout(&address, PORT_CONNECT_TIMEOUT).is_ok()
}

fn snapshot_process(slot: &Mutex<Option<Child>>) -> ProcessSnapshot {
    let mut guard = slot.lock().unwrap();

    if let Some(child) = guard.as_mut() {
        let pid = Some(child.id());

        match child.try_wait() {
            Ok(Some(status)) => ProcessSnapshot {
                running: false,
                pid,
                exit_code: status.code(),
            },
            Ok(None) => ProcessSnapshot {
                running: true,
                pid,
                exit_code: None,
            },
            Err(_) => ProcessSnapshot {
                running: false,
                pid,
                exit_code: None,
            },
        }
    } else {
        ProcessSnapshot {
            running: false,
            pid: None,
            exit_code: None,
        }
    }
}

fn ensure_running_when_port_open(mut snapshot: ProcessSnapshot, port_open: bool) -> ProcessSnapshot {
    if !snapshot.running && port_open {
        snapshot.running = true;
        snapshot.exit_code = None;
    }

    snapshot
}

fn settings_path<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("Failed to resolve app config directory: {error}"))?;

    Ok(config_dir.join(SETTINGS_FILE_NAME))
}

fn ensure_settings_parent(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create settings directory {:?}: {error}", parent))?;
    }

    Ok(())
}

#[cfg(windows)]
fn run_reg_command(arguments: &[&str]) -> Result<std::process::Output, String> {
    let mut command = Command::new("reg");
    command.args(arguments);
    command.creation_flags(CREATE_NO_WINDOW);
    command
        .output()
        .map_err(|error| format!("Failed to execute reg.exe: {error}"))
}

#[cfg(not(windows))]
fn run_reg_command(_arguments: &[&str]) -> Result<std::process::Output, String> {
    Err("Launch at startup is only available on Windows.".into())
}

fn is_launch_at_startup_enabled() -> bool {
    run_reg_command(&["query", AUTOSTART_REGISTRY_PATH, "/v", AUTOSTART_ENTRY_NAME])
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn set_launch_at_startup(enabled: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        if enabled {
            let executable = env::current_exe()
                .map_err(|error| format!("Failed to resolve current executable: {error}"))?;
            let value = format!("\"{}\"", executable.display());
            let output = run_reg_command(&[
                "add",
                AUTOSTART_REGISTRY_PATH,
                "/v",
                AUTOSTART_ENTRY_NAME,
                "/t",
                "REG_SZ",
                "/d",
                &value,
                "/f",
            ])?;

            if output.status.success() {
                return Ok(());
            }

            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }

        let output = run_reg_command(&[
            "delete",
            AUTOSTART_REGISTRY_PATH,
            "/v",
            AUTOSTART_ENTRY_NAME,
            "/f",
        ])?;

        if output.status.success() {
            return Ok(());
        }

        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("unable to find") || stderr.contains("Unable to find") {
            return Ok(());
        }

        return Err(stderr.trim().to_string());
    }

    #[cfg(not(windows))]
    {
        let _ = enabled;
        Err("Launch at startup is only available on Windows.".into())
    }
}

fn load_settings_for_app<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<AppSettings, String> {
    let path = settings_path(app)?;
    let settings = if path.exists() {
        let contents = fs::read_to_string(&path)
            .map_err(|error| format!("Failed to read settings file {:?}: {error}", path))?;
        serde_json::from_str::<AppSettings>(&contents)
            .map_err(|error| format!("Failed to parse settings file {:?}: {error}", path))?
    } else {
        AppSettings::default()
    };

    let mut normalized = settings.normalized();
    normalized.launch_at_startup = is_launch_at_startup_enabled();
    Ok(normalized)
}

fn save_settings_for_app<R: tauri::Runtime>(
    app: &AppHandle<R>,
    settings: AppSettings,
) -> Result<AppSettings, String> {
    let path = settings_path(app)?;
    ensure_settings_parent(&path)?;

    let mut normalized = settings.normalized();
    set_launch_at_startup(normalized.launch_at_startup)?;
    normalized.launch_at_startup = is_launch_at_startup_enabled();

    let body = serde_json::to_string_pretty(&normalized)
        .map_err(|error| format!("Failed to serialize settings: {error}"))?;
    fs::write(&path, body).map_err(|error| format!("Failed to write settings file {:?}: {error}", path))?;

    Ok(normalized)
}

fn configure_main_window<R: tauri::Runtime, M: Manager<R>>(manager: &M) {
    if let Some(window) = manager.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.set_always_on_top(false);
        let _ = window.set_min_size(Some(Size::Logical(LogicalSize::new(
            MAIN_WINDOW_MIN_WIDTH,
            MAIN_WINDOW_MIN_HEIGHT,
        ))));
        let _ = window.set_size(Size::Logical(LogicalSize::new(
            MAIN_WINDOW_WIDTH,
            MAIN_WINDOW_HEIGHT,
        )));
        let _ = window.center();
    }
}

fn show_main_window<R: tauri::Runtime, M: Manager<R>>(manager: &M) {
    configure_main_window(manager);

    if let Some(window) = manager.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.set_skip_taskbar(false);
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn hide_main_window<R: tauri::Runtime, M: Manager<R>>(manager: &M) {
    if let Some(window) = manager.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.set_skip_taskbar(true);
        let _ = window.hide();
    }
}

fn close_splash_window<R: tauri::Runtime, M: Manager<R>>(manager: &M) {
    if let Some(window) = manager.get_webview_window(SPLASH_WINDOW_LABEL) {
        let _ = window.close();
    }
}

fn show_main_window_after_splash<R: tauri::Runtime>(app: &AppHandle<R>) {
    show_main_window(app);

    let handle = app.clone();
    thread::spawn(move || {
        thread::sleep(SPLASH_CLOSE_DELAY);
        close_splash_window(&handle);
    });
}

fn build_splash_window(app: &mut tauri::App) -> tauri::Result<()> {
    if app.get_webview_window(SPLASH_WINDOW_LABEL).is_some() {
        return Ok(());
    }

    WebviewWindowBuilder::new(app, SPLASH_WINDOW_LABEL, WebviewUrl::App("splash.html".into()))
        .title("Starting PC Hardware Monitor")
        .inner_size(SPLASH_WINDOW_WIDTH, SPLASH_WINDOW_HEIGHT)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .closable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .decorations(false)
        .shadow(true)
        .center()
        .build()?;

    Ok(())
}

fn spawn_splash_failsafe<R: tauri::Runtime>(app: AppHandle<R>) {
    thread::spawn(move || {
        thread::sleep(SPLASH_FAILSAFE_TIMEOUT);

        if app.get_webview_window(SPLASH_WINDOW_LABEL).is_some() {
            show_main_window_after_splash(&app);
        }
    });
}

fn build_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let menu = MenuBuilder::new(app)
        .text(TRAY_SHOW_ID, "Open dashboard")
        .text(TRAY_HIDE_ID, "Hide to tray")
        .separator()
        .text(TRAY_QUIT_ID, "Quit")
        .build()?;

    let mut tray_builder = TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .tooltip("PC Hardware Monitor")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            TRAY_SHOW_ID => show_main_window(app),
            TRAY_HIDE_ID => hide_main_window(app),
            TRAY_QUIT_ID => {
                let processes = app.state::<AppProcesses>();
                processes.mark_quitting();
                cleanup_processes(&processes);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            }
            | TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } => show_main_window(tray.app_handle()),
            _ => {}
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        tray_builder = tray_builder.icon(icon);
    }

    tray_builder.build(app)?;
    Ok(())
}

fn should_start_hidden(settings: &AppSettings) -> bool {
    settings.start_minimized
        || env::args().any(|argument| argument == "--minimized" || argument == "--background")
}

fn apply_initial_window_state(app: &mut tauri::App) -> bool {
    if let Ok(settings) = load_settings_for_app(app.handle()) {
        let start_hidden = should_start_hidden(&settings);
        configure_main_window(app);

        if start_hidden {
            hide_main_window(app);
        }

        return start_hidden;
    }

    false
}

fn should_close_to_tray<R: tauri::Runtime>(app: &AppHandle<R>) -> bool {
    load_settings_for_app(app)
        .map(|settings| settings.close_to_tray)
        .unwrap_or(false)
}

#[tauri::command]
fn load_settings(app: AppHandle) -> Result<AppSettings, String> {
    load_settings_for_app(&app)
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: AppSettings) -> Result<AppSettings, String> {
    let normalized = save_settings_for_app(&app, settings)?;
    configure_main_window(&app);
    Ok(normalized)
}

#[tauri::command]
fn hide_to_tray(app: AppHandle) -> Result<(), String> {
    hide_main_window(&app);
    Ok(())
}

#[tauri::command]
fn finish_app_boot(app: AppHandle) -> Result<(), String> {
    if load_settings_for_app(&app)
        .map(|settings| should_start_hidden(&settings))
        .unwrap_or(false)
    {
        return Ok(());
    }

    show_main_window_after_splash(&app);
    Ok(())
}

#[tauri::command]
fn open_release_page() -> Result<(), String> {
    #[cfg(windows)]
    {
        let mut command = Command::new("rundll32");
        command.args(["url.dll,FileProtocolHandler", RELEASES_URL]);
        command.creation_flags(CREATE_NO_WINDOW);
        command
            .spawn()
            .map_err(|error| format!("Failed to open release page: {error}"))?;
        return Ok(());
    }

    #[cfg(not(windows))]
    {
        Err("Opening the release page is only supported on Windows in this build.".into())
    }
}

#[tauri::command]
fn get_runtime_diagnostics(
    app: AppHandle,
    processes: tauri::State<AppProcesses>,
) -> Result<RuntimeDiagnostics, String> {
    let settings_path = settings_path(&app).ok().map(|path| path.display().to_string());
    let local_data_dir = app
        .path()
        .app_local_data_dir()
        .ok()
        .map(|path| path.display().to_string());

    let backend_port_open = is_port_open(BACKEND_PORT);
    let sensor_reader_port_open = is_port_open(SENSOR_READER_PORT);

    Ok(RuntimeDiagnostics {
        mode: "desktop".into(),
        captured_at_ms: current_unix_timestamp_ms(),
        backend_process: ensure_running_when_port_open(snapshot_process(&processes.backend), backend_port_open),
        backend_port_open,
        sensor_reader_process: ensure_running_when_port_open(
            snapshot_process(&processes.sensor_reader),
            sensor_reader_port_open,
        ),
        sensor_reader_port_open,
        last_backend_error: processes.last_backend_error.lock().unwrap().clone(),
        last_sensor_reader_error: processes.last_sensor_reader_error.lock().unwrap().clone(),
        settings_path,
        local_data_dir,
        launch_at_startup: is_launch_at_startup_enabled(),
    })
}

#[tauri::command]
fn save_session_csv(app: AppHandle, file_name: String, contents: String) -> Result<String, String> {
    let download_dir = app
        .path()
        .download_dir()
        .map_err(|error| format!("Failed to resolve the Downloads folder: {error}"))?;

    fs::create_dir_all(&download_dir)
        .map_err(|error| format!("Failed to prepare the Downloads folder {:?}: {error}", download_dir))?;

    let file_path = download_dir.join(file_name);
    fs::write(&file_path, contents)
        .map_err(|error| format!("Failed to save the CSV file {:?}: {error}", file_path))?;

    Ok(file_path.display().to_string())
}

fn launch_helpers(app: &mut tauri::App) -> tauri::Result<()> {
    let resource_dir = app.path().resource_dir()?;
    let sensor_reader_path = resolve_sensor_reader_path(&resource_dir);
    let backend_path = resolve_backend_path(&resource_dir);
    let processes = app.state::<AppProcesses>();

    if let Some(sensor_reader_path) = sensor_reader_path {
        let sensor_reader_working_dir = sensor_reader_path.parent().unwrap_or(&resource_dir);
        match spawn_process(&sensor_reader_path, sensor_reader_working_dir, true) {
            Ok(sensor_reader_child) => {
                assign_child_to_job(&processes, &sensor_reader_child);
                *processes.sensor_reader.lock().unwrap() = Some(sensor_reader_child);

                if wait_for_port(SENSOR_READER_PORT, SENSOR_READER_EAGER_WAIT_TIMEOUT) {
                    processes.clear_sensor_reader_error();
                } else {
                    processes.set_sensor_reader_error(format!(
                        "Sensor reader started but did not open port {} within {:?}.",
                        SENSOR_READER_PORT, SENSOR_READER_EAGER_WAIT_TIMEOUT
                    ));
                }
            }
            Err(error) => {
                processes.set_sensor_reader_error(format!(
                    "Failed to launch the monitor sensor reader from {:?}: {}",
                    sensor_reader_path, error
                ));
            }
        }
    } else {
        processes.set_sensor_reader_error(format!(
            "monitor-sensor-reader.exe was not found near {:?}",
            resource_dir
        ));
    }

    if let Some(backend_path) = backend_path {
        let backend_working_dir = backend_path.parent().unwrap_or(&resource_dir);
        match spawn_process(&backend_path, backend_working_dir, true) {
            Ok(backend_child) => {
                assign_child_to_job(&processes, &backend_child);
                *processes.backend.lock().unwrap() = Some(backend_child);

                if wait_for_port(BACKEND_PORT, BACKEND_EAGER_WAIT_TIMEOUT) {
                    processes.clear_backend_error();
                } else {
                    processes.set_backend_error(format!(
                        "Backend started but did not open port {} within {:?}.",
                        BACKEND_PORT, BACKEND_EAGER_WAIT_TIMEOUT
                    ));
                }
            }
            Err(error) => {
                processes.set_backend_error(format!(
                    "Failed to launch backend from {:?}: {}",
                    backend_path, error
                ));
            }
        }
    } else {
        processes.set_backend_error(format!("Backend exe was not found in {:?}", resource_dir));
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppProcesses::new())
        .invoke_handler(tauri::generate_handler![
            load_settings,
            save_settings,
            hide_to_tray,
            finish_app_boot,
            open_release_page,
            get_runtime_diagnostics,
            save_session_csv
        ])
        .setup(|app| {
            build_tray(app)?;
            launch_helpers(app)?;
            let start_hidden = apply_initial_window_state(app);
            if !start_hidden {
                build_splash_window(app)?;
                spawn_splash_failsafe(app.handle().clone());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            let app = window.app_handle();
            let processes = app.state::<AppProcesses>();

            match event {
                tauri::WindowEvent::CloseRequested { api, .. }
                    if window.label() == MAIN_WINDOW_LABEL
                        && !processes.is_quitting()
                        && should_close_to_tray(&app) =>
                {
                    api.prevent_close();
                    hide_main_window(window);
                }
                tauri::WindowEvent::Destroyed if window.label() == MAIN_WINDOW_LABEL => {
                    cleanup_processes(&processes);
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if matches!(
                event,
                tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
            ) {
                let processes = app_handle.state::<AppProcesses>();
                processes.mark_quitting();
                cleanup_processes(&processes);
            }
        });
}
