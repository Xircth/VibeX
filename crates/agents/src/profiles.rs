//! App-bundled declarations for Agents that receive first-class presentation
//! and proactive local detection.
//!
//! A profile is data, not an alternate runtime path. Registry Agents and
//! profile-backed Agents use the same management, installation, ACP and
//! session services. The extra declarations here are facts the remote Registry
//! cannot safely provide: stable identity binding, component topology,
//! release-pinned trust evidence, official local candidates and known native
//! configuration fields.

use api_types::{AgentId, AgentKind, AgentSettingsFeature};

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
    /// `None` mirrors upstream distributions that do not publish a digest;
    /// those artifacts enter the existing trust-on-first-use path.
    pub sha256: Option<&'static str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileBinaryEntry {
    pub unix: &'static str,
    pub windows: &'static str,
    pub unix_siblings: &'static [&'static str],
    pub windows_siblings: &'static [&'static str],
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
    Uvx {
        component: ProfileComponent,
        package: &'static str,
        version: &'static str,
        command: &'static str,
        args: &'static [&'static str],
        uv_requirement: &'static str,
        python_requirement: &'static str,
    },
    Binary {
        component: ProfileComponent,
        version: &'static str,
        command: &'static str,
        args: &'static [&'static str],
        artifacts: Vec<ProfileBinaryArtifact>,
        entry: Option<ProfileBinaryEntry>,
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileDependency {
    pub id: &'static str,
    pub label: &'static str,
    pub executable: &'static str,
    pub version_args: &'static [&'static str],
    pub requirement: &'static str,
    pub required: bool,
    pub repairable: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProfileManagementActionKind {
    Login,
    Logout,
    Setup,
    Subscription,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileManagementAction {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub kind: ProfileManagementActionKind,
    pub program: Option<&'static str>,
    pub args: &'static [&'static str],
    pub url: Option<&'static str>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeConfigFormat {
    Json,
    Toml,
    Yaml,
    Dotenv,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeConfigFieldKind {
    Text,
    Secret,
    Select,
    Boolean,
    Number,
    Json,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeConfigSurface {
    Configuration,
    Authentication,
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
    pub surface: NativeConfigSurface,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccountEvidenceKind {
    NonEmptyObject,
    NonEmptyObjectAt(&'static [&'static str]),
    NonEmptyStringAt(&'static [&'static str]),
    ProviderEntryNotApiKey,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountEvidence {
    pub home_relative_directory: &'static str,
    pub directory_override_env: Option<&'static str>,
    /// Path below an override directory. Some CLIs define an override as a
    /// parent directory rather than the native configuration directory.
    pub override_relative_directory: &'static str,
    pub relative_file: &'static str,
    pub kind: AccountEvidenceKind,
}

impl AccountEvidence {
    pub fn matches(&self, value: &serde_json::Value) -> bool {
        match self.kind {
            AccountEvidenceKind::NonEmptyObject => {
                value.as_object().is_some_and(|object| !object.is_empty())
            }
            AccountEvidenceKind::NonEmptyObjectAt(path) => {
                let mut current = value;
                for segment in path {
                    let Some(next) = current.get(*segment) else {
                        return false;
                    };
                    current = next;
                }
                current.as_object().is_some_and(|object| !object.is_empty())
            }
            AccountEvidenceKind::NonEmptyStringAt(path) => {
                let mut current = value;
                for segment in path {
                    let Some(next) = current.get(*segment) else {
                        return false;
                    };
                    current = next;
                }
                current
                    .as_str()
                    .is_some_and(|value| !value.trim().is_empty())
            }
            AccountEvidenceKind::ProviderEntryNotApiKey => {
                value.as_object().is_some_and(|object| {
                    object.values().any(|entry| {
                        entry
                            .get("type")
                            .and_then(serde_json::Value::as_str)
                            .is_some_and(|kind| !matches!(kind, "api" | "api_key"))
                    })
                })
            }
        }
    }
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
    pub dependencies: &'static [ProfileDependency],
    pub management_actions: &'static [ProfileManagementAction],
    /// Adapter-specific environment variable that must point to the separately
    /// installed local Runtime. `None` means the ACP executable is the Runtime,
    /// or the adapter contract resolves the Runtime from the lock-owned PATH.
    pub runtime_executable_env: Option<&'static str>,
    pub native_config: &'static [NativeConfigBinding],
    pub settings_features: &'static [AgentSettingsFeature],
    pub authentication_precedence: AuthenticationPrecedence,
    pub authentication_required_by_default: bool,
    pub account_evidence: Option<AccountEvidence>,
}

impl BuiltInProfile {
    pub fn binary_required_siblings(&self, windows: bool) -> &'static [&'static str] {
        self.install_sources
            .iter()
            .find_map(|source| match source {
                ProfileInstallSource::Binary {
                    entry: Some(entry), ..
                } => Some(if windows {
                    entry.windows_siblings
                } else {
                    entry.unix_siblings
                }),
                _ => None,
            })
            .unwrap_or(&[])
    }
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
                antigravity_profile(),
                openclaw_profile(),
                opencode_profile(),
                cline_profile(),
                hermes_profile(),
                codebuddy_profile(),
                kimi_code_profile(),
                pi_profile(),
                grok_profile(),
                cursor_profile(),
                deepseek_harness_profile(),
            ],
        }
    }

    pub fn profiles(&self) -> &[BuiltInProfile] {
        &self.profiles
    }

    pub fn profile(&self, agent_id: &AgentId) -> Option<&BuiltInProfile> {
        self.profiles.iter().find(|profile| {
            &profile.agent_id == agent_id
                || AgentKind::from_lenient(agent_id.as_str())
                    .zip(AgentKind::from_lenient(profile.agent_id.as_str()))
                    .is_some_and(|(requested, bundled)| requested == bundled)
        })
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
const ANTIGRAVITY_CANDIDATES: &[ProfileExternalCandidate] = &[external("agy_acp_server")];
const ANTIGRAVITY_PLATFORMS: &[&str] = &[
    "darwin-aarch64",
    "linux-aarch64",
    "linux-x86_64",
    "windows-aarch64",
    "windows-x86_64",
];
const ANTIGRAVITY_LAUNCH_ARGS: &[&str] = if cfg!(target_os = "linux") {
    &["--uid="]
} else {
    &[]
};
const OPENCLAW_CANDIDATES: &[ProfileExternalCandidate] = &[external("openclaw")];
const CLINE_CANDIDATES: &[ProfileExternalCandidate] = &[external("cline")];
const HERMES_CANDIDATES: &[ProfileExternalCandidate] = &[external("hermes-acp")];
const CODEBUDDY_CANDIDATES: &[ProfileExternalCandidate] = &[external("codebuddy")];
const KIMI_CANDIDATES: &[ProfileExternalCandidate] = &[external("kimi")];
const GROK_CANDIDATES: &[ProfileExternalCandidate] = &[external("grok")];
const CURSOR_CANDIDATES: &[ProfileExternalCandidate] = &[external("cursor-agent")];
const DEEPSEEK_HARNESS_CANDIDATES: &[ProfileExternalCandidate] = &[external("deepseek-acp")];

const fn external(executable: &'static str) -> ProfileExternalCandidate {
    ProfileExternalCandidate {
        component: ProfileComponent::CombinedRuntime,
        executable,
        version_args: &["--version"],
    }
}

const NODE_20_DEPENDENCIES: &[ProfileDependency] = &[
    dependency("node", "Node.js", "node", &["--version"], ">=20", true),
    dependency("npm", "npm", "npm", &["--version"], "随 Node.js 安装", true),
];
const NODE_22_DEPENDENCIES: &[ProfileDependency] = &[
    dependency("node", "Node.js", "node", &["--version"], ">=22", true),
    dependency("npm", "npm", "npm", &["--version"], "随 Node.js 安装", true),
];
const NODE_22_19_DEPENDENCIES: &[ProfileDependency] = &[
    dependency("node", "Node.js", "node", &["--version"], ">=22.19", true),
    dependency("npm", "npm", "npm", &["--version"], "随 Node.js 安装", true),
];
const NODE_22_22_DEPENDENCIES: &[ProfileDependency] = &[
    dependency("node", "Node.js", "node", &["--version"], ">=22.22.3", true),
    dependency("npm", "npm", "npm", &["--version"], "随 Node.js 安装", true),
];
const UV_DEPENDENCIES: &[ProfileDependency] = &[
    dependency("uv", "uv", "uv", &["--version"], ">=0.5", true),
    dependency(
        "python",
        "系统 Python（可选）",
        "python3",
        &["--version"],
        "uv 将自动安装 Python 3.13",
        false,
    ),
];
const ARCHIVE_DEPENDENCIES: &[ProfileDependency] = &[dependency(
    "archive",
    "归档解压工具",
    "tar",
    &["--version"],
    "系统自带（Windows ZIP 无需）",
    false,
)];

const fn dependency(
    id: &'static str,
    label: &'static str,
    executable: &'static str,
    version_args: &'static [&'static str],
    requirement: &'static str,
    required: bool,
) -> ProfileDependency {
    ProfileDependency {
        id,
        label,
        executable,
        version_args,
        requirement,
        required,
        repairable: false,
    }
}

