use std::path::Path;

use agents::AgentId;
use api_types::{
    AgentEnvironmentDiagnosticCheckView, AgentEnvironmentDiagnosticLevel, AgentPreflightItemView,
};

use super::diagnostics_and_env::check;

pub(super) const LEGACY_SHIM_REPAIR_DETAIL: &str = "已升级至原生驱动引擎，请安装官方 CLI 运行时";

pub(super) fn is_native_engine_profile(agent_id: &AgentId) -> bool {
    crate::agent_install::is_native_engine_profile(agent_id)
}

pub(super) fn runtime_preflight_item_label(_native_engine: bool) -> &'static str {
    "运行入口"
}

pub(super) struct PrimaryRuntimePreflightInput<'a> {
    pub retired: bool,
    pub native_engine: bool,
    pub acp_ok: bool,
    pub legacy_shim_locked: bool,
    pub has_recorded_component: bool,
    pub acp_error: Option<&'a str>,
    pub external_installer_url: Option<&'a str>,
    pub adapter_relation: Option<agents::AcpAdapterRelation>,
    pub vendor_cli_path: Option<&'a Path>,
    pub version: Option<String>,
    pub path: Option<String>,
    pub repairable: bool,
}

pub(super) fn build_primary_runtime_preflight_item(
    input: PrimaryRuntimePreflightInput<'_>,
) -> AgentPreflightItemView {
    let ok = !input.retired && input.acp_ok;
    let detail = if input.retired {
        "此 Agent 仅保留历史记录。".to_string()
    } else if input.acp_ok {
        String::new()
    } else if input.native_engine && input.legacy_shim_locked {
        LEGACY_SHIM_REPAIR_DETAIL.to_string()
    } else if let Some(error) = input.acp_error {
        error.to_string()
    } else if input.external_installer_url.is_some() {
        "Kiro CLI 在当前系统通过官方安装器分发，请先安装 kiro-cli 后点击立即检查。".to_string()
    } else if input.native_engine {
        if input.has_recorded_component {
            "已记录安装路径，但找不到原生引擎 CLI 可执行文件。".to_string()
        } else {
            "未发现官方 CLI 运行时，请点击安装运行时或在终端安装后重试。".to_string()
        }
    } else if !input.has_recorded_component {
        acp_missing_preflight_detail(input.adapter_relation, input.vendor_cli_path)
    } else {
        "已记录安装路径，但找不到 ACP 可执行文件。".to_string()
    };

    AgentPreflightItemView {
        id: "acp".to_string(),
        label: runtime_preflight_item_label(input.native_engine).to_string(),
        status: if ok { "pass" } else { "fail" }.to_string(),
        detail,
        version: nonempty_preflight_text(input.version),
        path: nonempty_preflight_text(input.path),
        source: None,
        repairable: !input.retired && input.repairable,
        update_available: false,
        available_version: None,
        update_group: None,
    }
}

pub(super) fn nonempty_preflight_text(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}

pub(super) fn acp_missing_preflight_detail(
    relation: Option<agents::AcpAdapterRelation>,
    vendor_cli_path: Option<&Path>,
) -> String {
    match (relation, vendor_cli_path) {
        (Some(relation), Some(path)) => format!(
            "已检测到 {} ({})，但未发现 ACP 适配器；适配器与 CLI 共用 {} 登录态。",
            relation.native_label,
            path.display(),
            relation.shared_config_dir
        ),
        (Some(relation), None) => format!(
            "未发现 ACP 安装组件（适配器与 {} 共用 {} 登录态）。",
            relation.native_label, relation.shared_config_dir
        ),
        (None, _) => "未发现 ACP 安装组件。".to_string(),
    }
}

