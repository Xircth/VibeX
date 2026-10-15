use std::{fs, path::PathBuf};

/// Filesystem roots a desktop-client probe may read.
///
/// Every root is checked, including roots that do not belong to the current
/// operating system. Tests plant a macOS bundle on Windows without shelling
/// out or enumerating protected directories such as `WindowsApps`.
#[derive(Debug, Clone)]
pub struct DesktopClientRoots {
    pub local_app_data: PathBuf,
    pub roaming_app_data: PathBuf,
    pub macos_applications: Vec<PathBuf>,
    pub linux_application_dirs: Vec<PathBuf>,
}

pub fn current_desktop_client_roots() -> DesktopClientRoots {
    let home = dirs::home_dir().unwrap_or_default();
    let local_app_data = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join("AppData").join("Local"));
    let roaming_app_data = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join("AppData").join("Roaming"));
    DesktopClientRoots {
        local_app_data,
        roaming_app_data,
        macos_applications: vec![PathBuf::from("/Applications"), home.join("Applications")],
        linux_application_dirs: vec![
            PathBuf::from("/usr/share/applications"),
            home.join(".local").join("share").join("applications"),
        ],
    }
}

/// Returns the first existing desktop client for a known Agent.
///
/// The path is evidence that the product is installed. It is not a CLI
/// executable and must not be stored as `local_runtime`.
pub fn discover_desktop_client(agent_id: &str, roots: &DesktopClientRoots) -> Option<PathBuf> {
    let spec = spec_for(agent_id)?;
    for directory in &roots.macos_applications {
        for name in spec.macos_apps {
            let candidate = directory.join(name);
            if candidate.is_dir() {
                return Some(candidate);
            }
        }
    }
    for relative in spec.windows_files {
        let candidate = roots.local_app_data.join(relative);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    for (parent, executable) in spec.windows_nested {
        let parent_dir = roots.local_app_data.join(parent);
        let Ok(entries) = fs::read_dir(&parent_dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let candidate = entry.path().join(executable);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    let packages = roots.local_app_data.join("Packages");
    if let Ok(entries) = fs::read_dir(&packages) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if spec
                .package_prefixes
                .iter()
                .any(|prefix| name.starts_with(prefix))
            {
                return Some(entry.path());
            }
        }
    }
    if let Some(shortcut) = find_shortcut(
        &roots
            .roaming_app_data
            .join("Microsoft")
            .join("Windows")
            .join("Start Menu")
            .join("Programs"),
        spec.shortcuts,
    ) {
        return Some(shortcut);
    }
    for directory in &roots.linux_application_dirs {
        for name in spec.linux_desktops {
            let candidate = directory.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

struct DesktopSpec {
    macos_apps: &'static [&'static str],
    windows_files: &'static [&'static str],
    windows_nested: &'static [(&'static str, &'static str)],
    package_prefixes: &'static [&'static str],
    shortcuts: &'static [&'static str],
    linux_desktops: &'static [&'static str],
}

fn spec_for(agent_id: &str) -> Option<DesktopSpec> {
    Some(match agent_id {
        "codex" => DesktopSpec {
            macos_apps: &["ChatGPT.app"],
            windows_files: &[
                r"Programs\ChatGPT\ChatGPT.exe",
                r"OpenAI\ChatGPT\ChatGPT.exe",
            ],
            windows_nested: &[],
            package_prefixes: &["OpenAI.Codex", "OpenAI.ChatGPT"],
            shortcuts: &["ChatGPT.lnk"],
            linux_desktops: &[],
        },
        "claude_code" => DesktopSpec {
            macos_apps: &["Claude.app"],
            windows_files: &[r"Programs\Claude\Claude.exe"],
            windows_nested: &[("AnthropicClaude", "claude.exe")],
            package_prefixes: &["Claude_"],
            shortcuts: &["Claude.lnk"],
            linux_desktops: &[],
        },
        "opencode" => DesktopSpec {
            macos_apps: &["OpenCode.app"],
            windows_files: &[
                r"Programs\OpenCode\OpenCode.exe",
                r"Programs\@opencode-aidesktop\OpenCode.exe",
                r"OpenCode\OpenCode.exe",
            ],
            windows_nested: &[],
            package_prefixes: &[],
            shortcuts: &["OpenCode.lnk"],
            linux_desktops: &["opencode.desktop"],
        },
        "cursor" => DesktopSpec {
            macos_apps: &["Cursor.app"],
            windows_files: &[r"Programs\cursor\Cursor.exe", r"Programs\Cursor\Cursor.exe"],
            windows_nested: &[],
            package_prefixes: &[],
            shortcuts: &["Cursor.lnk"],
            linux_desktops: &["cursor.desktop"],
        },
        "antigravity" => DesktopSpec {
            macos_apps: &["Google Antigravity.app", "Antigravity.app"],
            windows_files: &[r"Programs\Antigravity\Antigravity.exe"],
            windows_nested: &[],
            package_prefixes: &[],
            shortcuts: &["Antigravity.lnk"],
            linux_desktops: &["antigravity.desktop"],
        },
        _ => return None,
    })
}

