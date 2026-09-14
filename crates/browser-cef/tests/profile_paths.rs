use std::path::{Path, PathBuf};

use browser_cef::CefRuntimeConfig;
use browser_runtime::BrowserProfile;

#[test]
fn profile_paths_are_isolated_and_never_embed_workspace_path_syntax() {
    let config = CefRuntimeConfig::new(PathBuf::from("/app-data"));

    assert_eq!(
        config.root_cache_path(),
        PathBuf::from("/app-data/chromium")
    );
    assert_eq!(
        config.profile_cache_path(&BrowserProfile::Global),
        Some(PathBuf::from("/app-data/chromium"))
    );
    assert_eq!(
        config.profile_cache_path(&BrowserProfile::Workspace {
            workspace_id: "team/../alpha".to_string(),
        }),
        Some(PathBuf::from(
            "/app-data/chromium/workspace-team_2f_2e_2e_2falpha",
        ))
    );
    assert_eq!(config.profile_cache_path(&BrowserProfile::Ephemeral), None);
}

#[test]
fn disk_profiles_are_the_user_data_dir_or_an_immediate_child() {
    let config = CefRuntimeConfig::new(PathBuf::from("/app-data"));
    let root = config.root_cache_path();
    let profiles = [
        BrowserProfile::Global,
        BrowserProfile::Workspace {
            workspace_id: "5ff512f3-81db-4a61-84a3-e003951ab71f".to_string(),
        },
        BrowserProfile::Workspace {
            workspace_id: "team/../alpha".to_string(),
        },
    ];

    for profile in profiles {
        let path = config
            .profile_cache_path(&profile)
            .expect("disk profiles keep a cache path");
        assert!(
            config.is_supported_disk_profile_path(&path),
            "Chrome runtime rejects nested cache paths such as chromium/profiles/...; \
             {path:?} must be {root:?} or an immediate child"
        );
    }

    assert_eq!(config.profile_cache_path(&BrowserProfile::Ephemeral), None);
    assert!(!config.is_supported_disk_profile_path(&root.join("profiles").join("global")));
}

#[test]
fn packaged_runtime_resources_are_explicit_and_keep_locales_together() {
    let config = CefRuntimeConfig::new(PathBuf::from("/app-data"))
        .with_runtime_resources(PathBuf::from("/bundle/cef"));

    assert_eq!(
        config.runtime_resources_path(),
        Some(Path::new("/bundle/cef"))
    );
    assert_eq!(
        config.runtime_locales_path(),
        Some(PathBuf::from("/bundle/cef/locales"))
    );
}
