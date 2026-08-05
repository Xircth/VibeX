const WINDOWS_GUI_SUBSYSTEM: &str =
    "#![cfg_attr(target_os = \"windows\", windows_subsystem = \"windows\")]";

#[test]
fn installed_windows_binaries_never_allocate_a_console() {
    for (name, source) in [
        ("vibex", include_str!("../src/main.rs")),
        (
            "vibex_cef_helper",
            include_str!("../src/bin/vibex_cef_helper.rs"),
        ),
    ] {
        assert!(
            source.lines().any(|line| line == WINDOWS_GUI_SUBSYSTEM),
            "{name} must use the Windows GUI subsystem in every build profile"
        );
    }
}
