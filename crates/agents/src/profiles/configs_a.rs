use super::*;

pub(super) const DESKTOP_PLATFORMS: &[&str] = &[
    "darwin-aarch64",
    "darwin-x86_64",
    "linux-aarch64",
    "linux-x86_64",
    "windows-aarch64",
    "windows-x86_64",
];

pub(super) const CLAUDE_CANDIDATES: &[ProfileExternalCandidate] = &[ProfileExternalCandidate {
    component: ProfileComponent::CombinedRuntime,
    executable: "claude",
    version_args: &["--version"],
    acp_args: &[],
}];
pub(super) const CODEX_CANDIDATES: &[ProfileExternalCandidate] = &[ProfileExternalCandidate {
    component: ProfileComponent::CombinedRuntime,
    executable: "codex",
    version_args: &["--version"],
    acp_args: &[],
}];
pub(super) const OPENCODE_ACP_ARGS: &[&str] = &["acp"];
pub(super) const OPENCODE_CANDIDATES: &[ProfileExternalCandidate] =
    &[external_acp("opencode", OPENCODE_ACP_ARGS)];
pub(super) const MIMO_ACP_ARGS: &[&str] = &["acp"];
pub(super) const MIMO_CANDIDATES: &[ProfileExternalCandidate] = &[external_acp("mimo", MIMO_ACP_ARGS)];
pub(super) const PI_CANDIDATES: &[ProfileExternalCandidate] = &[
    ProfileExternalCandidate {
        component: ProfileComponent::AgentRuntime,
        executable: "pi",
        version_args: &["--version"],
        acp_args: &[],
    },
    ProfileExternalCandidate {
        component: ProfileComponent::AcpAdapter,
        executable: "pi-acp",
        version_args: &["--version"],
        acp_args: &[],
    },
];
pub(super) const ANTIGRAVITY_CANDIDATES: &[ProfileExternalCandidate] = &[
    ProfileExternalCandidate {
        component: ProfileComponent::CombinedRuntime,
        executable: "agy_acp_server.par",
        version_args: &[],
        acp_args: ANTIGRAVITY_LAUNCH_ARGS,
    },
    ProfileExternalCandidate {
        component: ProfileComponent::CombinedRuntime,
        executable: "agy_acp_server",
        version_args: &[],
        acp_args: ANTIGRAVITY_LAUNCH_ARGS,
    },
];
pub(super) const ANTIGRAVITY_PLATFORMS: &[&str] = &[
    "darwin-aarch64",
    "darwin-x86_64",
    "linux-aarch64",
    "linux-x86_64",
    "windows-aarch64",
    "windows-x86_64",
];
pub(super) const ANTIGRAVITY_LAUNCH_ARGS: &[&str] = if cfg!(target_os = "linux") {
    &["--uid="]
} else {
    &[]
};
pub(super) const OPENCLAW_ACP_ARGS: &[&str] = &["acp"];
pub(super) const OPENCLAW_CANDIDATES: &[ProfileExternalCandidate] =
    &[external_acp("openclaw", OPENCLAW_ACP_ARGS)];
pub(super) const CLINE_ACP_ARGS: &[&str] = &["--acp"];
pub(super) const CLINE_CANDIDATES: &[ProfileExternalCandidate] = &[external_acp("cline", CLINE_ACP_ARGS)];
pub(super) const HERMES_ACP_ARGS: &[&str] = &["acp"];
pub(super) const HERMES_CANDIDATES: &[ProfileExternalCandidate] = &[
    external_acp("hermes", HERMES_ACP_ARGS),
    external("hermes-acp"),
];
pub(super) const CODEBUDDY_ACP_ARGS: &[&str] = &["--acp"];
pub(super) const CODEBUDDY_CANDIDATES: &[ProfileExternalCandidate] =
    &[external_acp("codebuddy", CODEBUDDY_ACP_ARGS)];
