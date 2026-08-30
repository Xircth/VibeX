#[cfg(feature = "cef-host")]
use std::{env, fs, path::PathBuf};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct DesktopBundleIdentity {
    display_name: &'static str,
    identifier: &'static str,
    name: &'static str,
}

struct StageArgs {
    dev_bundle: bool,
    profile: String,
}

fn parse_stage_args<I>(args: I) -> Result<StageArgs, Box<dyn std::error::Error>>
where
    I: IntoIterator<Item = String>,
{
    let mut profile = "release".to_string();
    let mut dev_bundle = false;
    let mut saw_profile = false;
    for arg in args {
        match arg.as_str() {
            "--dev-bundle" => dev_bundle = true,
            "debug" | "release" if !saw_profile => {
                profile = arg;
                saw_profile = true;
            }
            other => return Err(format!("unsupported argument: {other}").into()),
        }
    }
    Ok(StageArgs {
        dev_bundle,
        profile,
    })
}

fn desktop_bundle_identity(dev_bundle: bool) -> DesktopBundleIdentity {
    if dev_bundle {
        DesktopBundleIdentity {
            display_name: "VibeX Dev",
            identifier: "com.vibex.app.dev",
            name: "VibeX Dev",
        }
    } else {
        DesktopBundleIdentity {
            display_name: "VibeX",
            identifier: "com.vibex.app",
            name: "VibeX",
        }
    }
}

#[cfg(not(feature = "cef-host"))]
fn main() {
    panic!("stage_cef_runtime requires the cef-host feature");
}

#[cfg(feature = "cef-host")]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let StageArgs {
        dev_bundle,
        profile,
    } = parse_stage_args(env::args().skip(1))?;
    let identity = desktop_bundle_identity(dev_bundle);
    let workspace = workspace_root()?;
    let target_root = env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| workspace.join("target"));
    let target = env::var_os("VIBEX_BUILD_TARGET")
        .or_else(|| env::var_os("TAURI_ENV_TARGET_TRIPLE"))
        .map(PathBuf::from);
    let target_path = resolve_target_path(&target_root, &profile, target.as_deref());
    let stage_root = target_root.join("cef-runtime").join(env::consts::OS);
    fs::create_dir_all(&stage_root)?;

    let required_files = stage_platform_runtime(&stage_root, &target_path, &workspace, identity)?;
    let manifest = serde_json::json!({
        "schemaVersion": 1,
        "bundleIdentifier": identity.identifier,
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
fn resolve_target_path(
    target_root: &std::path::Path,
    profile: &str,
    target: Option<&std::path::Path>,
) -> PathBuf {
    let default_path = target_root.join(profile);
    let Some(target) = target else {
        return default_path;
    };
    target_root.join(target).join(profile)
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
    identity: DesktopBundleIdentity,
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
        BundleInfo::new(
            identity.name,
            identity.identifier,
            identity.display_name,
            "en",
            app_version,
        ),
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

#[cfg(test)]
mod identity_tests {
    use super::{desktop_bundle_identity, parse_stage_args};

    #[test]
    fn product_and_dev_bundles_use_distinct_identifiers() {
        let product = desktop_bundle_identity(false);
        let dev = desktop_bundle_identity(true);
        assert_eq!(product.identifier, "com.vibex.app");
        assert_eq!(product.name, "VibeX");
        assert_eq!(dev.identifier, "com.vibex.app.dev");
        assert_eq!(dev.name, "VibeX Dev");
        assert_ne!(product.identifier, dev.identifier);
    }

    #[test]
    fn parse_stage_args_defaults_to_the_product_release_bundle() {
        let args = parse_stage_args(std::iter::empty::<String>()).expect("empty args");
        assert_eq!(args.profile, "release");
        assert!(!args.dev_bundle);
    }

    #[test]
    fn parse_stage_args_accepts_dev_bundle_after_the_profile() {
        let args = parse_stage_args(["debug".to_string(), "--dev-bundle".to_string()])
            .expect("dev bundle args");
        assert_eq!(args.profile, "debug");
        assert!(args.dev_bundle);
    }
}

#[cfg(all(test, feature = "cef-host"))]
mod tests {
    use std::fs;

    use super::resolve_target_path;

    #[test]
    fn uses_target_directory_when_it_contains_the_app_binary() {
        let temp = tempfile::tempdir().unwrap();
        let target_path = temp.path().join("aarch64-apple-darwin/release");
        fs::create_dir_all(&target_path).unwrap();
        fs::write(
            target_path.join(format!("vibex{}", std::env::consts::EXE_SUFFIX)),
            [],
        )
        .unwrap();

        assert_eq!(
            resolve_target_path(
                temp.path(),
                "release",
                Some(std::path::Path::new("aarch64-apple-darwin")),
            ),
            target_path,
        );
    }

    #[test]
    fn uses_target_triple_directory_before_the_app_binary_exists() {
        let temp = tempfile::tempdir().unwrap();

        assert_eq!(
            resolve_target_path(
                temp.path(),
                "release",
                Some(std::path::Path::new("aarch64-apple-darwin")),
            ),
            temp.path().join("aarch64-apple-darwin/release"),
        );
    }
}

#[cfg(all(feature = "cef-host", target_os = "linux"))]
fn stage_platform_runtime(
    stage_root: &std::path::Path,
    target_path: &std::path::Path,
    _workspace: &std::path::Path,
    _identity: DesktopBundleIdentity,
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
    _identity: DesktopBundleIdentity,
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