const CLAUDE_ACTIONS: &[ProfileManagementAction] = &[
    terminal_action(
        "login",
        "登录 Claude",
        "启动 Claude Code 官方账号登录",
        ProfileManagementActionKind::Login,
        "claude",
        &["auth", "login"],
    ),
    terminal_action(
        "logout",
        "退出登录",
        "注销 Claude Code 本地账号",
        ProfileManagementActionKind::Logout,
        "claude",
        &["auth", "logout"],
    ),
    url_action(
        "subscription",
        "管理订阅",
        "打开 Claude 套餐与账单页面",
        "https://claude.ai/settings/billing",
    ),
];
const CODEX_ACTIONS: &[ProfileManagementAction] = &[
    terminal_action(
        "login",
        "登录 ChatGPT",
        "启动 Codex 官方设备码登录",
        ProfileManagementActionKind::Login,
        "codex",
        &["login", "--device-auth"],
    ),
    terminal_action(
        "logout",
        "退出登录",
        "注销 Codex 本地账号",
        ProfileManagementActionKind::Logout,
        "codex",
        &["logout"],
    ),
    url_action(
        "subscription",
        "管理订阅",
        "打开 ChatGPT 套餐管理页面",
        "https://chatgpt.com/#pricing",
    ),
];
const ANTIGRAVITY_ACTIONS: &[ProfileManagementAction] = &[];
const OPENCLAW_ACTIONS: &[ProfileManagementAction] = &[terminal_action(
    "onboard",
    "初始化 OpenClaw",
    "运行官方引导并配置 Gateway",
    ProfileManagementActionKind::Setup,
    "openclaw",
    &["onboard"],
)];
const OPENCODE_ACTIONS: &[ProfileManagementAction] = &[
    terminal_action(
        "login",
        "连接 Provider",
        "启动 OpenCode 官方认证流程",
        ProfileManagementActionKind::Login,
        "opencode",
        &["auth", "login"],
    ),
    terminal_action(
        "logout",
        "断开 Provider",
        "启动 OpenCode 官方注销流程",
        ProfileManagementActionKind::Logout,
        "opencode",
        &["auth", "logout"],
    ),
];
const CLINE_ACTIONS: &[ProfileManagementAction] = &[terminal_action(
    "login",
    "登录 Cline",
    "启动 Cline 官方认证流程",
    ProfileManagementActionKind::Login,
    "cline",
    &["auth"],
)];
const HERMES_ACTIONS: &[ProfileManagementAction] = &[
    terminal_action(
        "setup",
        "运行 Hermes Setup",
        "配置 Provider 与凭据",
        ProfileManagementActionKind::Setup,
        "hermes-acp",
        &["--setup"],
    ),
    terminal_action(
        "model",
        "配置模型",
        "打开 Hermes 模型配置流程",
        ProfileManagementActionKind::Setup,
        "hermes",
        &["model"],
    ),
];
const CODEBUDDY_ACTIONS: &[ProfileManagementAction] = &[terminal_action(
    "login",
    "登录 CodeBuddy",
    "启动 CodeBuddy 官方登录",
    ProfileManagementActionKind::Login,
    "codebuddy",
    &["login"],
)];
const KIMI_ACTIONS: &[ProfileManagementAction] = &[
    terminal_action(
        "login",
        "登录 Kimi",
        "切换到 Kimi Code 订阅账号并启动设备码登录",
        ProfileManagementActionKind::Login,
        "kimi",
        &["acp", "--login"],
    ),
    terminal_action(
        "logout",
        "退出登录",
        "注销 Kimi Code 本地账号",
        ProfileManagementActionKind::Logout,
        "kimi",
        &["logout"],
    ),
];
const PI_ACTIONS: &[ProfileManagementAction] = &[terminal_action(
    "login",
    "配置 Pi Provider",
    "启动 Pi，在终端中使用 /login",
    ProfileManagementActionKind::Login,
    "pi",
    &[],
)];
const GROK_ACTIONS: &[ProfileManagementAction] = &[
    terminal_action(
        "login",
        "登录 Grok",
        "使用 SuperGrok / X Premium+ 账号登录",
        ProfileManagementActionKind::Login,
        "grok",
        &["login"],
    ),
    terminal_action(
        "logout",
        "退出登录",
        "注销 Grok 本地账号",
        ProfileManagementActionKind::Logout,
        "grok",
        &["logout"],
    ),
    url_action(
        "subscription",
        "管理订阅",
        "打开 Grok 套餐与账单页面",
        "https://grok.com?_s=usage",
    ),
];
const CURSOR_ACTIONS: &[ProfileManagementAction] = &[
    terminal_action(
        "login",
        "登录 Cursor",
        "使用 Cursor 订阅账号登录",
        ProfileManagementActionKind::Login,
        "cursor-agent",
        &["login"],
    ),
    terminal_action(
        "logout",
        "退出登录",
        "注销 Cursor Agent 本地账号",
        ProfileManagementActionKind::Logout,
        "cursor-agent",
        &["logout"],
    ),
    url_action(
        "subscription",
        "管理订阅",
        "打开 Cursor 套餐管理页面",
        "https://www.cursor.com/settings",
    ),
];
const DEEPSEEK_HARNESS_ACTIONS: &[ProfileManagementAction] = &[terminal_action(
    "setup",
    "配置 API Key",
    "把 DeepSeek API Key 写入本地凭据",
    ProfileManagementActionKind::Setup,
    "deepseek-acp",
    &["--setup"],
)];

const fn terminal_action(
    id: &'static str,
    label: &'static str,
    description: &'static str,
    kind: ProfileManagementActionKind,
    program: &'static str,
    args: &'static [&'static str],
) -> ProfileManagementAction {
    ProfileManagementAction {
        id,
        label,
        description,
        kind,
        program: Some(program),
        args,
        url: None,
    }
}

