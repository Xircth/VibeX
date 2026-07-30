//! App-bundled declarations for Agents that receive first-class presentation
//! and proactive local detection.
//!
//! A profile is data, not an alternate runtime path. Registry Agents and
//! profile-backed Agents use the same management, installation, ACP and
//! session services. The extra declarations here are facts the remote Registry
//! cannot safely provide: stable identity binding, component topology,
//! release-pinned trust evidence, official local candidates and known native
//! configuration fields.

use api_types::AgentId;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProfileTopology {
    NativeAcp,
    AdapterBacked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProfileComponent {
    AgentRuntime,
    AcpAdapter,
    CombinedRuntime,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileBinaryArtifact {
    pub platform: &'static str,
    pub archive_url: &'static str,
    pub sha256: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProfileInstallSource {
    Npx {
        component: ProfileComponent,
        package: &'static str,
        version: &'static str,
        command: &'static str,
        args: &'static [&'static str],
        node_requirement: &'static str,
        integrity: &'static str,
    },
    Binary {
        component: ProfileComponent,
        version: &'static str,
        command: &'static str,
        args: &'static [&'static str],
        artifacts: Vec<ProfileBinaryArtifact>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileIcon {
    pub light: &'static str,
    pub dark: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileRegistryBinding {
    pub registry_id: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileExternalCandidate {
    pub component: ProfileComponent,
    pub executable: &'static str,
    pub version_args: &'static [&'static str],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeConfigFormat {
    Json,
    Toml,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeConfigFieldKind {
    Text,
    Secret,
    Select,
    Boolean,
    Number,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeConfigField {
    pub field_id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub path: &'static [&'static str],
    pub kind: NativeConfigFieldKind,
    pub options: &'static [(&'static str, &'static str)],
    /// Some auth stores use a tagged object. When this field is written,
    /// write this sibling value as well (for example `{ type: "api" }`).
    pub object_discriminator: Option<(&'static str, &'static str)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeConfigBinding {
    pub binding_id: &'static str,
    pub home_relative_path: &'static str,
    pub directory_override_env: Option<&'static str>,
    pub override_relative_path: &'static str,
    pub format: NativeConfigFormat,
    pub fields: &'static [NativeConfigField],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthenticationPrecedence {
    AccountThenApiKey,
    ApiKeyThenAccount,
    SingleSource,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuiltInProfile {
    pub agent_id: AgentId,
    pub display_name: &'static str,
    pub description: &'static str,
    pub icon: ProfileIcon,
    pub registry_binding: Option<ProfileRegistryBinding>,
    pub topology: ProfileTopology,
    pub supported_platforms: &'static [&'static str],
    pub install_sources: Vec<ProfileInstallSource>,
    pub external_candidates: &'static [ProfileExternalCandidate],
    /// Adapter-specific environment variable that must point to the separately
    /// installed local Runtime. `None` means the ACP executable is the Runtime,
    /// or the adapter contract resolves the Runtime from the lock-owned PATH.
    pub runtime_executable_env: Option<&'static str>,
    pub native_config: &'static [NativeConfigBinding],
    pub authentication_precedence: AuthenticationPrecedence,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistryEntryIdentity {
    pub registry_id: String,
    pub display_name: String,
}

#[derive(Debug, Clone)]
pub struct BuiltInProfileCatalog {
    profiles: Vec<BuiltInProfile>,
}

impl BuiltInProfileCatalog {
    pub fn bundled() -> Self {
        Self {
            profiles: vec![
                claude_code_profile(),
                codex_profile(),
                opencode_profile(),
                pi_profile(),
            ],
        }
    }

    pub fn profiles(&self) -> &[BuiltInProfile] {
        &self.profiles
    }

    pub fn profile(&self, agent_id: &AgentId) -> Option<&BuiltInProfile> {
        self.profiles
            .iter()
            .find(|profile| &profile.agent_id == agent_id)
    }

    /// Resolve only an explicit stable Registry id binding. Display names are
    /// intentionally ignored: they are mutable metadata and may collide.
    pub fn resolve_registry_entry(&self, entry: &RegistryEntryIdentity) -> Option<&AgentId> {
        self.profiles.iter().find_map(|profile| {
            let binding = profile.registry_binding.as_ref()?;
            (binding.registry_id == entry.registry_id).then_some(&profile.agent_id)
        })
    }
}

const DESKTOP_PLATFORMS: &[&str] = &[
    "darwin-aarch64",
    "darwin-x86_64",
    "linux-aarch64",
    "linux-x86_64",
    "windows-aarch64",
    "windows-x86_64",
];

const CLAUDE_CANDIDATES: &[ProfileExternalCandidate] = &[
    ProfileExternalCandidate {
        component: ProfileComponent::AgentRuntime,
        executable: "claude",
        version_args: &["--version"],
    },
    ProfileExternalCandidate {
        component: ProfileComponent::AcpAdapter,
        executable: "claude-agent-acp",
        version_args: &["--version"],
    },
];
const CODEX_CANDIDATES: &[ProfileExternalCandidate] = &[
    ProfileExternalCandidate {
        component: ProfileComponent::AgentRuntime,
        executable: "codex",
        version_args: &["--version"],
    },
    ProfileExternalCandidate {
        component: ProfileComponent::AcpAdapter,
        executable: "codex-acp",
        version_args: &["--version"],
    },
];
const OPENCODE_CANDIDATES: &[ProfileExternalCandidate] = &[ProfileExternalCandidate {
    component: ProfileComponent::CombinedRuntime,
    executable: "opencode",
    version_args: &["--version"],
}];
const PI_CANDIDATES: &[ProfileExternalCandidate] = &[
    ProfileExternalCandidate {
        component: ProfileComponent::AgentRuntime,
        executable: "pi",
        version_args: &["--version"],
    },
    ProfileExternalCandidate {
        component: ProfileComponent::AcpAdapter,
        executable: "pi-acp",
        version_args: &["--version"],
    },
];

const EMPTY_OPTIONS: &[(&str, &str)] = &[];
const EFFORT_OPTIONS: &[(&str, &str)] = &[
    ("low", "低"),
    ("medium", "中"),
    ("high", "高"),
    ("xhigh", "极高"),
];
const CLAUDE_PERMISSION_OPTIONS: &[(&str, &str)] = &[
    ("default", "默认询问"),
    ("acceptEdits", "自动接受编辑"),
    ("plan", "计划模式"),
    ("bypassPermissions", "跳过权限确认"),
];
const CLAUDE_UPDATE_OPTIONS: &[(&str, &str)] = &[("stable", "稳定版"), ("latest", "最新版")];
const CLAUDE_SETTINGS_FIELDS: &[NativeConfigField] = &[
    text_field(
        "anthropic_base_url",
        "API URL",
        "Anthropic API 或兼容网关地址",
        &["env", "ANTHROPIC_BASE_URL"],
    ),
    secret_field(
        "anthropic_api_key",
        "API Key",
        "写入 Claude Code 的 ANTHROPIC_API_KEY",
        &["env", "ANTHROPIC_API_KEY"],
    ),
    text_field(
        "model",
        "主模型",
        "新会话默认使用的模型或模型别名",
        &["model"],
    ),
    text_field(
        "haiku_model",
        "Haiku 默认模型",
        "haiku 别名解析到的模型",
        &["env", "ANTHROPIC_DEFAULT_HAIKU_MODEL"],
    ),
    text_field(
        "sonnet_model",
        "Sonnet 默认模型",
        "sonnet 别名解析到的模型",
        &["env", "ANTHROPIC_DEFAULT_SONNET_MODEL"],
    ),
    text_field(
        "opus_model",
        "Opus 默认模型",
        "opus 别名解析到的模型",
        &["env", "ANTHROPIC_DEFAULT_OPUS_MODEL"],
    ),
    select_field(
        "effort_level",
        "推理强度",
        "支持模型的持久化 effortLevel",
        &["effortLevel"],
        EFFORT_OPTIONS,
    ),
    select_field(
        "permission_mode",
        "默认权限模式",
        "Claude Code 启动后的默认权限策略",
        &["permissions", "defaultMode"],
        CLAUDE_PERMISSION_OPTIONS,
    ),
    boolean_field(
        "include_co_authored_by",
        "提交署名",
        "在提交和 Pull Request 中加入 Claude 署名",
        &["includeCoAuthoredBy"],
    ),
    select_field(
        "auto_updates_channel",
        "更新通道",
        "Claude Code 自动更新使用的发布通道",
        &["autoUpdatesChannel"],
        CLAUDE_UPDATE_OPTIONS,
    ),
];
const CLAUDE_CONFIG: &[NativeConfigBinding] = &[NativeConfigBinding {
    binding_id: "settings",
    home_relative_path: ".claude/settings.json",
    directory_override_env: Some("CLAUDE_CONFIG_DIR"),
    override_relative_path: "settings.json",
    format: NativeConfigFormat::Json,
    fields: CLAUDE_SETTINGS_FIELDS,
}];
const CODEX_AUTH_FIELDS: &[NativeConfigField] = &[secret_field(
    "openai_api_key",
    "OpenAI API Key",
    "写入 Codex 的本地认证文件",
    &["OPENAI_API_KEY"],
)];
const CODEX_REASONING_OPTIONS: &[(&str, &str)] = &[
    ("minimal", "最少"),
    ("low", "低"),
    ("medium", "中"),
    ("high", "高"),
    ("xhigh", "极高"),
];
const CODEX_SUMMARY_OPTIONS: &[(&str, &str)] = &[
    ("auto", "自动"),
    ("concise", "简洁"),
    ("detailed", "详细"),
    ("none", "不显示"),
];
const CODEX_VERBOSITY_OPTIONS: &[(&str, &str)] =
    &[("low", "简洁"), ("medium", "适中"), ("high", "详细")];
const CODEX_APPROVAL_OPTIONS: &[(&str, &str)] = &[
    ("untrusted", "仅信任安全命令"),
    ("on-request", "按需确认"),
    ("never", "从不确认"),
];
const CODEX_SANDBOX_OPTIONS: &[(&str, &str)] = &[
    ("read-only", "只读"),
    ("workspace-write", "工作区可写"),
    ("danger-full-access", "完全访问"),
];
const CODEX_WEB_SEARCH_OPTIONS: &[(&str, &str)] =
    &[("disabled", "关闭"), ("cached", "缓存"), ("live", "实时")];
const CODEX_CONFIG_FIELDS: &[NativeConfigField] = &[
    text_field(
        "codex_openai_base_url",
        "API URL",
        "内置 OpenAI provider 的 API 或兼容网关地址",
        &["openai_base_url"],
    ),
    text_field("codex_model", "模型", "Codex 默认模型", &["model"]),
    text_field(
        "codex_model_provider",
        "模型提供商",
        "model_providers 中的提供商标识",
        &["model_provider"],
    ),
    select_field(
        "codex_reasoning_effort",
        "推理强度",
        "Codex 模型的 reasoning effort",
        &["model_reasoning_effort"],
        CODEX_REASONING_OPTIONS,
    ),
    select_field(
        "codex_reasoning_summary",
        "推理摘要",
        "推理摘要的显示方式",
        &["model_reasoning_summary"],
        CODEX_SUMMARY_OPTIONS,
    ),
    select_field(
        "codex_verbosity",
        "回答详细度",
        "支持模型的输出详细度",
        &["model_verbosity"],
        CODEX_VERBOSITY_OPTIONS,
    ),
    text_field(
        "codex_service_tier",
        "服务等级",
        "例如 fast、flex 或 auto",
        &["service_tier"],
    ),
    text_field(
        "codex_personality",
        "交流风格",
        "Codex 会话使用的 personality",
        &["personality"],
    ),
    select_field(
        "codex_approval_policy",
        "命令确认",
        "执行命令前的确认策略",
        &["approval_policy"],
        CODEX_APPROVAL_OPTIONS,
    ),
    select_field(
        "codex_sandbox_mode",
        "文件访问",
        "Codex 的本地文件访问范围",
        &["sandbox_mode"],
        CODEX_SANDBOX_OPTIONS,
    ),
    select_field(
        "codex_web_search",
        "网页搜索",
        "Codex 网页搜索的数据来源",
        &["web_search"],
        CODEX_WEB_SEARCH_OPTIONS,
    ),
    boolean_field(
        "codex_responses_websockets",
        "WebSocket 传输",
        "使用 Responses API WebSocket 传输",
        &["features", "responses_websockets_v2"],
    ),
];
const CODEX_CONFIG: &[NativeConfigBinding] = &[
    NativeConfigBinding {
        binding_id: "auth",
        home_relative_path: ".codex/auth.json",
        directory_override_env: Some("CODEX_HOME"),
        override_relative_path: "auth.json",
        format: NativeConfigFormat::Json,
        fields: CODEX_AUTH_FIELDS,
    },
    NativeConfigBinding {
        binding_id: "config",
        home_relative_path: ".codex/config.toml",
        directory_override_env: Some("CODEX_HOME"),
        override_relative_path: "config.toml",
        format: NativeConfigFormat::Toml,
        fields: CODEX_CONFIG_FIELDS,
    },
];

const OPENCODE_AUTH_FIELDS: &[NativeConfigField] = &[
    tagged_secret_field(
        "opencode_anthropic_api_key",
        "Anthropic API Key",
        "OpenCode 的 Anthropic provider 凭据",
        &["anthropic", "key"],
        ("type", "api"),
    ),
    tagged_secret_field(
        "opencode_openai_api_key",
        "OpenAI API Key",
        "OpenCode 的 OpenAI provider 凭据",
        &["openai", "key"],
        ("type", "api"),
    ),
    tagged_secret_field(
        "opencode_zen_api_key",
        "OpenCode Zen API Key",
        "OpenCode Zen provider 凭据",
        &["opencode", "key"],
        ("type", "api"),
    ),
    tagged_secret_field(
        "opencode_google_api_key",
        "Google API Key",
        "OpenCode 的 Google provider 凭据",
        &["google", "key"],
        ("type", "api"),
    ),
];
const OPENCODE_SHARE_OPTIONS: &[(&str, &str)] =
    &[("manual", "手动"), ("auto", "自动"), ("disabled", "关闭")];
const OPENCODE_SETTINGS_FIELDS: &[NativeConfigField] = &[
    text_field(
        "opencode_model",
        "主模型",
        "provider/model 格式的默认模型",
        &["model"],
    ),
    text_field(
        "opencode_small_model",
        "轻量模型",
        "标题等轻量任务使用的模型",
        &["small_model"],
    ),
    select_field(
        "opencode_share",
        "会话分享",
        "会话链接的创建策略",
        &["share"],
        OPENCODE_SHARE_OPTIONS,
    ),
    boolean_field(
        "opencode_autoupdate",
        "自动更新",
        "启动时自动更新 OpenCode",
        &["autoupdate"],
    ),
    text_field(
        "opencode_username",
        "显示名称",
        "对话中显示的用户名称",
        &["username"],
    ),
];
const OPENCODE_CONFIG: &[NativeConfigBinding] = &[
    NativeConfigBinding {
        binding_id: "auth",
        home_relative_path: ".local/share/opencode/auth.json",
        directory_override_env: Some("XDG_DATA_HOME"),
        override_relative_path: "opencode/auth.json",
        format: NativeConfigFormat::Json,
        fields: OPENCODE_AUTH_FIELDS,
    },
    NativeConfigBinding {
        binding_id: "config",
        home_relative_path: ".config/opencode/opencode.json",
        directory_override_env: Some("XDG_CONFIG_HOME"),
        override_relative_path: "opencode/opencode.json",
        format: NativeConfigFormat::Json,
        fields: OPENCODE_SETTINGS_FIELDS,
    },
];

const PI_AUTH_FIELDS: &[NativeConfigField] = &[
    tagged_secret_field(
        "pi_anthropic_api_key",
        "Anthropic API Key",
        "Pi 的 Anthropic provider 凭据",
        &["anthropic", "key"],
        ("type", "api_key"),
    ),
    tagged_secret_field(
        "pi_openai_api_key",
        "OpenAI API Key",
        "Pi 的 OpenAI provider 凭据",
        &["openai", "key"],
        ("type", "api_key"),
    ),
    tagged_secret_field(
        "pi_google_api_key",
        "Google API Key",
        "Pi 的 Google provider 凭据",
        &["google", "key"],
        ("type", "api_key"),
    ),
    tagged_secret_field(
        "pi_opencode_api_key",
        "OpenCode API Key",
        "Pi 的 OpenCode provider 凭据",
        &["opencode", "key"],
        ("type", "api_key"),
    ),
];
const PI_THINKING_OPTIONS: &[(&str, &str)] = &[
    ("off", "关闭"),
    ("minimal", "最少"),
    ("low", "低"),
    ("medium", "中"),
    ("high", "高"),
    ("xhigh", "极高"),
];
const PI_THEME_OPTIONS: &[(&str, &str)] = &[("dark", "深色"), ("light", "浅色")];
const PI_SETTINGS_FIELDS: &[NativeConfigField] = &[
    text_field(
        "pi_default_provider",
        "默认提供商",
        "Pi 启动时使用的 provider",
        &["defaultProvider"],
    ),
    text_field(
        "pi_default_model",
        "默认模型",
        "Pi 启动时使用的模型 ID",
        &["defaultModel"],
    ),
    select_field(
        "pi_thinking_level",
        "默认推理强度",
        "Pi 的 defaultThinkingLevel",
        &["defaultThinkingLevel"],
        PI_THINKING_OPTIONS,
    ),
    select_field(
        "pi_theme",
        "终端主题",
        "Pi 内置终端主题",
        &["theme"],
        PI_THEME_OPTIONS,
    ),
    boolean_field(
        "pi_hide_thinking",
        "隐藏推理内容",
        "在输出中隐藏 thinking block",
        &["hideThinkingBlock"],
    ),
    boolean_field(
        "pi_quiet_startup",
        "精简启动界面",
        "隐藏 Pi 的启动信息",
        &["quietStartup"],
    ),
    boolean_field(
        "pi_compaction_enabled",
        "自动压缩上下文",
        "启用自动 compaction",
        &["compaction", "enabled"],
    ),
    number_field(
        "pi_compaction_reserve_tokens",
        "压缩预留 Token",
        "为模型回复预留的 Token 数",
        &["compaction", "reserveTokens"],
    ),
];
const PI_CONFIG: &[NativeConfigBinding] = &[
    NativeConfigBinding {
        binding_id: "auth",
        home_relative_path: ".pi/agent/auth.json",
        directory_override_env: Some("PI_CODING_AGENT_DIR"),
        override_relative_path: "auth.json",
        format: NativeConfigFormat::Json,
        fields: PI_AUTH_FIELDS,
    },
    NativeConfigBinding {
        binding_id: "settings",
        home_relative_path: ".pi/agent/settings.json",
        directory_override_env: Some("PI_CODING_AGENT_DIR"),
        override_relative_path: "settings.json",
        format: NativeConfigFormat::Json,
        fields: PI_SETTINGS_FIELDS,
    },
];

const fn text_field(
    field_id: &'static str,
    label: &'static str,
    description: &'static str,
    path: &'static [&'static str],
) -> NativeConfigField {
    NativeConfigField {
        field_id,
        label,
        description,
        path,
        kind: NativeConfigFieldKind::Text,
        options: EMPTY_OPTIONS,
        object_discriminator: None,
    }
}

const fn secret_field(
    field_id: &'static str,
    label: &'static str,
    description: &'static str,
    path: &'static [&'static str],
) -> NativeConfigField {
    NativeConfigField {
        field_id,
        label,
        description,
        path,
        kind: NativeConfigFieldKind::Secret,
        options: EMPTY_OPTIONS,
        object_discriminator: None,
    }
}

const fn tagged_secret_field(
    field_id: &'static str,
    label: &'static str,
    description: &'static str,
    path: &'static [&'static str],
    object_discriminator: (&'static str, &'static str),
) -> NativeConfigField {
    NativeConfigField {
        field_id,
        label,
        description,
        path,
        kind: NativeConfigFieldKind::Secret,
        options: EMPTY_OPTIONS,
        object_discriminator: Some(object_discriminator),
    }
}

const fn select_field(
    field_id: &'static str,
    label: &'static str,
    description: &'static str,
    path: &'static [&'static str],
    options: &'static [(&'static str, &'static str)],
) -> NativeConfigField {
    NativeConfigField {
        field_id,
        label,
        description,
        path,
        kind: NativeConfigFieldKind::Select,
        options,
        object_discriminator: None,
    }
}

const fn boolean_field(
    field_id: &'static str,
    label: &'static str,
    description: &'static str,
    path: &'static [&'static str],
) -> NativeConfigField {
    NativeConfigField {
        field_id,
        label,
        description,
        path,
        kind: NativeConfigFieldKind::Boolean,
        options: EMPTY_OPTIONS,
        object_discriminator: None,
    }
}

const fn number_field(
    field_id: &'static str,
    label: &'static str,
    description: &'static str,
    path: &'static [&'static str],
) -> NativeConfigField {
    NativeConfigField {
        field_id,
        label,
        description,
        path,
        kind: NativeConfigFieldKind::Number,
        options: EMPTY_OPTIONS,
        object_discriminator: None,
    }
}

fn npx(
    component: ProfileComponent,
    package: &'static str,
    version: &'static str,
    command: &'static str,
    node_requirement: &'static str,
    integrity: &'static str,
) -> ProfileInstallSource {
    ProfileInstallSource::Npx {
        component,
        package,
        version,
        command,
        args: &[],
        node_requirement,
        integrity,
    }
}

fn claude_code_profile() -> BuiltInProfile {
    BuiltInProfile {
        agent_id: AgentId::parse("claude_code").expect("bundled AgentId"),
        display_name: "Claude Code",
        description: "Anthropic Claude Code through its official ACP adapter",
        icon: ProfileIcon {
            light: "/agents/claude-light.svg",
            dark: "/agents/claude-dark.svg",
        },
        registry_binding: Some(ProfileRegistryBinding {
            registry_id: "claude-acp",
        }),
        topology: ProfileTopology::AdapterBacked,
        supported_platforms: DESKTOP_PLATFORMS,
        install_sources: vec![
            npx(
                ProfileComponent::AgentRuntime,
                "@anthropic-ai/claude-code",
                "2.1.220",
                "claude",
                ">=20",
                "sha512-ogBrvwkqF9f8okmnXKxmRNHuvtFxFEffe5pWdqOV3iQDxlUOKirFqnyWC7NGXXnDA4WkkbPH8pvSbwyCR2Auyw==",
            ),
            npx(
                ProfileComponent::AcpAdapter,
                "@agentclientprotocol/claude-agent-acp",
                "0.63.0",
                "claude-agent-acp",
                ">=20",
                "sha512-/Ylytz6KPGkih1sZd2sJAmWIGMh59T+FCJhlsfW9zpB1Lrg0/Njgk/7TplRfX2f7dELx0FeN+SBG+Uju12XwlA==",
            ),
        ],
        external_candidates: CLAUDE_CANDIDATES,
        runtime_executable_env: Some("CLAUDE_CODE_EXECUTABLE"),
        native_config: CLAUDE_CONFIG,
        authentication_precedence: AuthenticationPrecedence::AccountThenApiKey,
    }
}

fn codex_profile() -> BuiltInProfile {
    BuiltInProfile {
        agent_id: AgentId::parse("codex").expect("bundled AgentId"),
        display_name: "Codex",
        description: "OpenAI Codex through its official ACP adapter",
        icon: ProfileIcon {
            light: "/agents/codex-light.svg",
            dark: "/agents/codex-dark.svg",
        },
        registry_binding: Some(ProfileRegistryBinding {
            registry_id: "codex-acp",
        }),
        topology: ProfileTopology::AdapterBacked,
        supported_platforms: DESKTOP_PLATFORMS,
        install_sources: vec![
            npx(
                ProfileComponent::AgentRuntime,
                "@openai/codex",
                "0.146.0",
                "codex",
                ">=20",
                "sha512-yG3sPWNda/2YAIQIDq9MrrjoCTIQ7rxYM5IasrG3VBcuhCLTkgeg/JzqmJq1V98RE4MJ5jCxDXXQlOjrditFRw==",
            ),
            npx(
                ProfileComponent::AcpAdapter,
                "@agentclientprotocol/codex-acp",
                "1.1.7",
                "codex-acp",
                ">=20",
                "sha512-bhFLbGtOMEw6+PAp33vNERb6dXlULOfV3mWbRdps4v7sY7PHha/C2T1dnlG0yVcvBu9W+NYPzL0CAupnVoFTiQ==",
            ),
        ],
        external_candidates: CODEX_CANDIDATES,
        runtime_executable_env: Some("CODEX_PATH"),
        native_config: CODEX_CONFIG,
        authentication_precedence: AuthenticationPrecedence::AccountThenApiKey,
    }
}

fn opencode_profile() -> BuiltInProfile {
    BuiltInProfile {
        agent_id: AgentId::parse("opencode").expect("bundled AgentId"),
        display_name: "OpenCode",
        description: "The OpenCode local Runtime with native ACP support",
        icon: ProfileIcon {
            light: "/agents/opencode-light.svg",
            dark: "/agents/opencode-dark.svg",
        },
        registry_binding: Some(ProfileRegistryBinding {
            registry_id: "opencode",
        }),
        topology: ProfileTopology::NativeAcp,
        supported_platforms: DESKTOP_PLATFORMS,
        install_sources: vec![ProfileInstallSource::Binary {
            component: ProfileComponent::CombinedRuntime,
            version: "1.18.9",
            command: "opencode",
            args: &["acp"],
            artifacts: vec![
                artifact(
                    "darwin-aarch64",
                    "opencode-darwin-arm64.zip",
                    "6f998b7dabb9425bb348fd0d88afeb92a14422771231cec9b0f4374b947397e6",
                ),
                artifact(
                    "darwin-x86_64",
                    "opencode-darwin-x64.zip",
                    "b9e6081f4db1f2066910f121258c23c8243438d22b1b80987d1569c5e40ef00e",
                ),
                artifact(
                    "linux-aarch64",
                    "opencode-linux-arm64.tar.gz",
                    "b16bd7593ea960a25d9c6849b3023bcd9b9244a6f51675341fd2052043b0670f",
                ),
                artifact(
                    "linux-x86_64",
                    "opencode-linux-x64.tar.gz",
                    "a0fa4b7b8bdacbd013e79a5f69d4220d36b545cd3ea296ba765f3016fa501b5b",
                ),
                artifact(
                    "windows-aarch64",
                    "opencode-windows-arm64.zip",
                    "1f2c650b517d725635e56da080c73c641c250696a3d7e6cdbada96af8f31a6d3",
                ),
                artifact(
                    "windows-x86_64",
                    "opencode-windows-x64.zip",
                    "1becf92ceb23edd7d951e7e3d8efcbe9c9808f5cc728f1b75277d5f951ada5c2",
                ),
            ],
        }],
        external_candidates: OPENCODE_CANDIDATES,
        runtime_executable_env: None,
        native_config: OPENCODE_CONFIG,
        authentication_precedence: AuthenticationPrecedence::SingleSource,
    }
}

fn artifact(
    platform: &'static str,
    filename: &'static str,
    sha256: &'static str,
) -> ProfileBinaryArtifact {
    ProfileBinaryArtifact {
        platform,
        archive_url: match filename {
            "opencode-darwin-arm64.zip" => {
                "https://github.com/anomalyco/opencode/releases/download/v1.18.9/opencode-darwin-arm64.zip"
            }
            "opencode-darwin-x64.zip" => {
                "https://github.com/anomalyco/opencode/releases/download/v1.18.9/opencode-darwin-x64.zip"
            }
            "opencode-linux-arm64.tar.gz" => {
                "https://github.com/anomalyco/opencode/releases/download/v1.18.9/opencode-linux-arm64.tar.gz"
            }
            "opencode-linux-x64.tar.gz" => {
                "https://github.com/anomalyco/opencode/releases/download/v1.18.9/opencode-linux-x64.tar.gz"
            }
            "opencode-windows-arm64.zip" => {
                "https://github.com/anomalyco/opencode/releases/download/v1.18.9/opencode-windows-arm64.zip"
            }
            "opencode-windows-x64.zip" => {
                "https://github.com/anomalyco/opencode/releases/download/v1.18.9/opencode-windows-x64.zip"
            }
            _ => unreachable!("bundled OpenCode artifact"),
        },
        sha256,
    }
}

fn pi_profile() -> BuiltInProfile {
    BuiltInProfile {
        agent_id: AgentId::parse("pi").expect("bundled AgentId"),
        display_name: "Pi",
        description: "Pi coding agent through the pi ACP adapter",
        icon: ProfileIcon {
            light: "/agents/pi.svg",
            dark: "/agents/pi.svg",
        },
        registry_binding: Some(ProfileRegistryBinding {
            registry_id: "pi-acp",
        }),
        topology: ProfileTopology::AdapterBacked,
        supported_platforms: DESKTOP_PLATFORMS,
        install_sources: vec![
            npx(
                ProfileComponent::AgentRuntime,
                "@earendil-works/pi-coding-agent",
                "0.82.1",
                "pi",
                ">=22",
                "sha512-zbkAhoIuDPMF3pKuja0ajZabrMWU29FUMV9A/XMXT/XC1yXs5xt6t6t13GogQFsDrDqbFP4DkZQO1w8rWRAzYA==",
            ),
            npx(
                ProfileComponent::AcpAdapter,
                "pi-acp",
                "0.0.32",
                "pi-acp",
                ">=22",
                "sha512-2/0dfoVhkDTHDQ0R8wwb1ykwlSJm46VEoUyMllzc9hNbEuzUleZXqUwzGScf6+GvepU/4qA4v7hRgGTLgFp5Mw==",
            ),
        ],
        external_candidates: PI_CANDIDATES,
        runtime_executable_env: None,
        native_config: PI_CONFIG,
        authentication_precedence: AuthenticationPrecedence::SingleSource,
    }
}