fn find_shortcut(programs: &std::path::Path, names: &[&str]) -> Option<PathBuf> {
    let entries = fs::read_dir(programs).ok()?;
    let mut nested = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() && file_name_is(&path, names) {
            return Some(path);
        }
        if path.is_dir() {
            nested.push(path);
        }
    }
    for directory in nested {
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() && file_name_is(&path, names) {
                return Some(path);
            }
        }
    }
    None
}

fn file_name_is(path: &std::path::Path, names: &[&str]) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            names
                .iter()
                .any(|candidate| candidate.eq_ignore_ascii_case(name))
        })
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::{DesktopClientRoots, discover_desktop_client};

    fn roots(root: &std::path::Path) -> DesktopClientRoots {
        DesktopClientRoots {
            local_app_data: root.join("Local"),
            roaming_app_data: root.join("Roaming"),
            macos_applications: vec![root.join("Applications")],
            linux_application_dirs: vec![root.join("applications")],
        }
    }

    fn touch(path: &std::path::Path) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, b"ok").unwrap();
    }

    #[test]
    fn chatgpt_desktop_marks_codex_without_inventing_a_cli() {
        let root = std::env::temp_dir().join(format!("vibex-desktop-codex-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let executable = root
            .join("Local")
            .join("Programs")
            .join("ChatGPT")
            .join("ChatGPT.exe");
        touch(&executable);

        let found = discover_desktop_client("codex", &roots(&root)).unwrap();

        assert_eq!(found, executable);
        assert!(discover_desktop_client("pi", &roots(&root)).is_none());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn claude_app_bundle_and_nested_windows_install_count() {
        let root =
            std::env::temp_dir().join(format!("vibex-desktop-claude-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let bundle = root.join("Applications").join("Claude.app");
        fs::create_dir_all(&bundle).unwrap();
        assert_eq!(
            discover_desktop_client("claude_code", &roots(&root)).unwrap(),
            bundle
        );

        let _ = fs::remove_dir_all(&root);
        let nested = root
            .join("Local")
            .join("AnthropicClaude")
            .join("app-1.2.3")
            .join("claude.exe");
        touch(&nested);
        assert_eq!(
            discover_desktop_client("claude_code", &roots(&root)).unwrap(),
            nested
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn package_prefix_and_start_menu_shortcut_count() {
        let root =
            std::env::temp_dir().join(format!("vibex-desktop-package-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let package = root
            .join("Local")
            .join("Packages")
            .join("OpenAI.ChatGPT_2p2nqsd0c76g0");
        fs::create_dir_all(&package).unwrap();
        assert_eq!(
            discover_desktop_client("codex", &roots(&root)).unwrap(),
            package
        );

        let _ = fs::remove_dir_all(&root);
        let shortcut = root
            .join("Roaming")
            .join("Microsoft")
            .join("Windows")
            .join("Start Menu")
            .join("Programs")
            .join("OpenCode")
            .join("OpenCode.lnk");
        touch(&shortcut);
        assert_eq!(
            discover_desktop_client("opencode", &roots(&root)).unwrap(),
            shortcut
        );
        assert!(discover_desktop_client("deepseek_harness", &roots(&root)).is_none());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn cursor_and_antigravity_desktops_are_recognized() {
        let root =
            std::env::temp_dir().join(format!("vibex-desktop-editors-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let cursor = root.join("applications").join("cursor.desktop");
        touch(&cursor);
        assert_eq!(
            discover_desktop_client("cursor", &roots(&root)).unwrap(),
            cursor
        );
        let app = root.join("Applications").join("Antigravity.app");
        fs::create_dir_all(&app).unwrap();
        assert_eq!(
            discover_desktop_client("antigravity", &roots(&root)).unwrap(),
            app
        );
        let _ = fs::remove_dir_all(&root);
    }
}