pub(super) const KIMI_ACP_ARGS: &[&str] = &["acp"];
pub(super) const KIMI_CANDIDATES: &[ProfileExternalCandidate] = &[external_acp("kimi", KIMI_ACP_ARGS)];
pub(super) const GROK_ACP_ARGS: &[&str] = &["agent", "stdio"];
pub(super) const GROK_CANDIDATES: &[ProfileExternalCandidate] = &[external_acp("grok", GROK_ACP_ARGS)];
pub(super) const CURSOR_ACP_ARGS: &[&str] = &["acp"];
pub(super) const CURSOR_CANDIDATES: &[ProfileExternalCandidate] =
    &[external_acp("cursor-agent", CURSOR_ACP_ARGS)];
pub(super) const DEEPSEEK_HARNESS_CANDIDATES: &[ProfileExternalCandidate] = &[external("deepseek-acp")];
/// `omp` without `acp` is the interactive TUI. The subcommand is the stdio server.
pub(super) const OMP_ACP_ARGS: &[&str] = &["acp"];
pub(super) const OMP_CANDIDATES: &[ProfileExternalCandidate] = &[external_acp("omp", OMP_ACP_ARGS)];
/// Qoder CLI turns into an ACP stdio server with `--acp`; without it the same
/// executable starts the interactive TUI. Both published executable names are
/// probed because the official ACP guide uses `qoder` while the Model Studio
/// install guide verifies `qodercli`.
pub(super) const QODER_ACP_ARGS: &[&str] = &["--acp"];
pub(super) const QODER_CANDIDATES: &[ProfileExternalCandidate] = &[
    external_acp("qoder", QODER_ACP_ARGS),
    external_acp("qodercli", QODER_ACP_ARGS),
];
/// `kiro-cli acp` is the native ACP server. A bare `kiro-cli` starts the TUI.
pub(super) const KIRO_ACP_ARGS: &[&str] = &["acp"];
pub(super) const KIRO_CANDIDATES: &[ProfileExternalCandidate] = &[external_acp("kiro-cli", KIRO_ACP_ARGS)];
/// The CLI runs on these desktops. Managed install artifacts exist only for
/// Linux zip archives; macOS is a DMG and Windows is an MSI, which this
/// installer does not extract. PATH detection still launches `kiro-cli acp`.
pub(super) const KIRO_PLATFORMS: &[&str] = &[
    "darwin-aarch64",
    "darwin-x86_64",
    "linux-aarch64",
    "linux-x86_64",
    "windows-x86_64",
];
pub(super) const AUGGIE_ACP_ARGS: &[&str] = &["--acp"];
pub(super) const AUGGIE_CANDIDATES: &[ProfileExternalCandidate] = &[external_acp("auggie", AUGGIE_ACP_ARGS)];
/// `acp serve` is the documented stdio server. Global flags, when present,
/// must precede the subcommand; Dimo does not pass permission overrides.
pub(super) const TRAE_ACP_ARGS: &[&str] = &["acp", "serve"];
pub(super) const TRAE_CANDIDATES: &[ProfileExternalCandidate] = &[
    external_acp("traex", TRAE_ACP_ARGS),
    external_acp("traecli", TRAE_ACP_ARGS),
    external_acp("trae-cli", TRAE_ACP_ARGS),
];
/// Published bins are `command-code`, `commandcode`, and `cmdc`. `cmd` is the
/// Windows shell and is not a candidate.
pub(super) const COMMAND_CODE_ACP_ARGS: &[&str] = &["acp"];
pub(super) const COMMAND_CODE_CANDIDATES: &[ProfileExternalCandidate] = &[
    external_acp("command-code", COMMAND_CODE_ACP_ARGS),
    external_acp("cmdc", COMMAND_CODE_ACP_ARGS),
    external_acp("commandcode", COMMAND_CODE_ACP_ARGS),
];
/// `zcode-acp-server server` is the pinned community bridge. Without `server`
/// the same bin opens a TTY. The official `zcode` binary is not an ACP server.
pub(super) const ZCODE_ACP_ARGS: &[&str] = &["server"];
pub(super) const ZCODE_CANDIDATES: &[ProfileExternalCandidate] =
    &[external_acp("zcode-acp-server", ZCODE_ACP_ARGS)];

pub(super) const fn external(executable: &'static str) -> ProfileExternalCandidate {
    ProfileExternalCandidate {
        component: ProfileComponent::CombinedRuntime,
        executable,
        version_args: &["--version"],
        acp_args: &[],
    }
}

