pub fn current_platform() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "windows",
        other => other,
    };
    let arch = std::env::consts::ARCH;
    format!("{os}-{arch}")
}
