use application::{AdapterCapabilities, DomainCommand, RegisteredCommand};

#[test]
fn every_host_command_has_a_unique_descriptor_and_scope() {
    let names = RegisteredCommand::host_command_names();
    let descriptors = RegisteredCommand::descriptors();
    assert_eq!(names.len(), descriptors.len());
    let mut seen = std::collections::BTreeSet::new();
    for descriptor in &descriptors {
        assert!(seen.insert(descriptor.name), "{}", descriptor.name);
        assert!(!descriptor.scope.is_empty(), "{}", descriptor.name);
        assert!(names.contains(&descriptor.name), "{}", descriptor.name);
    }
    assert!(
        seen.contains("conversation_attach"),
        "conversation_attach must be registered as a Host command"
    );
    assert!(
        seen.contains("trash_item"),
        "trash_item must be registered as a Host file command"
    );
}

#[test]
fn server_adapter_capabilities_do_not_claim_desktop_tauri() {
    let scopes = DomainCommand::derived_capability_scopes(AdapterCapabilities::server_http());
    assert!(scopes.contains(&"preview.proxy"));
    assert!(scopes.contains(&"offline.read"));
    assert!(scopes.contains(&"notification.summary"));
    assert!(scopes.contains(&"device.pair"));
    assert!(!scopes.contains(&"desktop.tauri"));
}

#[test]
fn desktop_adapter_capabilities_include_desktop_tauri() {
    let scopes = DomainCommand::derived_capability_scopes(AdapterCapabilities::desktop_host());
    assert!(scopes.contains(&"desktop.tauri"));
    assert!(scopes.contains(&"preview.proxy"));
}
