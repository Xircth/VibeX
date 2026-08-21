//! Isolated Worker spawn: Linux seccomp-bpf + Windows AppContainer.
#![cfg_attr(not(any(target_os = "linux", windows, test)), allow(dead_code))]
//!
//! Allowlists are the recorded files in `packages/plugin-contract/isolated/`.
//! Default profiles never allow `socket`/`connect`/`accept`/`bind` or
//! Windows `internetClient`. A `network.fetch` grant adds only `socket` and
//! `connect` (Linux) or `internetClient` (Windows). The Host Broker still
//! performs the fetch.

use std::path::Path;

use crate::worker_host::{CapabilityGrant, WorkerHostError};

#[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
const NODE_LINUX_SYSCALLS: &str =
    include_str!("../../../packages/plugin-contract/isolated/node.linux.syscalls");
const PYTHON_LINUX_SYSCALLS: &str =
    include_str!("../../../packages/plugin-contract/isolated/python.linux.syscalls");
const NATIVE_LINUX_SYSCALLS: &str =
    include_str!("../../../packages/plugin-contract/isolated/native.linux.syscalls");

const NEVER_LINUX: &[&str] = &[
    "ptrace",
    "mount",
    "umount2",
    "bpf",
    "init_module",
    "finit_module",
    "delete_module",
    "reboot",
    "kexec_load",
    "swapon",
    "swapoff",
    "accept",
    "bind",
    "listen",
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum IsolatedRuntimeKind {
    Node,
    Python,
    Native,
}

pub(crate) fn isolated_runtime_kind(runtime_bin: &Path, worker_path: &Path) -> IsolatedRuntimeKind {
    if worker_path
        .extension()
        .and_then(|extension| extension.to_str())
        == Some("py")
    {
        IsolatedRuntimeKind::Python
    } else if runtime_bin.file_name() == worker_path.file_name() {
        IsolatedRuntimeKind::Native
    } else {
        IsolatedRuntimeKind::Node
    }
}

pub(crate) fn grants_allow_network(grants: &[CapabilityGrant]) -> bool {
    grants
        .iter()
        .any(|grant| grant.capability == "network.fetch")
}

pub(crate) fn parse_syscall_allowlist(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(str::to_owned)
        .collect()
}

pub(crate) fn isolated_linux_syscalls(
    kind: IsolatedRuntimeKind,
    allow_network: bool,
) -> Vec<String> {
    let recorded = match kind {
        IsolatedRuntimeKind::Node => NODE_LINUX_SYSCALLS,
        IsolatedRuntimeKind::Python => PYTHON_LINUX_SYSCALLS,
        IsolatedRuntimeKind::Native => NATIVE_LINUX_SYSCALLS,
    };
    let mut names = parse_syscall_allowlist(recorded);
    names.retain(|name| !NEVER_LINUX.contains(&name.as_str()));
    if allow_network {
        for extra in ["socket", "connect"] {
            if !names.iter().any(|name| name == extra) {
                names.push(extra.to_owned());
            }
        }
    } else {
        names.retain(|name| name != "socket" && name != "connect");
    }
    names
}

pub(crate) fn linux_syscall_nr(name: &str) -> Option<u32> {
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        lookup_aarch64(name)
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        lookup_x86_64(name)
    }
    #[cfg(not(all(
        target_os = "linux",
        any(target_arch = "x86_64", target_arch = "aarch64")
    )))]
    {
        lookup_x86_64(name).or_else(|| lookup_aarch64(name))
    }
}

