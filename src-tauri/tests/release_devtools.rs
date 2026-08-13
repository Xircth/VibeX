#[test]
fn release_manifest_does_not_enable_tauri_devtools() {
    let manifest: toml::Value =
        toml::from_str(include_str!("../Cargo.toml")).expect("src-tauri/Cargo.toml must parse");
    let features = manifest
        .get("dependencies")
        .and_then(toml::Value::as_table)
        .and_then(|dependencies| dependencies.get("tauri"))
        .and_then(toml::Value::as_table)
        .and_then(|tauri| tauri.get("features"))
        .and_then(toml::Value::as_array)
        .expect("tauri dependency must declare its feature list");

    assert!(
        !features
            .iter()
            .any(|feature| feature.as_str() == Some("devtools")),
        "the tauri/devtools feature exposes Inspect Element in release builds"
    );
}