const fn url_action(
    id: &'static str,
    label: &'static str,
    description: &'static str,
    url: &'static str,
) -> ProfileManagementAction {
    ProfileManagementAction {
        id,
        label,
        description,
        kind: ProfileManagementActionKind::Subscription,
        program: None,
        args: &[],
        url: Some(url),
    }
}

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
    authentication(text_field(
        "anthropic_base_url",
        "API URL",
        "Anthropic API 或兼容网关地址",
        &["env", "ANTHROPIC_BASE_URL"],
    )),
    authentication(secret_field(
        "anthropic_api_key",
        "API Key",
        "写入 Claude Code 的 ANTHROPIC_API_KEY",
        &["env", "ANTHROPIC_API_KEY"],
    )),
    text_field(
        "model",
        "主模型",
        "新会话默认使用的模型或模型别名",
        &["env", "ANTHROPIC_MODEL"],
    ),
    text_field(
        "reasoning_model",
        "推理模型",
        "Claude Code 处理扩展思考时使用的模型",
        &["env", "ANTHROPIC_REASONING_MODEL"],
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
    text_field(
        "custom_model_option",
        "自定义模型 ID",
        "在模型选择器中增加一个自定义模型",
        &["env", "ANTHROPIC_CUSTOM_MODEL_OPTION"],
    ),
    text_field(
        "custom_model_option_name",
        "自定义模型名称",
        "自定义模型在选择器中的显示名称",
        &["env", "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME"],
    ),
    text_field(
        "custom_model_option_description",
        "自定义模型说明",
        "自定义模型在选择器中的说明",
        &["env", "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION"],
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
        "claude_send_attribution_header",
        "发送归因请求头",
        "控制 CLAUDE_CODE_ATTRIBUTION_HEADER",
        &["env", "CLAUDE_CODE_ATTRIBUTION_HEADER"],
        &[("0", "关闭"), ("1", "开启")],
    ),
    select_field(
        "claude_disable_nonessential_traffic",
        "禁用非必要流量",
        "控制遥测与非必要网络请求",
        &["env", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"],
        &[("0", "关闭"), ("1", "开启")],
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
const CODEX_AUTH_FIELDS: &[NativeConfigField] = &[authentication(secret_field(
    "openai_api_key",
    "OpenAI API Key",
    "写入 Codex 的本地认证文件",
    &["OPENAI_API_KEY"],
))];
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
    ("granular", "按能力分别确认"),
];
const CODEX_SANDBOX_OPTIONS: &[(&str, &str)] = &[
    ("read-only", "只读"),
    ("workspace-write", "工作区可写"),
    ("danger-full-access", "完全访问"),
];
const CODEX_WEB_SEARCH_OPTIONS: &[(&str, &str)] =
    &[("disabled", "关闭"), ("cached", "缓存"), ("live", "实时")];
const CODEX_CONFIG_FIELDS: &[NativeConfigField] = &[
    authentication(text_field(
        "codex_openai_base_url",
        "API URL",
        "Codex 使用的 API 或兼容网关地址",
        &["openai_base_url"],
    )),
    text_field("codex_model", "模型", "Codex 默认模型", &["model"]),
    authentication(text_field(
        "codex_model_provider",
        "模型提供商",
        "model_providers 中的提供商标识",
        &["model_provider"],
    )),
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
    boolean_field(
        "codex_approval_sandbox",
        "沙箱命令确认",
        "允许 Codex 针对沙箱外命令发起确认",
        &["approval_policy", "granular", "sandbox_approval"],
    ),
    boolean_field(
        "codex_approval_rules",
        "规则确认",
        "允许 Codex 针对规则匹配结果发起确认",
        &["approval_policy", "granular", "rules"],
    ),
    boolean_field(
        "codex_approval_skills",
        "Skill 确认",
        "允许 Codex 在运行 Skill 前发起确认",
        &["approval_policy", "granular", "skill_approval"],
    ),
    boolean_field(
        "codex_approval_permissions",
        "权限请求确认",
        "允许 Codex 请求额外文件或系统权限",
        &["approval_policy", "granular", "request_permissions"],
    ),
    boolean_field(
        "codex_approval_mcp",
        "MCP 交互确认",
        "允许 MCP server 通过 Codex 发起交互确认",
        &["approval_policy", "granular", "mcp_elicitations"],
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
    boolean_field(
        "codex_skills",
        "Skills",
        "启用 Codex 原生 Skills 支持",
        &["features", "skills"],
    ),
    json_field(
        "codex_writable_roots",
        "额外可写目录",
        "workspace-write 沙箱额外允许写入的绝对路径数组",
        &["sandbox_workspace_write", "writable_roots"],
    ),
    boolean_field(
        "codex_network_access",
        "沙箱网络访问",
        "允许 workspace-write 沙箱访问网络",
        &["sandbox_workspace_write", "network_access"],
    ),
    boolean_field(
        "codex_exclude_tmpdir",
        "排除 TMPDIR",
        "从默认可写目录中排除用户 TMPDIR",
        &["sandbox_workspace_write", "exclude_tmpdir_env_var"],
    ),
    boolean_field(
        "codex_exclude_slash_tmp",
        "排除 /tmp",
        "从默认可写目录中排除 /tmp",
        &["sandbox_workspace_write", "exclude_slash_tmp"],
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
    json_field(
        "opencode_providers",
        "Provider 连接",
        "完整的 provider 连接、npm 适配器、端点与模型定义（JSON）",
        &["provider"],
    ),
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
    NativeConfigBinding {
        binding_id: "models",
        home_relative_path: ".pi/agent/models.json",
        directory_override_env: Some("PI_CODING_AGENT_DIR"),
        override_relative_path: "models.json",
        format: NativeConfigFormat::Json,
        fields: &[json_field(
            "pi_custom_providers",
            "自定义 Provider",
            "Pi models.json 的 providers 对象",
            &["providers"],
        )],
    },
];

const ANTIGRAVITY_AUTH_OPTIONS: &[(&str, &str)] = &[
    ("oauth-personal", "Google 账号"),
    ("oauth-business", "Gemini Enterprise"),
    ("gemini-api-key", "Gemini API Key"),
    ("agent-platform", "Agent Platform"),
];
const ANTIGRAVITY_FIELDS: &[NativeConfigField] = &[
    authentication(select_field(
        "antigravity_auth",
        "认证方式",
        "Antigravity 使用的认证来源",
        &["auth", "type"],
        ANTIGRAVITY_AUTH_OPTIONS,
    )),
    authentication(secret_field(
        "antigravity_api_key",
        "Gemini API Key",
        "gemini-api-key 模式使用的密钥",
        &["env", "GEMINI_API_KEY"],
    )),
    authentication(secret_field(
        "antigravity_google_api_key",
        "Agent Platform API Key",
        "agent-platform 模式使用的密钥",
        &["env", "GOOGLE_API_KEY"],
    )),
    authentication(text_field(
        "antigravity_cloud_project",
        "Google Cloud Project",
        "Gemini Enterprise / Agent Platform 项目",
        &["env", "GOOGLE_CLOUD_PROJECT"],
    )),
    authentication(text_field(
        "antigravity_cloud_location",
        "Google Cloud Location",
        "例如 global 或 us-central1",
        &["env", "GOOGLE_CLOUD_LOCATION"],
    )),
];
const ANTIGRAVITY_CONFIG: &[NativeConfigBinding] = &[NativeConfigBinding {
    binding_id: "settings",
    home_relative_path: ".gemini/antigravity-acp/settings.json",
    directory_override_env: Some("GEMINI_HOME"),
    override_relative_path: "antigravity-acp/settings.json",
    format: NativeConfigFormat::Json,
    fields: ANTIGRAVITY_FIELDS,
}];

const OPENCLAW_FIELDS: &[NativeConfigField] = &[
    text_field(
        "openclaw_gateway_url",
        "Gateway URL",
        "OpenClaw 远程 Gateway 地址",
        &["gateway", "remote", "url"],
    ),
    secret_field(
        "openclaw_gateway_token",
        "Gateway Token",
        "Gateway 认证 Token",
        &["gateway", "auth", "token"],
    ),
    text_field(
        "openclaw_session",
        "Session Key",
        "复用的 OpenClaw 会话键",
        &["acp", "sessionKey"],
    ),
    text_field(
        "openclaw_model",
        "默认模型",
        "OpenClaw 默认模型",
        &["agents", "defaults", "model", "primary"],
    ),
];
const OPENCLAW_CONFIG: &[NativeConfigBinding] = &[NativeConfigBinding {
    binding_id: "config",
    home_relative_path: ".openclaw/openclaw.json",
    directory_override_env: Some("OPENCLAW_HOME"),
    override_relative_path: "openclaw.json",
    format: NativeConfigFormat::Json,
    fields: OPENCLAW_FIELDS,
}];

const CLINE_PROVIDER_OPTIONS: &[(&str, &str)] = &[
    ("anthropic", "Anthropic"),
    ("openai", "OpenAI"),
    ("openai-native", "OpenAI Native"),
    ("openrouter", "OpenRouter"),
    ("gemini", "Gemini"),
    ("deepseek", "DeepSeek"),
    ("bedrock", "AWS Bedrock"),
    ("vertex", "GCP Vertex"),
    ("ollama", "Ollama"),
    ("lmstudio", "LM Studio"),
];
const CLINE_STATE_FIELDS: &[NativeConfigField] = &[
    select_field(
        "cline_provider",
        "Provider",
        "Cline API Provider",
        &["apiProvider"],
        CLINE_PROVIDER_OPTIONS,
    ),
    text_field("cline_model", "模型", "Cline 模型 ID", &["apiModelId"]),
    text_field(
        "cline_base_url",
        "API URL",
        "OpenAI 兼容端点",
        &["openAiBaseUrl"],
    ),
];
const CLINE_SECRET_FIELDS: &[NativeConfigField] = &[
    secret_field(
        "cline_anthropic_key",
        "Anthropic API Key",
        "Cline Anthropic 凭据",
        &["apiKey"],
    ),
    secret_field(
        "cline_openai_key",
        "OpenAI API Key",
        "Cline OpenAI 凭据",
        &["openAiApiKey"],
    ),
    secret_field(
        "cline_openrouter_key",
        "OpenRouter API Key",
        "Cline OpenRouter 凭据",
        &["openRouterApiKey"],
    ),
    secret_field(
        "cline_gemini_key",
        "Gemini API Key",
        "Cline Gemini 凭据",
        &["geminiApiKey"],
    ),
];
const CLINE_CONFIG: &[NativeConfigBinding] = &[
    NativeConfigBinding {
        binding_id: "state",
        home_relative_path: ".cline/data/globalState.json",
        directory_override_env: Some("CLINE_DIR"),
        override_relative_path: "globalState.json",
        format: NativeConfigFormat::Json,
        fields: CLINE_STATE_FIELDS,
    },
    NativeConfigBinding {
        binding_id: "secrets",
        home_relative_path: ".cline/data/secrets.json",
        directory_override_env: Some("CLINE_DIR"),
        override_relative_path: "secrets.json",
        format: NativeConfigFormat::Json,
        fields: CLINE_SECRET_FIELDS,
    },
];

const HERMES_PROVIDER_OPTIONS: &[(&str, &str)] = &[
    ("openrouter", "OpenRouter"),
    ("openai-api", "OpenAI / Compatible"),
    ("custom", "自定义 OpenAI 兼容端点"),
    ("anthropic", "Anthropic"),
    ("gemini", "Google AI Studio"),
    ("deepseek", "DeepSeek"),
    ("xai", "xAI Grok"),
    ("zai", "Z.AI / GLM"),
    ("minimax", "MiniMax"),
    ("minimax-cn", "MiniMax（中国）"),
    ("kimi-coding", "Kimi / Moonshot"),
    ("kimi-coding-cn", "Kimi / Moonshot（中国）"),
    ("nvidia", "NVIDIA NIM"),
    ("alibaba", "Qwen / DashScope"),
    ("alibaba-coding-plan", "Alibaba Coding Plan"),
    ("copilot", "GitHub Copilot"),
    ("lmstudio", "LM Studio"),
    ("azure-foundry", "Azure Foundry"),
    ("stepfun", "StepFun"),
    ("arcee", "Arcee AI"),
    ("gmi", "GMI Cloud"),
    ("huggingface", "Hugging Face"),
    ("kilocode", "Kilo Code"),
    ("opencode-zen", "OpenCode Zen"),
    ("opencode-go", "OpenCode Go"),
    ("xiaomi", "Xiaomi MiMo"),
    ("tencent-tokenhub", "Tencent TokenHub"),
    ("ollama-cloud", "Ollama Cloud"),
    ("novita", "Novita AI"),
    ("nous", "Nous Portal（OAuth）"),
    ("openai-codex", "OpenAI Codex（OAuth）"),
    ("minimax-oauth", "MiniMax（OAuth）"),
    ("xai-oauth", "xAI Grok（OAuth）"),
    ("qwen-oauth", "Qwen（OAuth）"),
    ("google-gemini-cli", "Gemini CLI（OAuth）"),
    ("copilot-acp", "GitHub Copilot ACP（OAuth）"),
    ("bedrock", "AWS Bedrock"),
];
const HERMES_YAML_FIELDS: &[NativeConfigField] = &[
    select_field(
        "hermes_provider",
        "Provider",
        "Hermes 模型 Provider",
        &["model", "provider"],
        HERMES_PROVIDER_OPTIONS,
    ),
    text_field(
        "hermes_model",
        "模型",
        "Hermes 默认模型",
        &["model", "default"],
    ),
    text_field(
        "hermes_base_url",
        "API URL",
        "Provider 自定义端点",
        &["model", "base_url"],
    ),
    secret_field(
        "hermes_inline_key",
        "自定义 API Key",
        "custom Provider 的内联凭据",
        &["model", "api_key"],
    ),
];
const HERMES_ENV_FIELDS: &[NativeConfigField] = &[
    secret_field(
        "hermes_anthropic_key",
        "Anthropic API Key",
        "ANTHROPIC_API_KEY",
        &["ANTHROPIC_API_KEY"],
    ),
    secret_field(
        "hermes_openai_key",
        "OpenAI API Key",
        "OPENAI_API_KEY",
        &["OPENAI_API_KEY"],
    ),
    text_field(
        "hermes_openai_base_url",
        "OpenAI API URL",
        "OPENAI_BASE_URL",
        &["OPENAI_BASE_URL"],
    ),
    secret_field(
        "hermes_openrouter_key",
        "OpenRouter API Key",
        "OPENROUTER_API_KEY",
        &["OPENROUTER_API_KEY"],
    ),
    secret_field(
        "hermes_kimi_key",
        "Kimi API Key",
        "KIMI_API_KEY",
        &["KIMI_API_KEY"],
    ),
    secret_field(
        "hermes_gemini_key",
        "Google AI Studio API Key",
        "GOOGLE_API_KEY",
        &["GOOGLE_API_KEY"],
    ),
    secret_field(
        "hermes_deepseek_key",
        "DeepSeek API Key",
        "DEEPSEEK_API_KEY",
        &["DEEPSEEK_API_KEY"],
    ),
    secret_field(
        "hermes_xai_key",
        "xAI API Key",
        "XAI_API_KEY",
        &["XAI_API_KEY"],
    ),
    secret_field(
        "hermes_zai_key",
        "Z.AI API Key",
        "GLM_API_KEY",
        &["GLM_API_KEY"],
    ),
    secret_field(
        "hermes_minimax_key",
        "MiniMax API Key",
        "MINIMAX_API_KEY",
        &["MINIMAX_API_KEY"],
    ),
    secret_field(
        "hermes_minimax_cn_key",
        "MiniMax 中国 API Key",
        "MINIMAX_CN_API_KEY",
        &["MINIMAX_CN_API_KEY"],
    ),
    secret_field(
        "hermes_kimi_cn_key",
        "Kimi 中国 API Key",
        "KIMI_CN_API_KEY",
        &["KIMI_CN_API_KEY"],
    ),
    secret_field(
        "hermes_nvidia_key",
        "NVIDIA API Key",
        "NVIDIA_API_KEY",
        &["NVIDIA_API_KEY"],
    ),
    secret_field(
        "hermes_alibaba_key",
        "DashScope API Key",
        "DASHSCOPE_API_KEY",
        &["DASHSCOPE_API_KEY"],
    ),
    secret_field(
        "hermes_alibaba_coding_plan_key",
        "Alibaba Coding Plan API Key",
        "ALIBABA_CODING_PLAN_API_KEY",
        &["ALIBABA_CODING_PLAN_API_KEY"],
    ),
    secret_field(
        "hermes_copilot_key",
        "GitHub Copilot Token",
        "COPILOT_GITHUB_TOKEN",
        &["COPILOT_GITHUB_TOKEN"],
    ),
    secret_field(
        "hermes_lmstudio_key",
        "LM Studio API Key",
        "LM_API_KEY",
        &["LM_API_KEY"],
    ),
    text_field(
        "hermes_lmstudio_base_url",
        "LM Studio API URL",
        "LM_BASE_URL",
        &["LM_BASE_URL"],
    ),
    secret_field(
        "hermes_azure_foundry_key",
        "Azure Foundry API Key",
        "AZURE_FOUNDRY_API_KEY",
        &["AZURE_FOUNDRY_API_KEY"],
    ),
    text_field(
        "hermes_azure_foundry_base_url",
        "Azure Foundry API URL",
        "AZURE_FOUNDRY_BASE_URL",
        &["AZURE_FOUNDRY_BASE_URL"],
    ),
    secret_field(
        "hermes_stepfun_key",
        "StepFun API Key",
        "STEPFUN_API_KEY",
        &["STEPFUN_API_KEY"],
    ),
    secret_field(
        "hermes_arcee_key",
        "Arcee AI API Key",
        "ARCEEAI_API_KEY",
        &["ARCEEAI_API_KEY"],
    ),
    secret_field(
        "hermes_gmi_key",
        "GMI API Key",
        "GMI_API_KEY",
        &["GMI_API_KEY"],
    ),
    secret_field(
        "hermes_huggingface_key",
        "Hugging Face Token",
        "HF_TOKEN",
        &["HF_TOKEN"],
    ),
    secret_field(
        "hermes_kilocode_key",
        "Kilo Code API Key",
        "KILOCODE_API_KEY",
        &["KILOCODE_API_KEY"],
    ),
    secret_field(
        "hermes_opencode_zen_key",
        "OpenCode Zen API Key",
        "OPENCODE_ZEN_API_KEY",
        &["OPENCODE_ZEN_API_KEY"],
    ),
    secret_field(
        "hermes_opencode_go_key",
        "OpenCode Go API Key",
        "OPENCODE_GO_API_KEY",
        &["OPENCODE_GO_API_KEY"],
    ),
    secret_field(
        "hermes_xiaomi_key",
        "Xiaomi MiMo API Key",
        "XIAOMI_API_KEY",
        &["XIAOMI_API_KEY"],
    ),
    secret_field(
        "hermes_tencent_tokenhub_key",
        "Tencent TokenHub API Key",
        "TOKENHUB_API_KEY",
        &["TOKENHUB_API_KEY"],
    ),
    secret_field(
        "hermes_ollama_cloud_key",
        "Ollama Cloud API Key",
        "OLLAMA_API_KEY",
        &["OLLAMA_API_KEY"],
    ),
    secret_field(
        "hermes_novita_key",
        "Novita API Key",
        "NOVITA_API_KEY",
        &["NOVITA_API_KEY"],
    ),
];
const HERMES_CONFIG: &[NativeConfigBinding] = &[
    NativeConfigBinding {
        binding_id: "config",
        home_relative_path: ".hermes/config.yaml",
        directory_override_env: Some("HERMES_HOME"),
        override_relative_path: "config.yaml",
        format: NativeConfigFormat::Yaml,
        fields: HERMES_YAML_FIELDS,
    },
    NativeConfigBinding {
        binding_id: "env",
        home_relative_path: ".hermes/.env",
        directory_override_env: Some("HERMES_HOME"),
        override_relative_path: ".env",
        format: NativeConfigFormat::Dotenv,
        fields: HERMES_ENV_FIELDS,
    },
];

const CODEBUDDY_FIELDS: &[NativeConfigField] = &[
    secret_field(
        "codebuddy_api_key",
        "API Key",
        "CodeBuddy API Key",
        &["CODEBUDDY_API_KEY"],
    ),
    select_field(
        "codebuddy_environment",
        "环境",
        "公网、内网或私有部署",
        &["CODEBUDDY_INTERNET_ENVIRONMENT"],
        &[
            ("overseas", "海外公网"),
            ("internal", "中国内网"),
            ("ioa", "iOA"),
            ("self_hosted", "私有部署"),
        ],
    ),
    text_field(
        "codebuddy_base_url",
        "私有部署 URL",
        "CodeBuddy 自托管服务地址",
        &["CODEBUDDY_BASE_URL"],
    ),
];
const CODEBUDDY_CONFIG: &[NativeConfigBinding] = &[NativeConfigBinding {
    binding_id: "env",
    home_relative_path: ".codebuddy/.env",
    directory_override_env: Some("CODEBUDDY_CONFIG_DIR"),
    override_relative_path: ".env",
    format: NativeConfigFormat::Dotenv,
    fields: CODEBUDDY_FIELDS,
}];

const KIMI_INTERFACE_OPTIONS: &[(&str, &str)] = &[
    ("kimi", "Kimi"),
    ("openai", "OpenAI Chat Completions"),
    ("openai_responses", "OpenAI Responses"),
    ("anthropic", "Anthropic"),
    ("google-genai", "Google GenAI"),
    ("vertexai", "Vertex AI"),
];
const KIMI_FIELDS: &[NativeConfigField] = &[
    select_field(
        "kimi_interface",
        "接口类型",
        "Provider 使用的 API 协议",
        &["providers", "vibex", "type"],
        KIMI_INTERFACE_OPTIONS,
    ),
    text_field(
        "kimi_base_url",
        "API URL",
        "Provider 基础地址",
        &["providers", "vibex", "base_url"],
    ),
    secret_field(
        "kimi_api_key",
        "内联 API Key",
        "直接写入 Provider 的 API Key",
        &["providers", "vibex", "api_key"],
    ),
    json_field(
        "kimi_provider_env",
        "Provider 环境变量",
        "env 鉴权或 Vertex ADC 使用的环境变量对象",
        &["providers", "vibex", "env"],
    ),
    tagged_text_field(
        "kimi_model",
        "模型 ID",
        "Kimi Code 默认模型",
        &["models", "vibex", "model"],
        ("provider", "vibex"),
    ),
    number_field(
        "kimi_context",
        "上下文长度",
        "模型最大上下文 Token",
        &["models", "vibex", "max_context_size"],
    ),
    json_field(
        "kimi_capabilities",
        "模型能力",
        "Kimi capabilities 数组，例如 [\"tool_use\", \"thinking\"]",
        &["models", "vibex", "capabilities"],
    ),
    json_field(
        "kimi_support_efforts",
        "可选推理强度",
        "Kimi ACP 暴露给会话的 support_efforts 数组",
        &["models", "vibex", "support_efforts"],
    ),
    text_field(
        "kimi_default_effort",
        "默认推理强度",
        "必须是 support_efforts 中的一个值",
        &["models", "vibex", "default_effort"],
    ),
];
const KIMI_CONFIG: &[NativeConfigBinding] = &[NativeConfigBinding {
    binding_id: "config",
    home_relative_path: ".kimi-code/config.toml",
    directory_override_env: Some("KIMI_CODE_HOME"),
    override_relative_path: "config.toml",
    format: NativeConfigFormat::Toml,
    fields: KIMI_FIELDS,
}];

const GROK_PERMISSION_OPTIONS: &[(&str, &str)] = &[
    ("default", "默认询问"),
    ("acceptEdits", "自动接受编辑"),
    ("auto", "自动执行"),
    ("dontAsk", "不主动询问"),
    ("bypassPermissions", "跳过权限确认"),
    ("plan", "计划模式"),
];
const GROK_FIELDS: &[NativeConfigField] = &[
    select_field(
        "grok_permission",
        "权限模式",
        "Grok 工具权限策略",
        &["ui", "permission_mode"],
        GROK_PERMISSION_OPTIONS,
    ),
    select_field(
        "grok_effort",
        "推理强度",
        "默认 reasoning effort",
        &["models", "default_reasoning_effort"],
        EFFORT_OPTIONS,
    ),
    text_field(
        "grok_model",
        "默认模型",
        "Grok 默认模型 ID",
        &["models", "default"],
    ),
    authentication(text_field(
        "grok_custom_model_id",
        "自定义模型 ID",
        "VibeX 管理的自定义模型标识",
        &["model", "vibex", "model"],
    )),
    authentication(text_field(
        "grok_base_url",
        "API URL",
        "自定义模型端点",
        &["model", "vibex", "base_url"],
    )),
    authentication(secret_field(
        "grok_api_key",
        "xAI API Key",
        "自定义模型凭据",
        &["model", "vibex", "api_key"],
    )),
    authentication(select_field(
        "grok_api_backend",
        "API 协议",
        "自定义模型使用的请求协议",
        &["model", "vibex", "api_backend"],
        &[
            ("responses", "OpenAI Responses"),
            ("chat_completions", "OpenAI Chat Completions"),
            ("messages", "Anthropic Messages"),
        ],
    )),
    authentication(number_field(
        "grok_context_window",
        "上下文长度",
        "自定义模型的 context_window",
        &["model", "vibex", "context_window"],
    )),
    number_field(
        "grok_auto_compact_threshold",
        "自动压缩阈值",
        "session.auto_compact_threshold_percent（0–100）",
        &["session", "auto_compact_threshold_percent"],
    ),
];
const GROK_CONFIG: &[NativeConfigBinding] = &[NativeConfigBinding {
    binding_id: "config",
    home_relative_path: ".grok/config.toml",
    directory_override_env: Some("GROK_HOME"),
    override_relative_path: "config.toml",
    format: NativeConfigFormat::Toml,
    fields: GROK_FIELDS,
}];

const CURSOR_SANDBOX_OPTIONS: &[(&str, &str)] = &[("enabled", "启用"), ("disabled", "关闭")];
const CURSOR_FIELDS: &[NativeConfigField] = &[
    text_field(
        "cursor_model",
        "默认模型",
        "作为 Cursor 根级 --model 启动参数传入",
        &["vibex", "model"],
    ),
    boolean_field(
        "cursor_force",
        "Run Everything",
        "作为 Cursor 根级 --force 启动参数传入",
        &["vibex", "force"],
    ),
    select_field(
        "cursor_sandbox_mode",
        "沙箱",
        "Cursor CLI sandbox.mode",
        &["sandbox", "mode"],
        CURSOR_SANDBOX_OPTIONS,
    ),
    json_field(
        "cursor_allow_rules",
        "允许规则",
        "命令与工具 allow 规则（JSON）",
        &["permissions", "allow"],
    ),
    json_field(
        "cursor_deny_rules",
        "拒绝规则",
        "命令与工具 deny 规则（JSON）",
        &["permissions", "deny"],
    ),
];
const CURSOR_CONFIG: &[NativeConfigBinding] = &[NativeConfigBinding {
    binding_id: "config",
    home_relative_path: ".cursor/cli-config.json",
    directory_override_env: Some("CURSOR_CONFIG_DIR"),
    override_relative_path: "cli-config.json",
    format: NativeConfigFormat::Json,
    fields: CURSOR_FIELDS,
}];
const DEEPSEEK_HARNESS_FIELDS: &[NativeConfigField] = &[authentication(secret_field(
    "deepseek_harness_api_key",
    "API Key",
    "DeepSeek API Key",
    &["DEEPSEEK_API_KEY"],
))];
const DEEPSEEK_HARNESS_CONFIG: &[NativeConfigBinding] = &[
    NativeConfigBinding {
        binding_id: "credentials",
        home_relative_path: ".dsh/.credentials.yaml",
        directory_override_env: Some("DSH_HOME"),
        override_relative_path: ".credentials.yaml",
        format: NativeConfigFormat::Yaml,
        fields: DEEPSEEK_HARNESS_FIELDS,
    },
    NativeConfigBinding {
        binding_id: "settings",
        home_relative_path: ".dsh/settings.yaml",
        directory_override_env: Some("DSH_HOME"),
        override_relative_path: "settings.yaml",
        format: NativeConfigFormat::Yaml,
        fields: &[],
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
        surface: NativeConfigSurface::Configuration,
    }
}

const fn tagged_text_field(
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
        kind: NativeConfigFieldKind::Text,
        options: EMPTY_OPTIONS,
        object_discriminator: Some(object_discriminator),
        surface: NativeConfigSurface::Configuration,
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
        surface: NativeConfigSurface::Configuration,
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
        surface: NativeConfigSurface::Configuration,
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
        surface: NativeConfigSurface::Configuration,
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
        surface: NativeConfigSurface::Configuration,
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
        surface: NativeConfigSurface::Configuration,
    }
}

const fn json_field(
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
        kind: NativeConfigFieldKind::Json,
        options: EMPTY_OPTIONS,
        object_discriminator: None,
        surface: NativeConfigSurface::Configuration,
    }
}

const fn authentication(mut field: NativeConfigField) -> NativeConfigField {
    field.surface = NativeConfigSurface::Authentication;
    field
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

fn native_npx(
    package: &'static str,
    version: &'static str,
    command: &'static str,
    args: &'static [&'static str],
    node_requirement: &'static str,
    integrity: &'static str,
) -> ProfileInstallSource {
    ProfileInstallSource::Npx {
        component: ProfileComponent::CombinedRuntime,
        package,
        version,
        command,
        args,
        node_requirement,
        integrity,
    }
}

const NATIVE_SKILLS_SETTINGS: &[AgentSettingsFeature] = &[AgentSettingsFeature::NativeSkills];
const AUTH_MODE_SETTINGS: &[AgentSettingsFeature] = &[
    AgentSettingsFeature::AuthenticationMode,
    AgentSettingsFeature::GrokPlugins,
    AgentSettingsFeature::NativeMcp,
    AgentSettingsFeature::NativeSkills,
];
const CLAUDE_SETTINGS: &[AgentSettingsFeature] = &[
    AgentSettingsFeature::AuthenticationMode,
    AgentSettingsFeature::ReusableModelProviders,
    AgentSettingsFeature::NativeMcp,
    AgentSettingsFeature::NativeSkills,
];
const CODEX_SETTINGS: &[AgentSettingsFeature] = &[
    AgentSettingsFeature::AuthenticationMode,
    AgentSettingsFeature::ModelCatalog,
    AgentSettingsFeature::ReusableModelProviders,
    AgentSettingsFeature::CodexModelCatalog,
    AgentSettingsFeature::NativeMcp,
    AgentSettingsFeature::NativeSkills,
];
const ANTIGRAVITY_SETTINGS: &[AgentSettingsFeature] = &[
    AgentSettingsFeature::AuthenticationMode,
    AgentSettingsFeature::ReusableModelProviders,
    AgentSettingsFeature::NativeMcp,
    AgentSettingsFeature::NativeSkills,
];
const OPENCODE_SETTINGS: &[AgentSettingsFeature] = &[
    AgentSettingsFeature::OpenCodeProviders,
    AgentSettingsFeature::OpenCodePlugins,
    AgentSettingsFeature::NativeMcp,
    AgentSettingsFeature::NativeSkills,
];
const KIMI_SETTINGS: &[AgentSettingsFeature] = &[
    AgentSettingsFeature::ModelCatalog,
    AgentSettingsFeature::NativeMcp,
    AgentSettingsFeature::NativeSkills,
];
const PI_SETTINGS: &[AgentSettingsFeature] = &[
    AgentSettingsFeature::PiConfiguration,
    AgentSettingsFeature::NativeSkills,
];
const CURSOR_SETTINGS: &[AgentSettingsFeature] = &[
    AgentSettingsFeature::AuthenticationMode,
    AgentSettingsFeature::ModelCatalog,
    AgentSettingsFeature::NativeMcp,
    AgentSettingsFeature::NativeSkills,
];
const DEEPSEEK_HARNESS_SETTINGS: &[AgentSettingsFeature] = &[
    AgentSettingsFeature::AuthenticationMode,
    AgentSettingsFeature::DshPlugins,
    AgentSettingsFeature::NativeSkills,
];

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
                "2.1.222",
                "claude",
                ">=20",
                "sha512-T8i+1SvOIL6rWEE7g7Of4xJ5MTwP7sT7O5fFFD1zlWL54XkKhshZWFQhz0reANbziBIV0AEkI5QdSXZkTgSBwA==",
            ),
            npx(
                ProfileComponent::AcpAdapter,
                "@agentclientprotocol/claude-agent-acp",
                "0.64.1",
                "claude-agent-acp",
                ">=22",
                "sha512-JUwtmECBGa7696YX79quxxSZ6Ud4tQkAtvxcG6VU2+cTOiWqc/QicsYjObdfHRDOg4oGFp7D8fUJCs/WJLGsaw==",
            ),
        ],
        external_candidates: CLAUDE_CANDIDATES,
        dependencies: NODE_22_DEPENDENCIES,
        management_actions: CLAUDE_ACTIONS,
        runtime_executable_env: Some("CLAUDE_CODE_EXECUTABLE"),
        native_config: CLAUDE_CONFIG,
        settings_features: CLAUDE_SETTINGS,
        authentication_precedence: AuthenticationPrecedence::ApiKeyThenAccount,
        authentication_required_by_default: true,
        account_evidence: Some(AccountEvidence {
            home_relative_directory: ".claude",
            directory_override_env: Some("CLAUDE_CONFIG_DIR"),
            override_relative_directory: "",
            relative_file: ".credentials.json",
            kind: AccountEvidenceKind::NonEmptyStringAt(&["claudeAiOauth", "accessToken"]),
        }),
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
                "1.1.9",
                "codex-acp",
                ">=20",
                "sha512-T78vetAQJ+XpP+0zT18ceEPTD10tqYvouDh0ht7mpCQjXuW3Vm5MzcuMRJMVBA2MwfCvGFXfOhGA7ogMSeOpFQ==",
            ),
        ],
        external_candidates: CODEX_CANDIDATES,
        dependencies: NODE_20_DEPENDENCIES,
        management_actions: CODEX_ACTIONS,
        runtime_executable_env: Some("CODEX_PATH"),
        native_config: CODEX_CONFIG,
        settings_features: CODEX_SETTINGS,
        authentication_precedence: AuthenticationPrecedence::AccountThenApiKey,
        authentication_required_by_default: true,
        account_evidence: Some(AccountEvidence {
            home_relative_directory: ".codex",
            directory_override_env: Some("CODEX_HOME"),
            override_relative_directory: "",
            relative_file: "auth.json",
            kind: AccountEvidenceKind::NonEmptyStringAt(&["tokens", "access_token"]),
        }),
    }
}