fn lookup_x86_64(name: &str) -> Option<u32> {
    Some(match name {
        "read" => 0,
        "write" => 1,
        "close" => 3,
        "fstat" => 5,
        "lstat" => 6,
        "poll" => 7,
        "lseek" => 8,
        "mmap" => 9,
        "mprotect" => 10,
        "munmap" => 11,
        "brk" => 12,
        "rt_sigaction" => 13,
        "rt_sigprocmask" => 14,
        "rt_sigreturn" => 15,
        "ioctl" => 16,
        "pread64" => 17,
        "pwrite64" => 18,
        "writev" => 20,
        "access" => 21,
        "pipe" => 22,
        "sched_yield" => 24,
        "mremap" => 25,
        "madvise" => 28,
        "dup" => 32,
        "dup2" => 33,
        "nanosleep" => 35,
        "getpid" => 39,
        "socket" => 41,
        "connect" => 42,
        "accept" => 43,
        "bind" => 49,
        "clone" => 56,
        "execve" => 59,
        "exit" => 60,
        "wait4" => 61,
        "uname" => 63,
        "fcntl" => 72,
        "fsync" => 74,
        "getcwd" => 79,
        "chdir" => 80,
        "fchdir" => 81,
        "mkdir" => 83,
        "unlink" => 87,
        "readlink" => 89,
        "umask" => 95,
        "getrlimit" => 97,
        "getrusage" => 98,
        "sysinfo" => 99,
        "getuid" => 102,
        "getgid" => 104,
        "geteuid" => 107,
        "getegid" => 108,
        "getppid" => 110,
        "capget" => 125,
        "sigaltstack" => 131,
        "statfs" => 137,
        "fstatfs" => 138,
        "arch_prctl" => 158,
        "setrlimit" => 160,
        "prctl" => 157,
        "gettid" => 186,
        "futex" => 202,
        "sched_getaffinity" => 204,
        "epoll_create" => 213,
        "getdents64" => 217,
        "set_tid_address" => 218,
        "fadvise64" => 221,
        "clock_gettime" => 228,
        "clock_getres" => 229,
        "exit_group" => 231,
        "epoll_wait" => 232,
        "epoll_ctl" => 233,
        "tgkill" => 234,
        "waitid" => 247,
        "openat" => 257,
        "newfstatat" => 262,
        "readlinkat" => 267,
        "faccessat" => 269,
        "ppoll" => 271,
        "set_robust_list" => 273,
        "epoll_pwait" => 281,
        "signalfd4" => 289,
        "eventfd2" => 290,
        "epoll_create1" => 291,
        "dup3" => 292,
        "pipe2" => 293,
        "prlimit64" => 302,
        "getrandom" => 318,
        "statx" => 332,
        "rseq" => 334,
        "clone3" => 435,
        "faccessat2" => 439,
        "epoll_pwait2" => 441,
        _ => return None,
    })
}

fn lookup_aarch64(name: &str) -> Option<u32> {
    Some(match name {
        "io_setup" => 0,
        "setxattr" => 5,
        "getcwd" => 17,
        "eventfd2" => 19,
        "epoll_create1" => 20,
        "epoll_ctl" => 21,
        "epoll_pwait" => 22,
        "dup" => 23,
        "dup3" => 24,
        "fcntl" => 25,
        "ioctl" => 29,
        "mknodat" => 33,
        "mkdir" => 34,
        "unlink" => 35,
        "fchdir" => 50,
        "chdir" => 49,
        "ftruncate" => 46,
        "faccessat" => 48,
        "fchmod" => 52,
        "fchown" => 55,
        "openat" => 56,
        "close" => 57,
        "pipe2" => 59,
        "getdents64" => 61,
        "lseek" => 62,
        "read" => 63,
        "write" => 64,
        "writev" => 66,
        "pread64" => 67,
        "pwrite64" => 68,
        "pselect6" => 72,
        "ppoll" => 73,
        "signalfd4" => 74,
        "readlinkat" => 78,
        "newfstatat" => 79,
        "fstat" => 80,
        "fsync" => 82,
        "fdatasync" => 83,
        "timerfd_create" => 85,
        "exit" => 93,
        "exit_group" => 94,
        "waitid" => 95,
        "futex" => 98,
        "set_robust_list" => 99,
        "clock_settime" => 112,
        "clock_gettime" => 113,
        "clock_getres" => 114,
        "syslog" => 116,
        "ptrace" => 117,
        "sched_setparam" => 118,
        "sched_setscheduler" => 119,
        "sched_getscheduler" => 120,
        "sched_getparam" => 121,
        "sched_setaffinity" => 122,
        "sched_getaffinity" => 123,
        "sched_yield" => 124,
        "kill" => 129,
        "tgkill" => 131,
        "sigaltstack" => 132,
        "rt_sigsuspend" => 133,
        "rt_sigaction" => 134,
        "rt_sigprocmask" => 135,
        "rt_sigtimedwait" => 137,
        "rt_sigreturn" => 139,
        "setpriority" => 140,
        "getpriority" => 141,
        "reboot" => 142,
        "setregid" => 143,
        "setgid" => 144,
        "setreuid" => 145,
        "setuid" => 146,
        "setresuid" => 147,
        "getresuid" => 148,
        "setresgid" => 149,
        "getresgid" => 150,
        "times" => 153,
        "setpgid" => 154,
        "getpgid" => 155,
        "getsid" => 156,
        "setsid" => 157,
        "getgroups" => 158,
        "uname" => 160,
        "getrusage" => 165,
        "umask" => 166,
        "prctl" => 167,
        "getcpu" => 168,
        "gettimeofday" => 169,
        "getpid" => 172,
        "getppid" => 173,
        "getuid" => 174,
        "geteuid" => 175,
        "getgid" => 176,
        "getegid" => 177,
        "gettid" => 178,
        "sysinfo" => 179,
        "socket" => 198,
        "bind" => 200,
        "listen" => 201,
        "accept" => 202,
        "connect" => 203,
        "getsockname" => 204,
        "sendto" => 206,
        "recvfrom" => 207,
        "setsockopt" => 208,
        "getsockopt" => 209,
        "shutdown" => 210,
        "brk" => 214,
        "munmap" => 215,
        "mremap" => 216,
        "clone" => 220,
        "execve" => 221,
        "mmap" => 222,
        "fadvise64" => 223,
        "mprotect" => 226,
        "madvise" => 233,
        "wait4" => 260,
        "prlimit64" => 261,
        "clock_adjtime" => 266,
        "syncfs" => 267,
        "setns" => 268,
        "sendmmsg" => 269,
        "process_vm_readv" => 270,
        "process_vm_writev" => 271,
        "kcmp" => 272,
        "finit_module" => 273,
        "sched_setattr" => 274,
        "sched_getattr" => 275,
        "getrandom" => 278,
        "memfd_create" => 279,
        "bpf" => 280,
        "execveat" => 281,
        "userfaultfd" => 282,
        "membarrier" => 283,
        "copy_file_range" => 285,
        "preadv2" => 286,
        "pwritev2" => 287,
        "statx" => 291,
        "rseq" => 293,
        "clone3" => 435,
        "faccessat2" => 439,
        "epoll_pwait2" => 441,
        "lstat" => 1039,
        "access" => 1033,
        "pipe" => 1041,
        "poll" => 1068,
        "dup2" => 1041,
        "epoll_create" => 20,
        "epoll_wait" => 22,
        "readlink" => 78,
        "set_tid_address" => 96,
        "fstatfs" => 44,
        "capget" => 90,
        "getrlimit" => 163,
        "setrlimit" => 164,
        _ => return None,
    })
}