pub(super) const fn external_acp(
    executable: &'static str,
    acp_args: &'static [&'static str],
) -> ProfileExternalCandidate {
    ProfileExternalCandidate {
        component: ProfileComponent::CombinedRuntime,
        executable,
        version_args: &["--version"],
        acp_args,
    }
}

pub(super) const NODE_20_DEPENDENCIES: &[ProfileDependency] = &[
    dependency("node", "Node.js", "node", &["--version"], ">=20", true),
    dependency("npm", "npm", "npm", &["--version"], "随 Node.js 安装", true),
];
pub(super) const NODE_22_DEPENDENCIES: &[ProfileDependency] = &[
    dependency("node", "Node.js", "node", &["--version"], ">=22", true),
    dependency("npm", "npm", "npm", &["--version"], "随 Node.js 安装", true),
];
pub(super) const NODE_22_19_DEPENDENCIES: &[ProfileDependency] = &[
    dependency("node", "Node.js", "node", &["--version"], ">=22.19", true),
    dependency("npm", "npm", "npm", &["--version"], "随 Node.js 安装", true),
];
pub(super) const NODE_24_16_DEPENDENCIES: &[ProfileDependency] = &[
    dependency("node", "Node.js", "node", &["--version"], ">=24.16.0", true),
    dependency("npm", "npm", "npm", &["--version"], "随 Node.js 安装", true),
];
pub(super) const OMP_DEPENDENCIES: &[ProfileDependency] = &[
    dependency("node", "Node.js", "node", &["--version"], ">=20", true),
    dependency("npm", "npm", "npm", &["--version"], "随 Node.js 安装", true),
    ProfileDependency {
        id: "bun",
        label: "Bun",
        executable: "bun",
        version_args: &["--version"],
        requirement: ">=1.3.14",
        required: true,
        repairable: true,
    },
];
pub(super) const ARCHIVE_DEPENDENCIES: &[ProfileDependency] = &[dependency(
    "archive",
    "归档解压工具",
    "tar",
    &["--version"],
    "系统自带（Windows ZIP 无需）",
    false,
)];