fn antigravity_profile() -> BuiltInProfile {
    BuiltInProfile {
        agent_id: AgentId::parse("antigravity").expect("bundled AgentId"),
        display_name: "Google Antigravity",
        description: "Google's AI coding agent (first-party ACP server)",
        icon: ProfileIcon {
            light: "/agents/antigravity.svg",
            dark: "/agents/antigravity.svg",
        },
        registry_binding: Some(ProfileRegistryBinding {
            registry_id: "antigravity-acp",
        }),
        topology: ProfileTopology::NativeAcp,
        supported_platforms: ANTIGRAVITY_PLATFORMS,
        install_sources: vec![ProfileInstallSource::Binary {
            component: ProfileComponent::CombinedRuntime,
            version: "1.0.0",
            command: "agy_acp_server",
            args: ANTIGRAVITY_LAUNCH_ARGS,
            artifacts: vec![
                tofu_binary_artifact(
                    "darwin-aarch64",
                    "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-agy_acp_server_20260818_01_RC01-darwin-arm64.zip",
                ),
                tofu_binary_artifact(
                    "linux-aarch64",
                    "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-agy_acp_server_20260818_01_RC01-linux-arm64.zip",
                ),
                tofu_binary_artifact(
                    "linux-x86_64",
                    "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-agy_acp_server_20260818_01_RC01-linux-x86_64.zip",
                ),
                tofu_binary_artifact(
                    "windows-aarch64",
                    "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-agy_acp_server_20260818_01_RC01-windows-arm64.zip",
                ),
                tofu_binary_artifact(
                    "windows-x86_64",
                    "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-agy_acp_server_20260818_01_RC01-windows-x86_64.zip",
                ),
            ],
            entry: Some(ProfileBinaryEntry {
                unix: "agy_acp_server.par",
                windows: "agy_acp_server.exe",
                unix_siblings: &["localharness_external"],
                windows_siblings: &["localharness_external.exe"],
            }),
        }],
        external_candidates: ANTIGRAVITY_CANDIDATES,
        dependencies: ARCHIVE_DEPENDENCIES,
        management_actions: ANTIGRAVITY_ACTIONS,
        runtime_executable_env: None,
        native_config: ANTIGRAVITY_CONFIG,
        settings_features: ANTIGRAVITY_SETTINGS,
        authentication_precedence: AuthenticationPrecedence::AccountThenApiKey,
        authentication_required_by_default: true,
        account_evidence: Some(AccountEvidence {
            home_relative_directory: ".gemini/antigravity-acp",
            directory_override_env: Some("GEMINI_HOME"),
            override_relative_directory: "antigravity-acp",
            relative_file: "acp_token.json",
            kind: AccountEvidenceKind::NonEmptyObject,
        }),
    }
}
fn openclaw_profile() -> BuiltInProfile {
    BuiltInProfile {
        agent_id: AgentId::parse("openclaw").expect("bundled AgentId"),
        display_name: "OpenClaw",
        description: "OpenClaw Gateway agent with native ACP support",
        icon: ProfileIcon {
            light: "/agents/openclaw.svg",
            dark: "/agents/openclaw.svg",
        },
        registry_binding: Some(ProfileRegistryBinding {
            registry_id: "openclaw-acp",
        }),
        topology: ProfileTopology::NativeAcp,
        supported_platforms: DESKTOP_PLATFORMS,
        install_sources: vec![native_npx(
            "openclaw",
            "2026.7.1",
            "openclaw",
            &["acp"],
            ">=22.22.3",
            "sha512-ge/Xss99CHAjPL/ikmH/UFoiOrjcxDB4sW3y9mhyCD+dYW3wzV7TKbAVdkrXFgAG2d2BjpJofP97zUZ+umxo8g==",
        )],
        external_candidates: OPENCLAW_CANDIDATES,
        dependencies: NODE_22_22_DEPENDENCIES,
        management_actions: OPENCLAW_ACTIONS,
        runtime_executable_env: None,
        native_config: OPENCLAW_CONFIG,
        settings_features: NATIVE_SKILLS_SETTINGS,
        authentication_precedence: AuthenticationPrecedence::SingleSource,
        authentication_required_by_default: false,
        account_evidence: None,
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
            version: "1.18.11",
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
            entry: None,
        }],
        external_candidates: OPENCODE_CANDIDATES,
        dependencies: ARCHIVE_DEPENDENCIES,
        management_actions: OPENCODE_ACTIONS,
        runtime_executable_env: None,
        native_config: OPENCODE_CONFIG,
        settings_features: OPENCODE_SETTINGS,
        authentication_precedence: AuthenticationPrecedence::SingleSource,
        authentication_required_by_default: false,
        account_evidence: Some(AccountEvidence {
            home_relative_directory: ".local/share",
            directory_override_env: Some("XDG_DATA_HOME"),
            override_relative_directory: "",
            relative_file: "opencode/auth.json",
            kind: AccountEvidenceKind::ProviderEntryNotApiKey,
        }),
    }
}

