//! VibeX-curated community ACP adapters that are not yet in the official
//! Registry. These are form templates for the user-declared install path.
//! They are not official Registry entries and must not be labeled as verified.

use api_types::UserAgentDistributionKind;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CommunityAcpPreset {
    pub preset_id: &'static str,
    pub agent_id: &'static str,
    pub display_name: &'static str,
    pub description: &'static str,
    pub authors: &'static [&'static str],
    pub repository: &'static str,
    pub version: &'static str,
    pub distribution_kind: UserAgentDistributionKind,
    pub distribution_json: &'static str,
    pub icon_light: &'static str,
    pub icon_dark: &'static str,
}

const DEEPSEEK_HARNESS_DISTRIBUTION: &str = r#"{"npx":{"package":"deepseek-acp@0.3.0","args":[],"env":{},"integrity":"sha512-Mj3vEK/RY6+M0U1CWnAwGJ0A1ylI4lIg0CwmwiPTCl8V84syvug4jM6GzzjhDhhKaxGiJFtAOOCx1eF6yAEAfQ=="}}"#;

const COMMUNITY_ACP_PRESETS: &[CommunityAcpPreset] = &[CommunityAcpPreset {
    preset_id: "deepseek-acp",
    agent_id: "deepseek_harness",
    display_name: "DeepSeek Harness",
    description: "Community ACP adapter for DeepSeek Harness",
    authors: &["xintaofei"],
    repository: "https://github.com/xintaofei/deepseek-acp",
    version: "0.3.0",
    distribution_kind: UserAgentDistributionKind::Npx,
    distribution_json: DEEPSEEK_HARNESS_DISTRIBUTION,
    icon_light: "/agents/deepseek-harness-light.svg",
    icon_dark: "/agents/deepseek-harness-dark.svg",
}];

pub fn bundled_community_acp_presets() -> &'static [CommunityAcpPreset] {
    COMMUNITY_ACP_PRESETS
}

#[cfg(test)]
mod tests {
    use api_types::AgentId;

    use super::*;
    use crate::user_definition::UserAgentDefinition;

    #[test]
    fn deepseek_harness_preset_is_a_valid_user_definition() {
        let preset = bundled_community_acp_presets()
            .iter()
            .find(|preset| preset.preset_id == "deepseek-acp")
            .expect("DeepSeek Harness preset");
        let definition = UserAgentDefinition::parse(
            AgentId::parse(preset.agent_id).unwrap(),
            preset.display_name.to_string(),
            preset.description.to_string(),
            preset.version.to_string(),
            preset.distribution_kind,
            preset.distribution_json,
        )
        .expect("preset must parse as a locked user definition");
        assert_eq!(definition.version, "0.3.0");
        assert_eq!(
            definition.distributions.npx.as_ref().unwrap().package,
            "deepseek-acp@0.3.0"
        );
    }
}