pub(super) const fn dependency(
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

// Claude Code and Codex run their official vendor CLIs directly as native engines.
pub(super) const CLAUDE_ACTIONS: &[ProfileManagementAction] = &[
    terminal_action(
        "login",
        "登录 Claude",
        "启动 Claude Code 官方账号登录",
        ProfileManagementActionKind::Login,
        &[program("claude", &["auth", "login", "--claudeai"])],
    ),
    terminal_action(
        "logout",
        "退出登录",
        "注销 Claude Code 本地账号",
        ProfileManagementActionKind::Logout,
        &[program("claude", &["auth", "logout"])],
    ),
    url_action(
        "subscription",
        "管理订阅",
        "打开 Claude 套餐与账单页面",
        "https://claude.ai/settings/billing",
    ),
];
pub(super) const CODEX_ACTIONS: &[ProfileManagementAction] = &[
    terminal_action(
        "login",
        "登录 ChatGPT",
        "启动 Codex 官方设备码登录",
        ProfileManagementActionKind::Login,
        &[program("codex", &["login", "--device-auth"])],
    ),
    terminal_action(
        "logout",
        "退出登录",
        "注销 Codex 本地账号",
        ProfileManagementActionKind::Logout,
        &[program("codex", &["logout"])],
    ),
    url_action(
        "subscription",
        "管理订阅",
        "打开 ChatGPT 套餐管理页面",
        "https://chatgpt.com/#pricing",
    ),
];
// The ACP server owns the browser sign-in, so this action runs the server itself
// instead of a vendor CLI.
pub(super) const ANTIGRAVITY_ACTIONS: &[ProfileManagementAction] = &[terminal_action(
    "login",
    "登录",
    "在浏览器中完成 Antigravity 账号登录",
    ProfileManagementActionKind::Login,
    &[program("agy_acp_server", &[])],
)];
pub(super) const OPENCLAW_ACTIONS: &[ProfileManagementAction] = &[terminal_action(
    "onboard",
    "初始化 OpenClaw",
    "运行官方引导并配置 Gateway",
    ProfileManagementActionKind::Setup,
    &[program("openclaw", &["onboard"])],
)];
pub(super) const OPENCODE_ACTIONS: &[ProfileManagementAction] = &[
    terminal_action(
        "login",
        "连接 Provider",
        "启动 OpenCode 官方认证流程",
        ProfileManagementActionKind::Login,
        &[program("opencode", &["auth", "login"])],
    ),
    terminal_action(
        "logout",
        "断开 Provider",
        "启动 OpenCode 官方注销流程",
        ProfileManagementActionKind::Logout,
        &[program("opencode", &["auth", "logout"])],
    ),
];
pub(super) const CLINE_ACTIONS: &[ProfileManagementAction] = &[terminal_action(
    "login",
    "登录 Cline",
    "启动 Cline 官方认证流程",
    ProfileManagementActionKind::Login,
    &[program("cline", &["auth"])],
)];
pub(super) const HERMES_ACTIONS: &[ProfileManagementAction] = &[
    terminal_action(
        "setup",
        "运行 Hermes Setup",
        "配置 Provider 与凭据",
        ProfileManagementActionKind::Setup,
        &[
            program("hermes", &["acp", "--setup"]),
            program("hermes-acp", &["--setup"]),
        ],
    ),
    terminal_action(
        "model",
        "配置模型",
        "打开 Hermes 模型配置流程",
        ProfileManagementActionKind::Setup,
        &[program("hermes", &["model"])],
    ),
];
pub(super) const CODEBUDDY_ACTIONS: &[ProfileManagementAction] = &[terminal_action(
    "login",
    "登录 CodeBuddy",
    "启动 CodeBuddy 官方登录",
    ProfileManagementActionKind::Login,
    &[program("codebuddy", &["login"])],
)];
pub(super) const QODER_ACTIONS: &[ProfileManagementAction] = &[terminal_action(
    "login",
    "登录 Qoder",
    "打开浏览器完成 Qoder 官方账号登录",
    ProfileManagementActionKind::Login,
    &[program("qodercli", &["login"])],
)];
pub(super) const KIRO_ACTIONS: &[ProfileManagementAction] = &[
    terminal_action(
        "login",
        "登录 Kiro",
        "打开浏览器完成 Kiro 官方账号登录",
        ProfileManagementActionKind::Login,
        &[program("kiro-cli", &["login"])],
    ),
    terminal_action(
        "logout",
        "退出登录",
        "注销 Kiro 本地账号",
        ProfileManagementActionKind::Logout,
        &[program("kiro-cli", &["logout"])],
    ),
];
pub(super) const AUGGIE_ACTIONS: &[ProfileManagementAction] = &[
    terminal_action(
        "login",
        "登录 Auggie",
        "打开浏览器完成 Augment 账号登录",
        ProfileManagementActionKind::Login,
        &[program("auggie", &["login"])],
    ),
    terminal_action(
        "logout",
        "退出登录",
        "注销 Auggie 本地账号",
        ProfileManagementActionKind::Logout,
        &[program("auggie", &["logout"])],
    ),
];
pub(super) const TRAE_ACTIONS: &[ProfileManagementAction] = &[
    terminal_action(
        "login",
        "登录 TRAE",
        "打开浏览器完成 TRAE 账号登录",
        ProfileManagementActionKind::Login,
        &[program("traex", &["login"]), program("traecli", &["login"])],
    ),
    terminal_action(
        "logout",
        "退出登录",
        "注销 TRAE 本地账号",
        ProfileManagementActionKind::Logout,
        &[
            program("traex", &["logout"]),
            program("traecli", &["logout"]),
        ],
    ),
];
pub(super) const COMMAND_CODE_ACTIONS: &[ProfileManagementAction] = &[
    terminal_action(
        "login",
        "登录 Command Code",
        "打开浏览器完成 Command Code 账号登录",
        ProfileManagementActionKind::Login,
        &[program("command-code", &["login"])],
    ),
    terminal_action(
        "logout",
        "退出登录",
        "注销 Command Code 本地账号",
        ProfileManagementActionKind::Logout,
        &[program("command-code", &["logout"])],
    ),
];
pub(super) const KIMI_ACTIONS: &[ProfileManagementAction] = &[
    terminal_action(
        "login",
        "登录 Kimi",
        "切换到 Kimi Code 订阅账号并启动设备码登录",
        ProfileManagementActionKind::Login,
        &[program("kimi", &["acp", "--login"])],
    ),
    terminal_action(
        "logout",
        "退出登录",
        "注销 Kimi Code 本地账号",
        ProfileManagementActionKind::Logout,
        &[program("kimi", &["logout"])],
    ),
];
pub(super) const PI_ACTIONS: &[ProfileManagementAction] = &[terminal_action(
    "login",
    "配置 Pi Provider",
    "启动 Pi，在终端中使用 /login",
    ProfileManagementActionKind::Login,
    &[program("pi", &[])],
)];
pub(super) const GROK_ACTIONS: &[ProfileManagementAction] = &[
    terminal_action(
        "login",
        "登录 Grok",
        "使用 SuperGrok / X Premium+ 账号登录",
        ProfileManagementActionKind::Login,
        &[program("grok", &["login"])],
    ),
    terminal_action(
        "logout",
        "退出登录",
        "注销 Grok 本地账号",
        ProfileManagementActionKind::Logout,
        &[program("grok", &["logout"])],
    ),
    url_action(
        "subscription",
        "管理订阅",
        "打开 Grok 套餐与账单页面",
        "https://grok.com?_s=usage",
    ),
];
pub(super) const CURSOR_ACTIONS: &[ProfileManagementAction] = &[
    terminal_action(
        "login",
        "登录 Cursor",
        "使用 Cursor 订阅账号登录",
        ProfileManagementActionKind::Login,
        &[program("cursor-agent", &["login"])],
    ),
    terminal_action(
        "logout",
        "退出登录",
        "注销 Cursor Agent 本地账号",
        ProfileManagementActionKind::Logout,
        &[program("cursor-agent", &["logout"])],
    ),
    url_action(
        "subscription",
        "管理订阅",
        "打开 Cursor 套餐管理页面",
        "https://www.cursor.com/settings",
    ),
];
pub(super) const DEEPSEEK_HARNESS_ACTIONS: &[ProfileManagementAction] = &[terminal_action(
    "setup",
    "配置 API Key",
    "把 DeepSeek API Key 写入本地凭据",
    ProfileManagementActionKind::Setup,
    &[program("deepseek-acp", &["--setup"])],
)];

pub(super) const fn program(program: &'static str, args: &'static [&'static str]) -> ProfileManagementProgram {
    ProfileManagementProgram { program, args }
}

pub(super) const fn terminal_action(
    id: &'static str,
    label: &'static str,
    description: &'static str,
    kind: ProfileManagementActionKind,
    programs: &'static [ProfileManagementProgram],
) -> ProfileManagementAction {
    ProfileManagementAction {
        id,
        label,
        description,
        kind,
        programs,
        url: None,
    }
}

pub(super) const fn url_action(
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
        programs: &[],
        url: Some(url),
    }
}

pub(super) const EMPTY_OPTIONS: &[(&str, &str)] = &[];
pub(super) const EFFORT_OPTIONS: &[(&str, &str)] = &[
    ("low", "低"),
    ("medium", "中"),
    ("high", "高"),
    ("xhigh", "极高"),
];
pub(super) const CLAUDE_PERMISSION_OPTIONS: &[(&str, &str)] = &[
    ("default", "默认询问"),
    ("acceptEdits", "自动接受编辑"),
    ("plan", "计划模式"),
    ("bypassPermissions", "跳过权限确认"),
];
pub(super) const CLAUDE_UPDATE_OPTIONS: &[(&str, &str)] = &[("stable", "稳定版"), ("latest", "最新版")];
pub(super) const CLAUDE_SETTINGS_FIELDS: &[NativeConfigField] = &[
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
    authentication(text_field(
        "haiku_model",
        "Haiku 默认模型",
        "haiku 别名解析到的模型",
        &["env", "ANTHROPIC_DEFAULT_HAIKU_MODEL"],
    )),
    authentication(text_field(
        "sonnet_model",
        "Sonnet 默认模型",
        "sonnet 别名解析到的模型",
        &["env", "ANTHROPIC_DEFAULT_SONNET_MODEL"],
    )),
    authentication(text_field(
        "opus_model",
        "Opus 默认模型",
        "opus 别名解析到的模型",
        &["env", "ANTHROPIC_DEFAULT_OPUS_MODEL"],
    )),
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
    boolean_field_default(
        "include_co_authored_by",
        "提交署名",
        "在提交和 Pull Request 中加入 Claude 署名",
        &["includeCoAuthoredBy"],
        "true",
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
pub(super) const CLAUDE_CONFIG: &[NativeConfigBinding] = &[NativeConfigBinding {
    binding_id: "settings",
    home_relative_path: ".claude/settings.json",
    directory_override_env: Some("CLAUDE_CONFIG_DIR"),
    override_relative_path: "settings.json",
    format: NativeConfigFormat::Json,
    fields: CLAUDE_SETTINGS_FIELDS,
}];
pub(super) const CODEX_AUTH_FIELDS: &[NativeConfigField] = &[authentication(secret_field(
    "openai_api_key",
    "OpenAI API Key",
    "写入 Codex 的本地认证文件",
    &["OPENAI_API_KEY"],
))];
pub(super) const CODEX_REASONING_OPTIONS: &[(&str, &str)] = &[
    ("minimal", "最少"),
    ("low", "低"),
    ("medium", "中"),
    ("high", "高"),
    ("xhigh", "极高"),
    ("max", "Max"),
    ("ultra", "Ultra"),
];
pub(super) const CODEX_SUMMARY_OPTIONS: &[(&str, &str)] = &[
    ("auto", "自动"),
    ("concise", "简洁"),
    ("detailed", "详细"),
    ("none", "不显示"),
];
pub(super) const CODEX_VERBOSITY_OPTIONS: &[(&str, &str)] =
    &[("low", "简洁"), ("medium", "适中"), ("high", "详细")];
pub(super) const CODEX_APPROVAL_OPTIONS: &[(&str, &str)] = &[
    ("untrusted", "仅信任安全命令"),
    ("on-request", "按需确认"),
    ("never", "从不确认"),
    ("granular", "按能力分别确认"),
];
pub(super) const CODEX_SANDBOX_OPTIONS: &[(&str, &str)] = &[
    ("read-only", "只读"),
    ("workspace-write", "工作区可写"),
    ("danger-full-access", "完全访问"),
];
pub(super) const CODEX_WEB_SEARCH_OPTIONS: &[(&str, &str)] =
    &[("disabled", "关闭"), ("cached", "缓存"), ("live", "实时")];
pub(super) const CODEX_CONFIG_FIELDS: &[NativeConfigField] = &[
    authentication(text_field(
        "codex_openai_base_url",
        "API URL",
        "Codex 使用的 API 或兼容网关地址",
        &["openai_base_url"],
    )),
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
    with_default(
        select_field(
            "codex_service_tier",
            "服务等级",
            "OpenAI service_tier：auto、fast 或 flex",
            &["service_tier"],
            &[("auto", "auto"), ("fast", "fast"), ("flex", "flex")],
        ),
        "auto",
    ),
    select_field(
        "codex_personality",
        "交流风格",
        "Codex 会话使用的 personality",
        &["personality"],
        &[("friendly", "友好"), ("pragmatic", "务实"), ("none", "无")],
    ),
    with_default(
        select_field(
            "codex_approval_policy",
            "命令确认",
            "执行命令前的确认策略",
            &["approval_policy"],
            CODEX_APPROVAL_OPTIONS,
        ),
        "on-request",
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
    with_default(
        select_field(
            "codex_web_search",
            "网页搜索",
            "Codex 网页搜索的数据来源",
            &["web_search"],
            CODEX_WEB_SEARCH_OPTIONS,
        ),
        "cached",
    ),
    boolean_field(
        "codex_responses_websockets",
        "关闭 WebSocket 连接",
        "关闭 Responses API 的 WebSocket 传输，写入活跃 model_providers 提供商的 supports_websockets；Codex 内置提供商不支持由此开关改变",
        &["features", "responses_websockets_v2"],
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
pub(super) const CODEX_CONFIG: &[NativeConfigBinding] = &[
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

pub(super) const OPENCODE_AUTH_FIELDS: &[NativeConfigField] = &[
    authentication(tagged_secret_field(
        "opencode_anthropic_api_key",
        "Anthropic API Key",
        "OpenCode 的 Anthropic provider 凭据",
        &["anthropic", "key"],
        ("type", "api"),
    )),
    authentication(tagged_secret_field(
        "opencode_openai_api_key",
        "OpenAI API Key",
        "OpenCode 的 OpenAI provider 凭据",
        &["openai", "key"],
        ("type", "api"),
    )),
    authentication(tagged_secret_field(
        "opencode_google_api_key",
        "Google API Key",
        "OpenCode 的 Google provider 凭据",
        &["google", "key"],
        ("type", "api"),
    )),
];
pub(super) const OPENCODE_SHARE_OPTIONS: &[(&str, &str)] =
    &[("manual", "手动"), ("auto", "自动"), ("disabled", "关闭")];
pub(super) const OPENCODE_SETTINGS_FIELDS: &[NativeConfigField] = &[
    select_field(
        "opencode_share",
        "会话分享",
        "会话链接的创建策略",
        &["share"],
        OPENCODE_SHARE_OPTIONS,
    ),
    boolean_field_default(
        "opencode_autoupdate",
        "自动更新",
        "启动时自动更新 OpenCode",
        &["autoupdate"],
        "true",
    ),
    text_field(
        "opencode_username",
        "显示名称",
        "对话中显示的用户名称",
        &["username"],
    ),
];
pub(super) const OPENCODE_CONFIG: &[NativeConfigBinding] = &[
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

pub(super) const MIMO_AUTH_FIELDS: &[NativeConfigField] = &[authentication(tagged_secret_field(
    "mimo_api_key",
    "MiMo API Key",
    "Xiaomi MiMo first-party API key in auth.json",
    &["mimo", "key"],
    ("type", "api"),
))];
pub(super) const MIMO_SETTINGS_FIELDS: &[NativeConfigField] = &[
    text_field(
        "mimo_model",
        "默认模型",
        "provider/model，例如 mimo/mimo-auto",
        &["model"],
    ),
    text_field(
        "mimo_default_agent",
        "默认 Agent",
        "未指定时使用的主 Agent（build / plan / compose）",
        &["default_agent"],
    ),
    text_field(
        "mimo_username",
        "显示名称",
        "对话中显示的用户名称",
        &["username"],
    ),
];
pub(super) const MIMO_CONFIG: &[NativeConfigBinding] = &[
    NativeConfigBinding {
        binding_id: "mimo_auth",
        home_relative_path: ".local/share/mimocode/auth.json",
        directory_override_env: Some("MIMOCODE_HOME"),
        override_relative_path: "data/auth.json",
        format: NativeConfigFormat::Json,
        fields: MIMO_AUTH_FIELDS,
    },
    NativeConfigBinding {
        binding_id: "mimo_config",
        home_relative_path: ".config/mimocode/mimocode.json",
        directory_override_env: Some("MIMOCODE_HOME"),
        override_relative_path: "config/mimocode.json",
        format: NativeConfigFormat::Json,
        fields: MIMO_SETTINGS_FIELDS,
    },
];
pub(super) const MIMO_ACTIONS: &[ProfileManagementAction] = &[
    terminal_action(
        "login",
        "登录 MiMo",
        "启动 Xiaomi MiMo 官方账号登录",
        ProfileManagementActionKind::Login,
        &[program("mimo", &["auth", "login"])],
    ),
    terminal_action(
        "logout",
        "退出登录",
        "注销 Xiaomi MiMo 本地账号",
        ProfileManagementActionKind::Logout,
        &[program("mimo", &["auth", "logout"])],
    ),
    url_action(
        "subscription",
        "管理订阅",
        "打开 Xiaomi MiMo 平台",
        "https://mimo.xiaomi.com/coder",
    ),
];

pub(super) const PI_AUTH_FIELDS: &[NativeConfigField] = &[
    authentication(tagged_secret_field(
        "pi_anthropic_api_key",
        "Anthropic API Key",
        "Pi 的 Anthropic provider 凭据",
        &["anthropic", "key"],
        ("type", "api_key"),
    )),
    authentication(tagged_secret_field(
        "pi_openai_api_key",
        "OpenAI API Key",
        "Pi 的 OpenAI provider 凭据",
        &["openai", "key"],
        ("type", "api_key"),
    )),
    authentication(tagged_secret_field(
        "pi_google_api_key",
        "Google API Key",
        "Pi 的 Google provider 凭据",
        &["google", "key"],
        ("type", "api_key"),
    )),
    authentication(tagged_secret_field(
        "pi_opencode_api_key",
        "OpenCode API Key",
        "Pi 的 OpenCode provider 凭据",
        &["opencode", "key"],
        ("type", "api_key"),
    )),
];
pub(super) const PI_THINKING_OPTIONS: &[(&str, &str)] = &[
    ("off", "关闭"),
    ("minimal", "最少"),
    ("low", "低"),
    ("medium", "中"),
    ("high", "高"),
    ("xhigh", "极高"),
];
pub(super) const PI_THEME_OPTIONS: &[(&str, &str)] = &[("dark", "深色"), ("light", "浅色")];
pub(super) const PI_SETTINGS_FIELDS: &[NativeConfigField] = &[
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
pub(super) const PI_CONFIG: &[NativeConfigBinding] = &[
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

pub(super) const ANTIGRAVITY_AUTH_OPTIONS: &[(&str, &str)] = &[
    ("oauth-personal", "Google 账号"),
    ("oauth-business", "Gemini Enterprise"),
    ("gemini-api-key", "Gemini API Key"),
    ("agent-platform", "Agent Platform"),
];
pub(super) const ANTIGRAVITY_TOOL_PERMISSION_OPTIONS: &[(&str, &str)] = &[
    ("request-review", "请求确认"),
    ("proceed-in-sandbox", "沙箱内自动执行"),
    ("strict", "严格确认"),
    ("always-proceed", "始终执行"),
];
pub(super) const ANTIGRAVITY_AGENT_MODE_OPTIONS: &[(&str, &str)] =
    &[("plan", "计划"), ("accept-edits", "自动接受编辑")];
pub(super) const ANTIGRAVITY_FIELDS: &[NativeConfigField] = &[
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
        &["gcp", "project"],
    )),
    authentication(text_field(
        "antigravity_cloud_location",
        "Google Cloud Location",
        "例如 global 或 us-central1",
        &["gcp", "location"],
    )),
];
pub(super) const ANTIGRAVITY_CLI_FIELDS: &[NativeConfigField] = &[
    with_default(
        select_field(
            "antigravity_tool_permission",
            "工具权限",
            "终端、写入与网页工具的确认策略",
            &["toolPermission"],
            ANTIGRAVITY_TOOL_PERMISSION_OPTIONS,
        ),
        "request-review",
    ),
    select_field(
        "antigravity_agent_mode",
        "执行模式",
        "启动后的默认执行模式",
        &["agentMode"],
        ANTIGRAVITY_AGENT_MODE_OPTIONS,
    ),
    boolean_field_default(
        "antigravity_terminal_sandbox",
        "终端沙箱",
        "将 Agent 发起的终端命令限制在操作系统容器内",
        &["enableTerminalSandbox"],
        "false",
    ),
    boolean_field(
        "antigravity_telemetry",
        "遥测",
        "向 Google 发送匿名用量与崩溃报告",
        &["enableTelemetry"],
    ),
    json_field(
        "antigravity_permissions",
        "权限规则",
        "allow / deny / ask 细粒度权限列表",
        &["permissions"],
    ),
];
pub(super) const ANTIGRAVITY_CONFIG: &[NativeConfigBinding] = &[
    NativeConfigBinding {
        binding_id: "settings",
        home_relative_path: ".gemini/antigravity-acp/settings.json",
        directory_override_env: Some("GEMINI_HOME"),
        override_relative_path: "antigravity-acp/settings.json",
        format: NativeConfigFormat::Json,
        fields: ANTIGRAVITY_FIELDS,
    },
    NativeConfigBinding {
        binding_id: "cli",
        home_relative_path: ".gemini/antigravity-cli/settings.json",
        directory_override_env: Some("GEMINI_HOME"),
        override_relative_path: "antigravity-cli/settings.json",
        format: NativeConfigFormat::Json,
        fields: ANTIGRAVITY_CLI_FIELDS,
    },
];