fn cline_profile() -> BuiltInProfile {
    BuiltInProfile {
        agent_id: AgentId::parse("cline").expect("bundled AgentId"),
        display_name: "Cline",
        description: "Cline's official CLI agent with native ACP support",
        icon: ProfileIcon {
            light: "/agents/cline.svg",
            dark: "/agents/cline.svg",
        },
        registry_binding: Some(ProfileRegistryBinding {
            registry_id: "cline",
        }),
        topology: ProfileTopology::NativeAcp,
        supported_platforms: DESKTOP_PLATFORMS,
        install_sources: vec![native_npx(
            "cline",
            "3.0.49",
            "cline",
            &["--acp"],
            ">=22",
            "sha512-yZj+L/gGORrb/5YBCUwOEmwgwExdlTU0hEcBA9a+es7Usd0iuAWAHwrWCPwMfHdBwvvuw9qxpwqdMa2v7KbisQ==",
        )],
        external_candidates: CLINE_CANDIDATES,
        dependencies: NODE_22_DEPENDENCIES,
        management_actions: CLINE_ACTIONS,
        runtime_executable_env: None,
        native_config: CLINE_CONFIG,
        settings_features: &[
            AgentSettingsFeature::NativeMcp,
            AgentSettingsFeature::NativeSkills,
        ],
        authentication_precedence: AuthenticationPrecedence::SingleSource,
        authentication_required_by_default: true,
        account_evidence: Some(AccountEvidence {
            home_relative_directory: ".cline/data",
            directory_override_env: Some("CLINE_DIR"),
            override_relative_directory: "",
            relative_file: "secrets.json",
            kind: AccountEvidenceKind::NonEmptyObject,
        }),
    }
}