#[repr(C)]
#[derive(Clone, Copy)]
pub(crate) struct SockFilter {
    pub code: u16,
    pub jt: u8,
    pub jf: u8,
    pub k: u32,
}

const BPF_LD: u16 = 0x00;
const BPF_W: u16 = 0x00;
const BPF_ABS: u16 = 0x20;
const BPF_JMP: u16 = 0x05;
const BPF_JEQ: u16 = 0x10;
const BPF_ALU: u16 = 0x04;
const BPF_AND: u16 = 0x50;
const BPF_K: u16 = 0x00;
const BPF_RET: u16 = 0x06;
const SECCOMP_RET_ALLOW: u32 = 0x7fff_0000;
const SECCOMP_RET_ERRNO: u32 = 0x0005_0000;
const EPERM: u32 = 1;
const CLONE_NEWUSER: u32 = 0x1000_0000;
const AUDIT_ARCH_X86_64: u32 = 0xC000_003E;
const AUDIT_ARCH_AARCH64: u32 = 0xC000_00B7;

fn expected_audit_arch() -> u32 {
    if cfg!(target_arch = "aarch64") {
        AUDIT_ARCH_AARCH64
    } else {
        AUDIT_ARCH_X86_64
    }
}

pub(crate) fn build_seccomp_filter(
    syscall_names: &[String],
) -> Result<Vec<SockFilter>, WorkerHostError> {
    let mut numbers = syscall_names
        .iter()
        .filter_map(|name| linux_syscall_nr(name))
        .collect::<Vec<_>>();
    numbers.sort_unstable();
    numbers.dedup();
    if numbers.is_empty() {
        return Err(WorkerHostError::new(
            "plugin_class_unsupported",
            "Isolated seccomp allowlist resolved to no syscalls on this architecture",
        ));
    }
    let clone_nr = linux_syscall_nr("clone");
    let mut filters = vec![
        SockFilter {
            code: BPF_LD | BPF_W | BPF_ABS,
            jt: 0,
            jf: 0,
            k: 4,
        },
        SockFilter {
            code: BPF_JMP | BPF_JEQ | BPF_K,
            jt: 1,
            jf: 0,
            k: expected_audit_arch(),
        },
        SockFilter {
            code: BPF_RET | BPF_K,
            jt: 0,
            jf: 0,
            k: SECCOMP_RET_ERRNO | EPERM,
        },
        SockFilter {
            code: BPF_LD | BPF_W | BPF_ABS,
            jt: 0,
            jf: 0,
            k: 0,
        },
    ];
    for number in numbers {
        if clone_nr == Some(number) {
            filters.push(SockFilter {
                code: BPF_JMP | BPF_JEQ | BPF_K,
                jt: 0,
                jf: 5,
                k: number,
            });
            filters.push(SockFilter {
                code: BPF_LD | BPF_W | BPF_ABS,
                jt: 0,
                jf: 0,
                k: 16,
            });
            filters.push(SockFilter {
                code: BPF_ALU | BPF_AND | BPF_K,
                jt: 0,
                jf: 0,
                k: CLONE_NEWUSER,
            });
            filters.push(SockFilter {
                code: BPF_JMP | BPF_JEQ | BPF_K,
                jt: 0,
                jf: 1,
                k: 0,
            });
            filters.push(SockFilter {
                code: BPF_RET | BPF_K,
                jt: 0,
                jf: 0,
                k: SECCOMP_RET_ALLOW,
            });
            filters.push(SockFilter {
                code: BPF_RET | BPF_K,
                jt: 0,
                jf: 0,
                k: SECCOMP_RET_ERRNO | EPERM,
            });
            filters.push(SockFilter {
                code: BPF_LD | BPF_W | BPF_ABS,
                jt: 0,
                jf: 0,
                k: 0,
            });
            continue;
        }
        filters.push(SockFilter {
            code: BPF_JMP | BPF_JEQ | BPF_K,
            jt: 0,
            jf: 1,
            k: number,
        });
        filters.push(SockFilter {
            code: BPF_RET | BPF_K,
            jt: 0,
            jf: 0,
            k: SECCOMP_RET_ALLOW,
        });
    }
    filters.push(SockFilter {
        code: BPF_RET | BPF_K,
        jt: 0,
        jf: 0,
        k: SECCOMP_RET_ERRNO | EPERM,
    });
    Ok(filters)
}

