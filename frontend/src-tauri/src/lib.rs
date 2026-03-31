use std::{
    io,
    net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};
use tauri::Manager;

#[cfg(windows)]
use std::os::windows::{io::AsRawHandle, process::CommandExt};
#[cfg(windows)]
use std::{mem::size_of, ptr::null};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;
const LHM_PORT: u16 = 8085;
const LHM_EAGER_WAIT_TIMEOUT: Duration = Duration::from_millis(1500);
const LHM_WARMUP_DELAY: Duration = Duration::from_millis(800);
const PORT_POLL_INTERVAL: Duration = Duration::from_millis(250);
const PORT_CONNECT_TIMEOUT: Duration = Duration::from_millis(150);

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
            // The job object is the safety net that lets Windows clean up the
            // helper processes if the desktop app exits unexpectedly.
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

struct AppProcesses {
    lhm_launcher: Mutex<Option<Child>>,
    backend: Mutex<Option<Child>>,
    #[cfg(windows)]
    job: Option<JobHandle>,
}

impl Drop for AppProcesses {
    fn drop(&mut self) {
        if let Some(mut lhm_launcher) = self.lhm_launcher.get_mut().unwrap().take() {
            let _ = lhm_launcher.kill();
            let _ = lhm_launcher.wait();
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
            lhm_launcher: Mutex::new(None),
            backend: Mutex::new(None),
            #[cfg(windows)]
            job: JobHandle::create_kill_on_close().ok(),
        }
    }
}

fn first_existing_path(candidates: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    candidates.into_iter().find(|path| path.exists())
}

fn resolve_lhm_path(resource_dir: &Path) -> Option<PathBuf> {
    let parent_dir = resource_dir.parent();

    // Tauri uses slightly different layouts in development, release, and the
    // installed bundle, so probe the common locations instead of assuming one.
    first_existing_path(
        [
            Some(
                resource_dir
                    .join("LibreHardwareMonitor")
                    .join("LibreHardwareMonitor.exe"),
            ),
            Some(
                resource_dir
                    .join("resources")
                    .join("LibreHardwareMonitor")
                    .join("LibreHardwareMonitor.exe"),
            ),
            parent_dir.map(|dir| {
                dir.join("resources")
                    .join("LibreHardwareMonitor")
                    .join("LibreHardwareMonitor.exe")
            }),
            parent_dir.map(|dir| {
                dir.join("LibreHardwareMonitor")
                    .join("LibreHardwareMonitor.exe")
            }),
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

fn escape_powershell_single_quoted(value: &Path) -> String {
    value.to_string_lossy().replace('\'', "''")
}

fn spawn_hidden_gui_process(executable: &Path, working_dir: &Path) -> io::Result<Child> {
    // Launch LHM through a tiny hidden PowerShell parent so the WinForms
    // window never flashes while still inheriting the job-object cleanup.
    let script = format!(
        "Start-Sleep -Milliseconds 1000; Start-Process -FilePath '{}' -WorkingDirectory '{}' -WindowStyle Hidden | Out-Null",
        escape_powershell_single_quoted(executable),
        escape_powershell_single_quoted(working_dir)
    );
    let mut command = Command::new("powershell.exe");
    command.args([
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-Command",
        &script,
    ]);

    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    command.spawn()
}

fn cleanup_processes(processes: &AppProcesses) {
    {
        let mut lhm_launcher = processes.lhm_launcher.lock().unwrap();
        if let Some(mut lhm_launcher) = lhm_launcher.take() {
            let _ = lhm_launcher.kill();
            let _ = lhm_launcher.wait();
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

    // Probe briefly so the backend can start quickly, then let it handle the
    // richer sensor data as soon as LibreHardwareMonitor is actually ready.
    while Instant::now() < deadline {
        if TcpStream::connect_timeout(&address, PORT_CONNECT_TIMEOUT).is_ok() {
            return true;
        }

        thread::sleep(PORT_POLL_INTERVAL);
    }

    false
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppProcesses::new())
        .setup(|app| {
            let resource_dir = app.path().resource_dir()?;
            let lhm_path = resolve_lhm_path(&resource_dir);
            let backend_path = resolve_backend_path(&resource_dir);
            let processes = app.state::<AppProcesses>();
            let mut lhm_ready = false;

            if let Some(lhm_path) = lhm_path {
                let lhm_working_dir = lhm_path.parent().unwrap_or(&resource_dir);
                match spawn_hidden_gui_process(&lhm_path, lhm_working_dir) {
                    Ok(lhm_launcher) => {
                        assign_child_to_job(&processes, &lhm_launcher);
                        lhm_ready = wait_for_port(LHM_PORT, LHM_EAGER_WAIT_TIMEOUT);
                        *processes.lhm_launcher.lock().unwrap() = Some(lhm_launcher);

                        if lhm_ready {
                            thread::sleep(LHM_WARMUP_DELAY);
                        } else {
                            eprintln!(
                                "LibreHardwareMonitor did not open port {} within {:?}",
                                LHM_PORT, LHM_EAGER_WAIT_TIMEOUT
                            );
                        }
                    }
                    Err(error) => {
                        eprintln!(
                            "Failed to launch LibreHardwareMonitor from {:?}: {}",
                            lhm_path, error
                        );
                    }
                }
            } else {
                eprintln!("LibreHardwareMonitor.exe not found near {:?}", resource_dir);
            }

            if !lhm_ready {
                eprintln!("Continuing without confirmed LibreHardwareMonitor connectivity.");
            }

            if let Some(backend_path) = backend_path {
                let backend_working_dir = backend_path.parent().unwrap_or(&resource_dir);
                match spawn_process(&backend_path, backend_working_dir, true) {
                    Ok(backend_child) => {
                        assign_child_to_job(&processes, &backend_child);
                        *processes.backend.lock().unwrap() = Some(backend_child);
                    }
                    Err(error) => {
                        eprintln!(
                            "Failed to launch backend from {:?}: {}",
                            backend_path, error
                        );
                    }
                }
            } else {
                eprintln!("Backend exe not found in {:?}", resource_dir);
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(
                event,
                tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
            ) {
                let app = window.app_handle();
                let processes = app.state::<AppProcesses>();
                cleanup_processes(&processes);
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
                cleanup_processes(&processes);
            }
        });
}
