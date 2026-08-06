#[cfg(feature = "cef-host")]
use std::{env, fs, path::PathBuf};

#[cfg(not(feature = "cef-host"))]
fn main() {
    panic!("stage_cef_runtime requires the cef-host feature");
}

#[cfg(feature = "cef-host")]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let profile = env::args().nth(1).unwrap_or_else(|| "release".to_string());
    if profile != "debug" && profile != "release" {
        return Err(format!("unsupported Cargo profile: {profile}").into());
    }
    let workspace = workspace_root()?;
    let target_root = env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| workspace.join("target"));
    let target_path = env::var_os("VIBEX_BUILD_TARGET")
        .or_else(|| env::var_os("TAURI_ENV_TARGET_TRIPLE"))
        .map(|target| target_root.join(target).join(&profile))
        .unwrap_or_else(|| target_root.join(&profile));
    let stage_root = target_root.join("cef-runtime").join(env::consts::OS);
    fs::create_dir_all(&stage_root)?;

    let required_files = stage_platform_runtime(&stage_root, &target_path, &workspace)?;
    let manifest = serde_json::json!({
        "schemaVersion": 1,
        "cefVersion": "150.2.1+150.0.14",
        "platform": env::consts::OS,
        "architecture": env::consts::ARCH,
        "requiredFiles": required_files,
    });
    fs::write(
        stage_root.join("cef-runtime-manifest.json"),
        serde_json::to_vec_pretty(&manifest)?,
    )?;
    println!("staged CEF runtime at {}", stage_root.display());
    Ok(())
}

#[cfg(feature = "cef-host")]
fn workspace_root() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let mut directory = env::current_dir()?;
    loop {
        let manifest = directory.join("Cargo.toml");
        if fs::read_to_string(&manifest).is_ok_and(|contents| contents.contains("[workspace]")) {
            return Ok(directory);
        }
        if !directory.pop() {
            return Err("Cargo workspace root was not found".into());
        }
    }
}

#[cfg(all(feature = "cef-host", target_os = "macos"))]
fn stage_platform_runtime(
    stage_root: &std::path::Path,
    target_path: &std::path::Path,
    workspace: &std::path::Path,
) -> Result<Vec<&'static str>, Box<dyn std::error::Error>> {
    use std::os::unix::fs::symlink;

    use cef::build_util::mac::{BundleInfo, bundle};
    use semver::Version;

    let package: serde_json::Value =
        serde_json::from_slice(&fs::read(workspace.join("package.json"))?)?;
    let app_version = package
        .get("version")
        .and_then(serde_json::Value::as_str)
        .ok_or("root package.json does not contain a string version")?;
    let app_version = Version::parse(app_version)?;

    let app_root = stage_root.join("app");
    let framework_links = stage_root.join("framework-links");
    if app_root.is_dir() {
        fs::remove_dir_all(&app_root)?;
    }
    if framework_links.is_dir() {
        fs::remove_dir_all(&framework_links)?;
    }
    fs::create_dir_all(&app_root)?;
    fs::create_dir_all(&framework_links)?;
    bundle(
        &app_root,
        target_path,
        "vibex",
        "vibex_cef_helper",
        None,
        BundleInfo::new("VibeX", "com.vibex.app", "VibeX", "en", app_version),
    )?;
    let frameworks = app_root.join("vibex.app/Contents/Frameworks");
    let framework_helpers = frameworks
        .join("Chromium Embedded Framework.framework")
        .join("Helpers");
    fs::create_dir_all(&framework_helpers)?;
    for helper_name in [
        "vibex Helper.app",
        "vibex Helper (Alerts).app",
        "vibex Helper (GPU).app",
        "vibex Helper (Plugin).app",
        "vibex Helper (Renderer).app",
    ] {
        fs::rename(
            frameworks.join(helper_name),
            framework_helpers.join(helper_name),
        )?;
        symlink(
            PathBuf::from("Chromium Embedded Framework.framework")
                .join("Helpers")
                .join(helper_name),
            framework_links.join(helper_name),
        )?;
    }
    Ok(vec![
        "app/vibex.app/Contents/Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework",
        "app/vibex.app/Contents/Frameworks/Chromium Embedded Framework.framework/Helpers/vibex Helper.app/Contents/MacOS/vibex Helper",
        "framework-links/vibex Helper.app",
    ])
}

#[cfg(all(feature = "cef-host", target_os = "linux"))]
fn stage_platform_runtime(
    stage_root: &std::path::Path,
    target_path: &std::path::Path,
    _workspace: &std::path::Path,
) -> Result<Vec<&'static str>, Box<dyn std::error::Error>> {
    let executable = cef::build_util::linux::bundle(stage_root, target_path, "vibex")?;
    fs::remove_file(executable)?;
    Ok(vec![
        "libcef.so",
        "icudtl.dat",
        "resources.pak",
        "locales/en-US.pak",
    ])
}

#[cfg(all(feature = "cef-host", target_os = "windows"))]
fn stage_platform_runtime(
    stage_root: &std::path::Path,
    target_path: &std::path::Path,
    _workspace: &std::path::Path,
) -> Result<Vec<&'static str>, Box<dyn std::error::Error>> {
    let executable = cef::build_util::win::bundle(stage_root, target_path, "vibex")?;
    fs::remove_file(executable)?;
    let generated_manifest = stage_root.join("vibex.exe.manifest");
    if generated_manifest.is_file() {
        fs::remove_file(generated_manifest)?;
    }
    Ok(vec![
        "libcef.dll",
        "chrome_elf.dll",
        "icudtl.dat",
        "resources.pak",
        "locales/en-US.pak",
    ])
}
