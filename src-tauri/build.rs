use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-changed=icons");
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.png");
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed=tauri.dev.generated.conf.json");

    prepare_host_sidecar_stubs();

    #[cfg(target_os = "windows")]
    ensure_windows_medium_integrity_labels();

    tauri_build::build();

    #[cfg(target_os = "windows")]
    println!("cargo:rustc-link-arg-bins=/STACK:16777216");

    #[cfg(target_os = "linux")]
    println!(
        "cargo:rustc-link-arg-bins=-Wl,-rpath,$ORIGIN:$ORIGIN/../lib/vibex:$ORIGIN/../lib/VibeX"
    );
}

fn prepare_host_sidecar_stubs() {
    let manifest_dir = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let triple = std::env::var("TARGET").unwrap_or_else(|_| "unknown".to_string());
    let ext = if cfg!(windows) { ".exe" } else { "" };
    let binaries = manifest_dir.join("binaries");
    let _ = std::fs::create_dir_all(&binaries);
    for name in ["vibex-mcp", "vibex-workflow-mcp"] {
        let path = binaries.join(format!("{name}-{triple}{ext}"));
        if !path.is_file() {
            let _ = std::fs::write(&path, []);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(metadata) = std::fs::metadata(&path) {
                    let mut permissions = metadata.permissions();
                    permissions.set_mode(0o755);
                    let _ = std::fs::set_permissions(&path, permissions);
                }
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn ensure_windows_medium_integrity_labels() {
    use std::{
        os::windows::ffi::OsStrExt,
        path::Path,
        ptr::{null, null_mut},
    };

    type Handle = *mut core::ffi::c_void;
    type Bool = i32;
    type Dword = u32;

    const WRITE_OWNER: Dword = 0x0008_0000;
    const READ_CONTROL: Dword = 0x0002_0000;
    const FILE_SHARE_READ: Dword = 0x0000_0001;
    const FILE_SHARE_WRITE: Dword = 0x0000_0002;
    const FILE_SHARE_DELETE: Dword = 0x0000_0004;
    const OPEN_EXISTING: Dword = 3;
    const FILE_FLAG_BACKUP_SEMANTICS: Dword = 0x0200_0000;
    const FILE_FLAG_OPEN_REPARSE_POINT: Dword = 0x0020_0000;
    const LABEL_SECURITY_INFORMATION: Dword = 0x0000_0010;
    const SDDL_REVISION_1: Dword = 1;
    const INVALID_HANDLE_VALUE: Handle = -1isize as Handle;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateFileW(
            lp_file_name: *const u16,
            dw_desired_access: Dword,
            dw_share_mode: Dword,
            lp_security_attributes: *const core::ffi::c_void,
            dw_creation_disposition: Dword,
            dw_flags_and_attributes: Dword,
            h_template_file: Handle,
        ) -> Handle;
        fn CloseHandle(h_object: Handle) -> Bool;
        fn LocalFree(h_mem: Handle) -> Handle;
    }

    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
            string_security_descriptor: *const u16,
            string_sd_revision: Dword,
            security_descriptor: *mut Handle,
            security_descriptor_size: *mut Dword,
        ) -> Bool;
    }

    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn NtSetSecurityObject(
            handle: Handle,
            security_information: Dword,
            security_descriptor: Handle,
        ) -> i32;
    }

    fn set_sacl(path: &Path, sd: Handle) {
        if !path.exists() {
            return;
        }
        let wide: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        unsafe {
            let handle = CreateFileW(
                wide.as_ptr(),
                WRITE_OWNER | READ_CONTROL,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                null_mut(),
            );
            if !handle.is_null() && handle != INVALID_HANDLE_VALUE {
                let _ = NtSetSecurityObject(handle, LABEL_SECURITY_INFORMATION, sd);
                CloseHandle(handle);
            }
        }
    }

    fn stamp_exes_in_dir(dir: &Path, file_sd: Handle) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
            {
                set_sacl(&path, file_sd);
            }
        }
    }

    let manifest_dir = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let Some(workspace_root) = manifest_dir.parent() else {
        return;
    };
    let target_dir = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| workspace_root.join("target"));

    let dir_sddl: Vec<u16> = "S:P(ML;OICI;NW;;;ME)"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let file_sddl: Vec<u16> = "S:P(ML;;NW;;;ME)"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();

    unsafe {
        let mut dir_sd: Handle = null_mut();
        let mut dir_sd_size: Dword = 0;
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            dir_sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut dir_sd,
            &mut dir_sd_size,
        ) == 0
        {
            return;
        }
        let mut file_sd: Handle = null_mut();
        let mut file_sd_size: Dword = 0;
        let has_file_sd = ConvertStringSecurityDescriptorToSecurityDescriptorW(
            file_sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut file_sd,
            &mut file_sd_size,
        ) != 0;

        let dirs = [
            workspace_root.to_path_buf(),
            manifest_dir.clone(),
            manifest_dir.join("binaries"),
            workspace_root.join("dev_assets"),
            target_dir.clone(),
            target_dir.join(".tauri"),
            target_dir.join(".tauri").join("NSIS"),
            target_dir.join(".tauri").join("NSIS").join("Bin"),
            target_dir.join("debug"),
            target_dir.join("debug").join(".fingerprint"),
            target_dir.join("debug").join("build"),
            target_dir.join("debug").join("bundle"),
            target_dir.join("debug").join("deps"),
            target_dir.join("debug").join("examples"),
            target_dir.join("debug").join("incremental"),
            target_dir.join("debug").join("nsis"),
            target_dir.join("release"),
            target_dir.join("release").join(".fingerprint"),
            target_dir.join("release").join("build"),
            target_dir.join("release").join("bundle"),
            target_dir.join("release").join("deps"),
            target_dir.join("release").join("examples"),
            target_dir.join("release").join("incremental"),
            target_dir.join("release").join("nsis"),
        ];
        for dir in &dirs {
            set_sacl(dir, dir_sd);
        }

        if has_file_sd {
            stamp_exes_in_dir(&manifest_dir.join("binaries"), file_sd);
            stamp_exes_in_dir(&target_dir.join(".tauri").join("NSIS"), file_sd);
            stamp_exes_in_dir(&target_dir.join(".tauri").join("NSIS").join("Bin"), file_sd);
            stamp_exes_in_dir(&target_dir.join("debug"), file_sd);
            stamp_exes_in_dir(&target_dir.join("debug").join("deps"), file_sd);
            stamp_exes_in_dir(&target_dir.join("release"), file_sd);
            LocalFree(file_sd);
        }
        LocalFree(dir_sd);
    }
}