fn hermes_profile() -> BuiltInProfile {
    BuiltInProfile {
        agent_id: AgentId::parse("hermes").expect("bundled AgentId"),
        display_name: "Hermes Agent",
        description: "Nous Research Hermes self-improving agent via ACP",
        icon: ProfileIcon {
            light: "/agents/hermes.png",
            dark: "/agents/hermes.png",
        },
        registry_binding: Some(ProfileRegistryBinding {
            registry_id: "hermes",
        }),
        topology: ProfileTopology::NativeAcp,
        supported_platforms: DESKTOP_PLATFORMS,
        install_sources: vec![ProfileInstallSource::Uvx {
            component: ProfileComponent::CombinedRuntime,
            package: "hermes-agent[acp,mcp]==0.19.0",
            version: "0.19.0",
            command: "hermes-acp",
            args: &[],
            uv_requirement: ">=0.5",
            python_requirement: ">=3.11,<3.14",
        }],
        external_candidates: HERMES_CANDIDATES,
        dependencies: UV_DEPENDENCIES,
        management_actions: HERMES_ACTIONS,
        runtime_executable_env: None,
        native_config: HERMES_CONFIG,
        settings_features: &[
            AgentSettingsFeature::NativeMcp,
            AgentSettingsFeature::NativeSkills,
        ],
        authentication_precedence: AuthenticationPrecedence::SingleSource,
        authentication_required_by_default: true,
        account_evidence: None,
    }
}