pub(crate) fn seccomp_filter_bytes(filters: &[SockFilter]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(std::mem::size_of_val(filters));
    for filter in filters {
        bytes.extend_from_slice(&filter.code.to_ne_bytes());
        bytes.push(filter.jt);
        bytes.push(filter.jf);
        bytes.extend_from_slice(&filter.k.to_ne_bytes());
    }
    bytes
}

#[cfg(target_os = "linux")]
pub(crate) fn apply_linux_seccomp(filters: &[SockFilter]) -> Result<(), WorkerHostError> {
    #[repr(C)]
    struct SockFprog {
        len: u16,
        filter: *const SockFilter,
    }
    const PR_SET_NO_NEW_PRIVS: i32 = 38;
    const PR_SET_SECCOMP: i32 = 22;
    const SECCOMP_MODE_FILTER: u64 = 2;
    let prog = SockFprog {
        len: u16::try_from(filters.len()).map_err(|_| {
            WorkerHostError::new("plugin_class_unsupported", "seccomp program is too large")
        })?,
        filter: filters.as_ptr(),
    };
    let no_new_privs = unsafe { libc::prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) };
    if no_new_privs != 0 {
        return Err(WorkerHostError::new(
            "plugin_class_unsupported",
            "PR_SET_NO_NEW_PRIVS failed",
        ));
    }
    let applied = unsafe { libc::prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &prog, 0, 0) };
    if applied != 0 {
        return Err(WorkerHostError::new(
            "plugin_class_unsupported",
            "PR_SET_SECCOMP filter failed",
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
pub(crate) fn linux_seccomp_file(
    kind: IsolatedRuntimeKind,
    allow_network: bool,
) -> Result<std::fs::File, WorkerHostError> {
    use std::{
        io::{Seek, SeekFrom, Write},
        os::unix::io::AsRawFd,
    };

    let names = isolated_linux_syscalls(kind, allow_network);
    let filters = build_seccomp_filter(&names)?;
    let bytes = seccomp_filter_bytes(&filters);
    let mut file = tempfile::tempfile()
        .map_err(|error| WorkerHostError::new("isolated_profile_failed", error.to_string()))?;
    file.write_all(&bytes)
        .map_err(|error| WorkerHostError::new("isolated_profile_failed", error.to_string()))?;
    file.seek(SeekFrom::Start(0))
        .map_err(|error| WorkerHostError::new("isolated_profile_failed", error.to_string()))?;
    let fd = file.as_raw_fd();
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) } != 0 {
        return Err(WorkerHostError::new(
            "isolated_profile_failed",
            "could not inherit the seccomp descriptor",
        ));
    }
    Ok(file)
}

#[cfg(windows)]
pub(crate) struct WindowsAppContainerProcess {
    process: isize,
    job: isize,
}

#[cfg(windows)]
impl WindowsAppContainerProcess {
    pub(crate) async fn kill(&mut self) -> std::io::Result<()> {
        use windows_sys::Win32::System::Threading::TerminateProcess;
        let ok = unsafe { TerminateProcess(self.process as _, 1) };
        if ok == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    pub(crate) async fn wait(&mut self) -> std::io::Result<()> {
        use windows_sys::Win32::System::Threading::WaitForSingleObject;
        let handle = self.process;
        tokio::task::spawn_blocking(move || unsafe {
            WaitForSingleObject(handle as _, u32::MAX);
        })
        .await
        .map_err(|error| std::io::Error::other(error.to_string()))?;
        Ok(())
    }
}

#[cfg(windows)]
impl Drop for WindowsAppContainerProcess {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::CloseHandle;
        unsafe {
            if self.job != 0 {
                CloseHandle(self.job as _);
            }
            if self.process != 0 {
                CloseHandle(self.process as _);
            }
        }
    }
}

#[cfg(windows)]
pub(crate) struct WindowsIsolatedIo {
    pub process: WindowsAppContainerProcess,
    pub stdin: std::fs::File,
    pub stdout: std::fs::File,
}

#[cfg(windows)]
pub(crate) fn spawn_windows_appcontainer(
    runtime_bin: &Path,
    package_root: &Path,
    worker_path: &Path,
    grants: &[CapabilityGrant],
    current_dir: &Path,
) -> Result<WindowsIsolatedIo, WorkerHostError> {
    use std::os::windows::{ffi::OsStrExt, io::FromRawHandle, raw::HANDLE as RawHandle};

    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE, HANDLE_FLAG_INHERIT, LocalFree, SetHandleInformation},
        Security::{
            Authorization::{
                EXPLICIT_ACCESS_W, GRANT_ACCESS, GetNamedSecurityInfoW, NO_MULTIPLE_TRUSTEE,
                SE_FILE_OBJECT, SetEntriesInAclW, SetNamedSecurityInfoW, TRUSTEE_IS_SID,
                TRUSTEE_IS_USER, TRUSTEE_W,
            },
            FreeSid,
            Isolation::{CreateAppContainerProfile, DeriveAppContainerSidFromAppContainerName},
            SECURITY_ATTRIBUTES, SECURITY_CAPABILITIES, SID_AND_ATTRIBUTES,
        },
        Storage::FileSystem::{FILE_GENERIC_EXECUTE, FILE_GENERIC_READ, FILE_GENERIC_WRITE},
        System::{
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_JOB_MEMORY,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JobObjectExtendedLimitInformation, SetInformationJobObject,
            },
            Pipes::CreatePipe,
            Threading::{
                CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessW,
                DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT,
                InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST,
                PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, PROCESS_INFORMATION, ResumeThread,
                STARTF_USESTDHANDLES, STARTUPINFOEXW, UpdateProcThreadAttribute,
            },
        },
    };

    // windows-sys 0.59 omits these Win32 items on aarch64; the values are stable.
    const DACL_SECURITY_INFORMATION: u32 = 0x0000_0004;
    const SUB_CONTAINERS_AND_OBJECTS_INHERIT: u32 = 0x0000_0003;

    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn ConvertStringSidToSidW(string_sid: *const u16, sid: *mut *mut core::ffi::c_void) -> i32;
    }

    fn wide(value: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
        value
            .as_ref()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    fn quote_arg(value: &Path) -> String {
        let raw = value.display().to_string();
        if !raw.chars().any(|ch| ch.is_whitespace() || ch == '"') {
            return raw;
        }
        format!("\"{}\"", raw.replace('"', "\\\""))
    }

    fn last_error(context: &str) -> WorkerHostError {
        WorkerHostError::new(
            "plugin_class_unsupported",
            format!("{context}: {}", std::io::Error::last_os_error()),
        )
    }

    fn grant_path(
        sid: *mut core::ffi::c_void,
        path: &Path,
        access: u32,
    ) -> Result<(), WorkerHostError> {
        if !path.exists() {
            return Ok(());
        }
        let mut path_wide = wide(path);
        let mut trustee = TRUSTEE_W {
            pMultipleTrustee: std::ptr::null_mut(),
            MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_USER,
            ptstrName: sid as *mut u16,
        };
        let mut explicit = EXPLICIT_ACCESS_W {
            grfAccessPermissions: access,
            grfAccessMode: GRANT_ACCESS,
            grfInheritance: SUB_CONTAINERS_AND_OBJECTS_INHERIT,
            Trustee: trustee,
        };
        let mut security = std::ptr::null_mut();
        let mut old_dacl = std::ptr::null_mut();
        let status = unsafe {
            GetNamedSecurityInfoW(
                path_wide.as_mut_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut old_dacl,
                std::ptr::null_mut(),
                &mut security,
            )
        };
        if status != 0 {
            return Err(WorkerHostError::new(
                "isolated_profile_failed",
                format!("GetNamedSecurityInfoW({}) failed: {status}", path.display()),
            ));
        }
        let mut new_dacl = std::ptr::null_mut();
        let acl_status = unsafe { SetEntriesInAclW(1, &mut explicit, old_dacl, &mut new_dacl) };
        if acl_status != 0 {
            unsafe { LocalFree(security as _) };
            return Err(WorkerHostError::new(
                "isolated_profile_failed",
                format!("SetEntriesInAclW({}) failed: {acl_status}", path.display()),
            ));
        }
        let set_status = unsafe {
            SetNamedSecurityInfoW(
                path_wide.as_mut_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                new_dacl,
                std::ptr::null_mut(),
            )
        };
        unsafe {
            LocalFree(new_dacl as _);
            LocalFree(security as _);
        }
        if set_status != 0 {
            return Err(WorkerHostError::new(
                "isolated_profile_failed",
                format!(
                    "SetNamedSecurityInfoW({}) failed: {set_status}",
                    path.display()
                ),
            ));
        }
        let _ = trustee;
        Ok(())
    }

    let kind = isolated_runtime_kind(runtime_bin, worker_path);
    let plugin_tmp = std::env::temp_dir();
    let plugin_data = plugin_tmp.join("vibex-isolated-data").join(
        package_root
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("plugin"),
    );
    std::fs::create_dir_all(&plugin_data)
        .map_err(|error| WorkerHostError::new("isolated_profile_failed", error.to_string()))?;

    let raw_name = package_root
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("plugin");
    let cleaned: String = raw_name
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .take(32)
        .collect();
    let profile = format!(
        "VibeX.Iso.{}",
        if cleaned.is_empty() {
            "plugin"
        } else {
            cleaned.as_str()
        }
    );
    let profile_wide = wide(&profile);
    let mut app_sid = std::ptr::null_mut();
    let created = unsafe {
        CreateAppContainerProfile(
            profile_wide.as_ptr(),
            profile_wide.as_ptr(),
            profile_wide.as_ptr(),
            std::ptr::null(),
            0,
            &mut app_sid,
        )
    };
    if created != 0 {
        let derived = unsafe {
            DeriveAppContainerSidFromAppContainerName(profile_wide.as_ptr(), &mut app_sid)
        };
        if derived != 0 || app_sid.is_null() {
            return Err(WorkerHostError::new(
                "plugin_class_unsupported",
                format!("CreateAppContainerProfile failed HRESULT 0x{created:08X}"),
            ));
        }
    }

    let mut capability_sid = std::ptr::null_mut();
    let mut capabilities: Vec<SID_AND_ATTRIBUTES> = Vec::new();
    if grants_allow_network(grants) {
        let internet = wide("S-1-15-3-1");
        if unsafe { ConvertStringSidToSidW(internet.as_ptr(), &mut capability_sid) } == 0 {
            unsafe { FreeSid(app_sid) };
            return Err(last_error("ConvertStringSidToSidW(internetClient)"));
        }
        capabilities.push(SID_AND_ATTRIBUTES {
            Sid: capability_sid,
            Attributes: 0x0000_0004,
        });
    }
    let security_capabilities = SECURITY_CAPABILITIES {
        AppContainerSid: app_sid,
        Capabilities: if capabilities.is_empty() {
            std::ptr::null_mut()
        } else {
            capabilities.as_mut_ptr()
        },
        CapabilityCount: capabilities.len() as u32,
        Reserved: 0,
    };

    let runtime_lock = match runtime_bin.parent() {
        Some(bin_dir) if bin_dir.file_name().is_some_and(|name| name == "bin") => {
            bin_dir.parent().unwrap_or(bin_dir).to_path_buf()
        }
        Some(parent) => parent.to_path_buf(),
        None => runtime_bin.to_path_buf(),
    };
    let read_exec = FILE_GENERIC_READ | FILE_GENERIC_EXECUTE;
    let read_write = FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE;
    grant_path(app_sid, package_root, read_exec)?;
    grant_path(app_sid, &runtime_lock, read_exec)?;
    grant_path(app_sid, runtime_bin, read_exec)?;
    grant_path(app_sid, worker_path, read_exec)?;
    grant_path(app_sid, &plugin_tmp, read_write)?;
    grant_path(app_sid, &plugin_data, read_write)?;

    let mut attr_size = 0usize;
    unsafe { InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut attr_size) };
    if attr_size == 0 {
        unsafe { FreeSid(app_sid) };
        if !capability_sid.is_null() {
            unsafe { LocalFree(capability_sid as _) };
        }
        return Err(last_error("InitializeProcThreadAttributeList(size)"));
    }
    let mut attr_buf = vec![0u8; attr_size];
    let attr_list = attr_buf.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
    if unsafe { InitializeProcThreadAttributeList(attr_list, 1, 0, &mut attr_size) } == 0 {
        unsafe { FreeSid(app_sid) };
        return Err(last_error("InitializeProcThreadAttributeList"));
    }
    if unsafe {
        UpdateProcThreadAttribute(
            attr_list,
            0,
            PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
            (&raw const security_capabilities).cast(),
            std::mem::size_of::<SECURITY_CAPABILITIES>(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    } == 0
    {
        unsafe {
            DeleteProcThreadAttributeList(attr_list);
            FreeSid(app_sid);
        }
        return Err(last_error(
            "UpdateProcThreadAttribute(SECURITY_CAPABILITIES)",
        ));
    }

    let inherit = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: std::ptr::null_mut(),
        bInheritHandle: 1,
    };
    let mut child_stdin_r: HANDLE = std::ptr::null_mut();
    let mut parent_stdin_w: HANDLE = std::ptr::null_mut();
    let mut parent_stdout_r: HANDLE = std::ptr::null_mut();
    let mut child_stdout_w: HANDLE = std::ptr::null_mut();
    if unsafe { CreatePipe(&mut child_stdin_r, &mut parent_stdin_w, &inherit, 0) } == 0
        || unsafe { CreatePipe(&mut parent_stdout_r, &mut child_stdout_w, &inherit, 0) } == 0
    {
        unsafe {
            DeleteProcThreadAttributeList(attr_list);
            FreeSid(app_sid);
        }
        return Err(last_error("CreatePipe"));
    }
    unsafe {
        SetHandleInformation(parent_stdin_w, HANDLE_FLAG_INHERIT, 0);
        SetHandleInformation(parent_stdout_r, HANDLE_FLAG_INHERIT, 0);
    }

    let mut cmdline = quote_arg(runtime_bin);
    match kind {
        IsolatedRuntimeKind::Python => {
            cmdline.push(' ');
            cmdline.push_str(&quote_arg(worker_path));
        }
        IsolatedRuntimeKind::Native => {}
        IsolatedRuntimeKind::Node => {
            cmdline.push_str(" --max-old-space-size=128 ");
            cmdline.push_str(&quote_arg(worker_path));
        }
    }
    let mut cmdline_wide = wide(&cmdline);
    let app_wide = wide(runtime_bin);
    let cwd_wide = wide(current_dir);

    let mut env_block = Vec::<u16>::new();
    for (key, value) in std::env::vars() {
        if key.eq_ignore_ascii_case("NO_COLOR") || key.eq_ignore_ascii_case("VIBEX_PACKAGE_CLASS") {
            continue;
        }
        env_block.extend(format!("{key}={value}").encode_utf16());
        env_block.push(0);
    }
    env_block.extend("NO_COLOR=1".encode_utf16());
    env_block.push(0);
    env_block.extend("VIBEX_PACKAGE_CLASS=isolated".encode_utf16());
    env_block.push(0);
    env_block.push(0);

    let mut startup: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = child_stdin_r;
    startup.StartupInfo.hStdOutput = child_stdout_w;
    startup.StartupInfo.hStdError = child_stdout_w;
    startup.lpAttributeList = attr_list;

    let mut info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    let created_process = unsafe {
        CreateProcessW(
            app_wide.as_ptr(),
            cmdline_wide.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED,
            env_block.as_ptr() as *const _,
            cwd_wide.as_ptr(),
            (&raw const startup.StartupInfo).cast(),
            &mut info,
        )
    };
    unsafe {
        CloseHandle(child_stdin_r);
        CloseHandle(child_stdout_w);
        DeleteProcThreadAttributeList(attr_list);
        FreeSid(app_sid);
        if !capability_sid.is_null() {
            LocalFree(capability_sid as _);
        }
    }
    if created_process == 0 {
        unsafe {
            CloseHandle(parent_stdin_w);
            CloseHandle(parent_stdout_r);
        }
        return Err(last_error("CreateProcessW(AppContainer)"));
    }

    let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if job.is_null() {
        unsafe {
            CloseHandle(info.hThread);
            CloseHandle(info.hProcess);
            CloseHandle(parent_stdin_w);
            CloseHandle(parent_stdout_r);
        }
        return Err(last_error("CreateJobObjectW"));
    }
    let mut job_info = unsafe { std::mem::zeroed::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() };
    job_info.BasicLimitInformation.LimitFlags =
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_JOB_MEMORY;
    job_info.JobMemoryLimit = 256 * 1024 * 1024;
    if unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            (&raw const job_info).cast(),
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    } == 0
        || unsafe { AssignProcessToJobObject(job, info.hProcess) } == 0
    {
        unsafe {
            CloseHandle(job);
            CloseHandle(info.hThread);
            CloseHandle(info.hProcess);
            CloseHandle(parent_stdin_w);
            CloseHandle(parent_stdout_r);
        }
        return Err(last_error("AssignProcessToJobObject"));
    }
    unsafe { ResumeThread(info.hThread) };
    unsafe { CloseHandle(info.hThread) };

    let stdin = unsafe { std::fs::File::from_raw_handle(parent_stdin_w as RawHandle) };
    let stdout = unsafe { std::fs::File::from_raw_handle(parent_stdout_r as RawHandle) };
    Ok(WindowsIsolatedIo {
        process: WindowsAppContainerProcess {
            process: info.hProcess as isize,
            job: job as isize,
        },
        stdin,
        stdout,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recorded_linux_allowlists_omit_network_and_never_syscalls() {
        for kind in [
            IsolatedRuntimeKind::Node,
            IsolatedRuntimeKind::Python,
            IsolatedRuntimeKind::Native,
        ] {
            let names = isolated_linux_syscalls(kind, false);
            assert!(
                !names.is_empty(),
                "{kind:?} Isolated allowlist must not be empty"
            );
            for forbidden in ["socket", "connect", "accept", "bind"]
                .into_iter()
                .chain(NEVER_LINUX.iter().copied())
            {
                assert!(
                    !names.iter().any(|name| name == forbidden),
                    "{kind:?} default allowlist contains {forbidden}"
                );
            }
            assert!(names.iter().any(|name| name == "read"));
            assert!(names.iter().any(|name| name == "write"));
            assert!(names.iter().any(|name| name == "exit_group"));
        }
    }

    #[test]
    fn network_fetch_grant_adds_only_socket_and_connect() {
        let names = isolated_linux_syscalls(IsolatedRuntimeKind::Node, true);
        assert!(names.iter().any(|name| name == "socket"));
        assert!(names.iter().any(|name| name == "connect"));
        assert!(!names.iter().any(|name| name == "accept"));
        assert!(!names.iter().any(|name| name == "bind"));
    }

    #[test]
    fn runtime_kind_and_network_grant_helpers_are_stable() {
        assert_eq!(
            isolated_runtime_kind(Path::new("node"), Path::new("worker.mjs")),
            IsolatedRuntimeKind::Node
        );
        assert_eq!(
            isolated_runtime_kind(Path::new("python"), Path::new("worker.py")),
            IsolatedRuntimeKind::Python
        );
        assert_eq!(
            isolated_runtime_kind(Path::new("hello"), Path::new("hello")),
            IsolatedRuntimeKind::Native
        );
        assert!(grants_allow_network(&[CapabilityGrant {
            capability: "network.fetch".into(),
            scope: serde_json::json!({}),
            trust_tier: "sandboxed_worker".into(),
        }]));
        assert!(!grants_allow_network(&[]));
    }

    #[test]
    fn seccomp_program_allows_listed_syscalls_and_denies_the_rest() {
        let names = isolated_linux_syscalls(IsolatedRuntimeKind::Node, false);
        let filters = build_seccomp_filter(&names).expect("seccomp program");
        assert!(filters.len() > 4);
        assert_eq!(
            filters.last().map(|filter| filter.k),
            Some(SECCOMP_RET_ERRNO | EPERM)
        );
        assert!(filters.iter().any(|filter| filter.k == SECCOMP_RET_ALLOW));
        let bytes = seccomp_filter_bytes(&filters);
        assert_eq!(
            bytes.len(),
            filters.len() * std::mem::size_of::<SockFilter>()
        );
    }
}