pub(super) fn vendor_cli_diagnostic_check(
    relation: agents::AcpAdapterRelation,
    acp_present: bool,
    vendor_cli_path: Option<&Path>,
) -> AgentEnvironmentDiagnosticCheckView {
    let value = match vendor_cli_path {
        Some(path) if !acp_present => format!(
            "{} ({}) · 共享 {} 登录态（仍需安装 ACP 适配器）",
            relation.native_label,
            path.display(),
            relation.shared_config_dir
        ),
        Some(path) => format!(
            "{} ({}) · 共享 {}",
            relation.native_label,
            path.display(),
            relation.shared_config_dir
        ),
        None => format!(
            "NOT RESOLVED ({}) · 共享 {}",
            relation.native_cmd, relation.shared_config_dir
        ),
    };
    let level = match (acp_present, vendor_cli_path.is_some()) {
        (false, true) => AgentEnvironmentDiagnosticLevel::Warning,
        (true, true) => AgentEnvironmentDiagnosticLevel::Ok,
        (_, false) => AgentEnvironmentDiagnosticLevel::Info,
    };
    check(
        "vendor_cli",
        "agents.environmentDiagnosticVendorCli",
        value,
        level,
        None,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn primary_runtime_preflight_item_normalizes_blank_version_and_marks_retired_history_only() {
        let blank_version = build_primary_runtime_preflight_item(PrimaryRuntimePreflightInput {
            retired: false,
            native_engine: true,
            acp_ok: true,
            legacy_shim_locked: false,
            has_recorded_component: true,
            acp_error: None,
            external_installer_url: None,
            adapter_relation: None,
            vendor_cli_path: None,
            version: Some("  ".to_string()),
            path: Some("/usr/local/bin/codex".to_string()),
            repairable: true,
        });
        assert_eq!(blank_version.status, "pass");
        assert_eq!(blank_version.version, None);
        assert_eq!(blank_version.path.as_deref(), Some("/usr/local/bin/codex"));

        let retired = build_primary_runtime_preflight_item(PrimaryRuntimePreflightInput {
            retired: true,
            native_engine: false,
            acp_ok: true,
            legacy_shim_locked: false,
            has_recorded_component: true,
            acp_error: None,
            external_installer_url: None,
            adapter_relation: None,
            vendor_cli_path: None,
            version: Some("1.0.0".to_string()),
            path: None,
            repairable: true,
        });
        assert_eq!(retired.status, "fail");
        assert!(!retired.repairable);
        assert_eq!(retired.detail, "此 Agent 仅保留历史记录。");
    }

    #[test]
    fn vendor_cli_diagnostics_distinguish_adapter_missing_with_cli_vs_both_missing() {
        let relation = agents::acp_adapter_relation("zcode").expect("zcode wrapper relation");
        let cli_path = Path::new("/Users/alice/.local/bin/zcode");

        let detail_with_cli = acp_missing_preflight_detail(Some(relation), Some(cli_path));
        assert!(detail_with_cli.contains("ZCode CLI"));
        assert!(detail_with_cli.contains("~/.zcode"));
        assert!(detail_with_cli.contains("未发现 ACP 适配器"));

        let detail_without_cli = acp_missing_preflight_detail(Some(relation), None);
        assert!(detail_without_cli.contains("未发现 ACP 安装组件"));
        assert!(detail_without_cli.contains("~/.zcode"));

        let check_missing_adapter_with_cli =
            vendor_cli_diagnostic_check(relation, false, Some(cli_path));
        assert_eq!(
            check_missing_adapter_with_cli.level,
            AgentEnvironmentDiagnosticLevel::Warning
        );
        assert!(check_missing_adapter_with_cli.value.contains("~/.zcode"));
        assert!(
            check_missing_adapter_with_cli
                .value
                .contains("仍需安装 ACP 适配器")
        );

        let check_both_missing = vendor_cli_diagnostic_check(relation, false, None);
        assert_eq!(
            check_both_missing.level,
            AgentEnvironmentDiagnosticLevel::Info
        );
        assert!(check_both_missing.value.contains("NOT RESOLVED (zcode)"));
    }

    #[test]
    fn native_engine_preflight_item_uses_unified_runtime_entry_label_and_migrates_legacy_shims() {
        assert!(is_native_engine_profile(
            &AgentId::parse("claude_code").unwrap()
        ));
        assert!(is_native_engine_profile(&AgentId::parse("codex").unwrap()));
        assert!(agents::acp_adapter_relation("claude_code").is_none());
        assert!(agents::acp_adapter_relation("codex").is_none());

        let ready_item = build_primary_runtime_preflight_item(PrimaryRuntimePreflightInput {
            retired: false,
            native_engine: true,
            acp_ok: true,
            legacy_shim_locked: false,
            has_recorded_component: true,
            acp_error: None,
            external_installer_url: None,
            adapter_relation: None,
            vendor_cli_path: None,
            version: Some("2.1.325".to_string()),
            path: Some("/Users/alice/.local/bin/claude".to_string()),
            repairable: true,
        });
        assert_eq!(ready_item.id, "acp");
        assert_eq!(ready_item.label, "运行入口");
        assert_eq!(ready_item.status, "pass");
        assert!(ready_item.detail.is_empty());

        let acp_item = build_primary_runtime_preflight_item(PrimaryRuntimePreflightInput {
            retired: false,
            native_engine: false,
            acp_ok: true,
            legacy_shim_locked: false,
            has_recorded_component: true,
            acp_error: None,
            external_installer_url: None,
            adapter_relation: None,
            vendor_cli_path: None,
            version: Some("1.0.0".to_string()),
            path: Some("/usr/local/bin/pi-acp".to_string()),
            repairable: true,
        });
        assert_eq!(acp_item.label, "运行入口");

        let missing_item = build_primary_runtime_preflight_item(PrimaryRuntimePreflightInput {
            retired: false,
            native_engine: true,
            acp_ok: false,
            legacy_shim_locked: false,
            has_recorded_component: false,
            acp_error: None,
            external_installer_url: None,
            adapter_relation: None,
            vendor_cli_path: None,
            version: None,
            path: None,
            repairable: true,
        });
        assert_eq!(missing_item.label, "运行入口");
        assert_eq!(missing_item.status, "fail");
        assert!(!missing_item.detail.contains("ACP"));

        let legacy_shim_item = build_primary_runtime_preflight_item(PrimaryRuntimePreflightInput {
            retired: false,
            native_engine: true,
            acp_ok: false,
            legacy_shim_locked: true,
            has_recorded_component: true,
            acp_error: None,
            external_installer_url: None,
            adapter_relation: None,
            vendor_cli_path: None,
            version: None,
            path: None,
            repairable: true,
        });
        assert_eq!(legacy_shim_item.label, "运行入口");
        assert_eq!(legacy_shim_item.status, "fail");
        assert_eq!(legacy_shim_item.detail, LEGACY_SHIM_REPAIR_DETAIL);
    }
}