fn codebuddy_profile() -> BuiltInProfile {
    BuiltInProfile {
        agent_id: AgentId::parse("codebuddy").expect("bundled AgentId"),
        display_name: "CodeBuddy",
        description: "Tencent Cloud CodeBuddy official coding assistant via ACP",
        icon: ProfileIcon {
            light: "/agents/codebuddy.svg",
            dark: "/agents/codebuddy.svg",
        },
        registry_binding: Some(ProfileRegistryBinding {
            registry_id: "codebuddy-code",
        }),
        topology: ProfileTopology::NativeAcp,
        supported_platforms: DESKTOP_PLATFORMS,
        install_sources: vec![native_npx(
            "@tencent-ai/codebuddy-code",
            "2.132.0",
            "codebuddy",
            &["--acp"],
            ">=22",
            "sha512-JFa1q0ZXK+TUmqW3X7zgg9RLCHb5dAInLKrTZtEdtAjfhIDwQeBXjYlyPNDLYJg6Y2Ic3p4SGhbXaE+slnjP1Q==",
        )],
        external_candidates: CODEBUDDY_CANDIDATES,
        dependencies: NODE_22_DEPENDENCIES,
        management_actions: CODEBUDDY_ACTIONS,
        runtime_executable_env: None,
        native_config: CODEBUDDY_CONFIG,
        settings_features: &[
            AgentSettingsFeature::NativeMcp,
            AgentSettingsFeature::NativeSkills,
        ],
        authentication_precedence: AuthenticationPrecedence::SingleSource,
        authentication_required_by_default: true,
        account_evidence: None,
    }
}

fn kimi_code_profile() -> BuiltInProfile {
    BuiltInProfile {
        agent_id: AgentId::parse("kimi_code").expect("bundled AgentId"),
        display_name: "Kimi Code",
        description: "Moonshot AI's official CLI coding assistant via ACP",
        icon: ProfileIcon {
            light: "/agents/kimi.svg",
            dark: "/agents/kimi.svg",
        },
        registry_binding: Some(ProfileRegistryBinding {
            registry_id: "kimi-code",
        }),
        topology: ProfileTopology::NativeAcp,
        supported_platforms: DESKTOP_PLATFORMS,
        install_sources: vec![native_npx(
            "@moonshot-ai/kimi-code",
            "0.31.1",
            "kimi",
            &["acp"],
            ">=22.19",
            "sha512-Hyly4EjzemSjla479jC47h+K98wNvRKOqGwu6mBncI/MlIafqEByUXeGl/9+DsOKdiE6fQTxkxiAcgusBay56Q==",
        )],
        external_candidates: KIMI_CANDIDATES,
        dependencies: NODE_22_19_DEPENDENCIES,
        management_actions: KIMI_ACTIONS,
        runtime_executable_env: None,
        native_config: KIMI_CONFIG,
        settings_features: KIMI_SETTINGS,
        authentication_precedence: AuthenticationPrecedence::AccountThenApiKey,
        authentication_required_by_default: true,
        account_evidence: Some(AccountEvidence {
            home_relative_directory: ".kimi-code",
            directory_override_env: Some("KIMI_CODE_HOME"),
            override_relative_directory: "",
            relative_file: "credentials/kimi-code.json",
            kind: AccountEvidenceKind::NonEmptyObject,
        }),
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
                "https://github.com/anomalyco/opencode/releases/download/v1.18.11/opencode-darwin-arm64.zip"
            }
            "opencode-darwin-x64.zip" => {
                "https://github.com/anomalyco/opencode/releases/download/v1.18.11/opencode-darwin-x64.zip"
            }
            "opencode-linux-arm64.tar.gz" => {
                "https://github.com/anomalyco/opencode/releases/download/v1.18.11/opencode-linux-arm64.tar.gz"
            }
            "opencode-linux-x64.tar.gz" => {
                "https://github.com/anomalyco/opencode/releases/download/v1.18.11/opencode-linux-x64.tar.gz"
            }
            "opencode-windows-arm64.zip" => {
                "https://github.com/anomalyco/opencode/releases/download/v1.18.11/opencode-windows-arm64.zip"
            }
            "opencode-windows-x64.zip" => {
                "https://github.com/anomalyco/opencode/releases/download/v1.18.11/opencode-windows-x64.zip"
            }
            _ => unreachable!("bundled OpenCode artifact"),
        },
        sha256: Some(sha256),
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
                "0.83.0",
                "pi",
                ">=22",
                "sha512-uYhF+FsZxogoSX/AxBcUdiY+ZklubwaXyAoEGA2eQwsHcyEAhUYIKh/WLXe/a8+k8eTCmxb+ZN2Zo9mzQtzbWw==",
            ),
            npx(
                ProfileComponent::AcpAdapter,
                "pi-acp",
                "0.0.33",
                "pi-acp",
                ">=22",
                "sha512-vX9kY1tK14E72G4dBAx+RGCk/k7XPjTHls6dLUxA8WSkBav6B6JHuSBv3eusp50LCR/GTRsR2kIKsG0Z5jANzw==",
            ),
        ],
        external_candidates: PI_CANDIDATES,
        dependencies: NODE_22_DEPENDENCIES,
        management_actions: PI_ACTIONS,
        runtime_executable_env: None,
        native_config: PI_CONFIG,
        settings_features: PI_SETTINGS,
        authentication_precedence: AuthenticationPrecedence::SingleSource,
        authentication_required_by_default: true,
        account_evidence: Some(AccountEvidence {
            home_relative_directory: ".pi/agent",
            directory_override_env: Some("PI_CODING_AGENT_DIR"),
            override_relative_directory: "",
            relative_file: "auth.json",
            kind: AccountEvidenceKind::ProviderEntryNotApiKey,
        }),
    }
}

