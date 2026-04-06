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
const SENSOR_READER_PORT: u16 = 8095;
const SENSOR_READER_EAGER_WAIT_TIMEOUT: Duration = Duration::from_millis(3500);
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
    sensor_reader: Mutex<Option<Child>>,
    backend: Mutex<Option<Child>>,
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
            #[cfg(windows)]
            job: JobHandle::create_kill_on_close().ok(),
        }
    }
}

fn first_existing_path(candidates: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    candidates.into_iter().find(|path| path.exists())
}

fn resolve_sensor_reader_path(resource_dir: &Path) -> Option<PathBuf> {
    let parent_dir = resource_dir.parent();

    first_existing_path(
        [
            Some(resource_dir.join("sensor-reader").join("monitor-sensor-reader.exe")),
            Some(
                resource_dir
                    .join("resources")
                    .join("sensor-reader")
                    .join("monitor-sensor-reader.exe"),
            ),
            parent_dir.map(|dir| {
                dir.join("resources")
                    .join("sensor-reader")
                    .join("monitor-sensor-reader.exe")
            }),
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

    // Probe briefly so the backend can start quickly, then let it handle the
    // richer sensor data as soon as the bundled sensor reader is ready.
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
            let sensor_reader_path = resolve_sensor_reader_path(&resource_dir);
            let backend_path = resolve_backend_path(&resource_dir);
            let processes = app.state::<AppProcesses>();
            let mut sensor_reader_ready = false;

            if let Some(sensor_reader_path) = sensor_reader_path {
                let sensor_reader_working_dir = sensor_reader_path.parent().unwrap_or(&resource_dir);
                match spawn_process(&sensor_reader_path, sensor_reader_working_dir, true) {
                    Ok(sensor_reader_child) => {
                        assign_child_to_job(&processes, &sensor_reader_child);
                        sensor_reader_ready =
                            wait_for_port(SENSOR_READER_PORT, SENSOR_READER_EAGER_WAIT_TIMEOUT);
                        *processes.sensor_reader.lock().unwrap() = Some(sensor_reader_child);

                        if !sensor_reader_ready {
                            eprintln!(
                                "Monitor sensor reader did not open port {} within {:?}",
                                SENSOR_READER_PORT, SENSOR_READER_EAGER_WAIT_TIMEOUT
                            );
                        }
                    }
                    Err(error) => {
                        eprintln!(
                            "Failed to launch the monitor sensor reader from {:?}: {}",
                            sensor_reader_path, error
                        );
                    }
                }
            } else {
                eprintln!("monitor-sensor-reader.exe not found near {:?}", resource_dir);
            }

            if !sensor_reader_ready {
                eprintln!("Continuing without confirmed monitor sensor reader connectivity.");
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