fn grok_profile() -> BuiltInProfile {
    BuiltInProfile {
        agent_id: AgentId::parse("grok").expect("bundled AgentId"),
        display_name: "Grok",
        description: "xAI's official coding agent via grok agent stdio",
        icon: ProfileIcon {
            light: "/agents/grok.svg",
            dark: "/agents/grok.svg",
        },
        registry_binding: Some(ProfileRegistryBinding {
            registry_id: "grok-build",
        }),
        topology: ProfileTopology::NativeAcp,
        supported_platforms: DESKTOP_PLATFORMS,
        install_sources: vec![native_npx(
            "@xai-official/grok",
            "0.2.118",
            "grok",
            &["agent", "stdio"],
            ">=20",
            "sha512-51BumA66Y9Xp1Qv2HCphEE/lTmMF4DPPueX945b3nH30/VN0T3QsbxBQLVrRtv0Q6FmDAR3bns4T9fRebpCBbg==",
        )],
        external_candidates: GROK_CANDIDATES,
        dependencies: NODE_20_DEPENDENCIES,
        management_actions: GROK_ACTIONS,
        runtime_executable_env: None,
        native_config: GROK_CONFIG,
        settings_features: AUTH_MODE_SETTINGS,
        authentication_precedence: AuthenticationPrecedence::AccountThenApiKey,
        authentication_required_by_default: true,
        account_evidence: Some(AccountEvidence {
            home_relative_directory: ".grok",
            directory_override_env: Some("GROK_HOME"),
            override_relative_directory: "",
            relative_file: "auth.json",
            kind: AccountEvidenceKind::NonEmptyObject,
        }),
    }
}

fn cursor_profile() -> BuiltInProfile {
    const VERSION: &str = "2026.07.23-e383d2b";
    BuiltInProfile {
        agent_id: AgentId::parse("cursor").expect("bundled AgentId"),
        display_name: "Cursor",
        description: "Cursor's coding agent via cursor-agent acp",
        icon: ProfileIcon {
            light: "/agents/cursor-light.svg",
            dark: "/agents/cursor-dark.svg",
        },
        registry_binding: Some(ProfileRegistryBinding {
            registry_id: "cursor",
        }),
        topology: ProfileTopology::NativeAcp,
        supported_platforms: DESKTOP_PLATFORMS,
        install_sources: vec![ProfileInstallSource::Binary {
            component: ProfileComponent::CombinedRuntime,
            version: VERSION,
            command: "cursor-agent",
            args: &["acp"],
            artifacts: vec![
                binary_artifact(
                    "darwin-aarch64",
                    "https://downloads.cursor.com/lab/2026.07.23-e383d2b/darwin/arm64/agent-cli-package.tar.gz",
                    "f2eb25851f2079dcdf0558a816e06c402d187abfca93255d35167020439ebbf2",
                ),
                binary_artifact(
                    "darwin-x86_64",
                    "https://downloads.cursor.com/lab/2026.07.23-e383d2b/darwin/x64/agent-cli-package.tar.gz",
                    "f44194dfcb41468f85bfb4e53978ac098a2a78ce629806490c32b80b40975aa2",
                ),
                binary_artifact(
                    "linux-aarch64",
                    "https://downloads.cursor.com/lab/2026.07.23-e383d2b/linux/arm64/agent-cli-package.tar.gz",
                    "f40b99647cb24e0da885e97620a2048034f1fe8961910d573d827d77c4d26dcb",
                ),
                binary_artifact(
                    "linux-x86_64",
                    "https://downloads.cursor.com/lab/2026.07.23-e383d2b/linux/x64/agent-cli-package.tar.gz",
                    "702ad595213bee5df0268be9f80a19f29fcceaa2a42fc55e39f2b5199051f0c4",
                ),
                binary_artifact(
                    "windows-aarch64",
                    "https://downloads.cursor.com/lab/2026.07.23-e383d2b/windows/arm64/agent-cli-package.zip",
                    "1d94e23b6901c3ab3092ed4094d77843d7a4978df24a873cc8c6421026f5efdc",
                ),
                binary_artifact(
                    "windows-x86_64",
                    "https://downloads.cursor.com/lab/2026.07.23-e383d2b/windows/x64/agent-cli-package.zip",
                    "96c7b739eaf2fc68869341f2e0781ccbefd631a7493d373728bf14141749035f",
                ),
            ],
            entry: Some(ProfileBinaryEntry {
                unix: "dist-package/cursor-agent",
                windows: "dist-package/cursor-agent.cmd",
                unix_siblings: &[],
                windows_siblings: &[],
            }),
        }],
        external_candidates: CURSOR_CANDIDATES,
        dependencies: ARCHIVE_DEPENDENCIES,
        management_actions: CURSOR_ACTIONS,
        runtime_executable_env: None,
        native_config: CURSOR_CONFIG,
        settings_features: CURSOR_SETTINGS,
        authentication_precedence: AuthenticationPrecedence::AccountThenApiKey,
        authentication_required_by_default: true,
        account_evidence: None,
    }
}

fn deepseek_harness_profile() -> BuiltInProfile {
    BuiltInProfile {
        agent_id: AgentId::parse("deepseek_harness").expect("bundled AgentId"),
        display_name: "DeepSeek Harness",
        description: "DeepSeek Harness through the community deepseek-acp adapter",
        icon: ProfileIcon {
            light: "/agents/deepseek-harness-light.svg",
            dark: "/agents/deepseek-harness-dark.svg",
        },
        registry_binding: Some(ProfileRegistryBinding {
            registry_id: "deepseek-acp",
        }),
        topology: ProfileTopology::NativeAcp,
        supported_platforms: DESKTOP_PLATFORMS,
        install_sources: vec![native_npx(
            "deepseek-acp",
            "0.3.0",
            "deepseek-acp",
            &[],
            ">=22",
            "sha512-Mj3vEK/RY6+M0U1CWnAwGJ0A1ylI4lIg0CwmwiPTCl8V84syvug4jM6GzzjhDhhKaxGiJFtAOOCx1eF6yAEAfQ==",
        )],
        external_candidates: DEEPSEEK_HARNESS_CANDIDATES,
        dependencies: NODE_22_DEPENDENCIES,
        management_actions: DEEPSEEK_HARNESS_ACTIONS,
        runtime_executable_env: None,
        native_config: DEEPSEEK_HARNESS_CONFIG,
        settings_features: DEEPSEEK_HARNESS_SETTINGS,
        authentication_precedence: AuthenticationPrecedence::SingleSource,
        authentication_required_by_default: true,
        account_evidence: None,
    }
}

const fn binary_artifact(
    platform: &'static str,
    archive_url: &'static str,
    sha256: &'static str,
) -> ProfileBinaryArtifact {
    ProfileBinaryArtifact {
        platform,
        archive_url,
        sha256: Some(sha256),
    }
}

const fn tofu_binary_artifact(
    platform: &'static str,
    archive_url: &'static str,
) -> ProfileBinaryArtifact {
    ProfileBinaryArtifact {
        platform,
        archive_url,
        sha256: None,
    }
}
