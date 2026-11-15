use super::*;

pub(super) const OPENCLAW_FIELDS: &[NativeConfigField] = &[
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
];
pub(super) const OPENCLAW_CONFIG: &[NativeConfigBinding] = &[NativeConfigBinding {
    binding_id: "config",
    home_relative_path: ".openclaw/openclaw.json",
    directory_override_env: Some("OPENCLAW_HOME"),
    override_relative_path: "openclaw.json",
    format: NativeConfigFormat::Json,
    fields: OPENCLAW_FIELDS,
}];

pub(super) const CLINE_PROVIDER_OPTIONS: &[(&str, &str)] = &[
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
pub(super) const CLINE_STATE_FIELDS: &[NativeConfigField] = &[
    authentication(select_field(
        "cline_provider",
        "Provider",
        "Cline API Provider",
        &["apiProvider"],
        CLINE_PROVIDER_OPTIONS,
    )),
    authentication(text_field(
        "cline_model",
        "模型",
        "Cline 模型 ID",
        &["apiModelId"],
    )),
    authentication(text_field(
        "cline_base_url",
        "API URL",
        "OpenAI 兼容端点",
        &["openAiBaseUrl"],
    )),
];
pub(super) const CLINE_SECRET_FIELDS: &[NativeConfigField] = &[
    authentication(secret_field(
        "cline_anthropic_key",
        "Anthropic API Key",
        "Cline Anthropic 凭据",
        &["apiKey"],
    )),
    authentication(secret_field(
        "cline_openai_key",
        "OpenAI API Key",
        "Cline OpenAI 凭据",
        &["openAiApiKey"],
    )),
    authentication(secret_field(
        "cline_openrouter_key",
        "OpenRouter API Key",
        "Cline OpenRouter 凭据",
        &["openRouterApiKey"],
    )),
    authentication(secret_field(
        "cline_gemini_key",
        "Gemini API Key",
        "Cline Gemini 凭据",
        &["geminiApiKey"],
    )),
];
pub(super) const CLINE_CONFIG: &[NativeConfigBinding] = &[
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

pub(super) const HERMES_PROVIDER_OPTIONS: &[(&str, &str)] = &[
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
pub(super) const HERMES_YAML_FIELDS: &[NativeConfigField] = &[
    authentication(select_field(
        "hermes_provider",
        "Provider",
        "Hermes 模型 Provider",
        &["model", "provider"],
        HERMES_PROVIDER_OPTIONS,
    )),
    authentication(text_field(
        "hermes_model",
        "模型",
        "Hermes 默认模型",
        &["model", "default"],
    )),
    authentication(text_field(
        "hermes_base_url",
        "API URL",
        "Provider 自定义端点",
        &["model", "base_url"],
    )),
    authentication(secret_field(
        "hermes_inline_key",
        "自定义 API Key",
        "custom Provider 的内联凭据",
        &["model", "api_key"],
    )),
];
pub(super) const HERMES_ENV_FIELDS: &[NativeConfigField] = &[
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
pub(super) const HERMES_CONFIG: &[NativeConfigBinding] = &[
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

pub(super) const CODEBUDDY_FIELDS: &[NativeConfigField] = &[
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
pub(super) const CODEBUDDY_CONFIG: &[NativeConfigBinding] = &[NativeConfigBinding {
    binding_id: "env",
    home_relative_path: ".codebuddy/.env",
    directory_override_env: Some("CODEBUDDY_CONFIG_DIR"),
    override_relative_path: ".env",
    format: NativeConfigFormat::Dotenv,
    fields: CODEBUDDY_FIELDS,
}];

pub(super) const KIMI_INTERFACE_OPTIONS: &[(&str, &str)] = &[
    ("kimi", "Kimi"),
    ("openai", "OpenAI Chat Completions"),
    ("openai_responses", "OpenAI Responses"),
    ("anthropic", "Anthropic"),
    ("google-genai", "Google GenAI"),
    ("vertexai", "Vertex AI"),
];
pub(super) const KIMI_FIELDS: &[NativeConfigField] = &[
    authentication(select_field(
        "kimi_interface",
        "接口类型",
        "Provider 使用的 API 协议",
        &["providers", "vibex", "type"],
        KIMI_INTERFACE_OPTIONS,
    )),
    authentication(text_field(
        "kimi_base_url",
        "API URL",
        "Provider 基础地址",
        &["providers", "vibex", "base_url"],
    )),
    authentication(secret_field(
        "kimi_api_key",
        "内联 API Key",
        "直接写入 Provider 的 API Key",
        &["providers", "vibex", "api_key"],
    )),
    authentication(json_field(
        "kimi_provider_env",
        "Provider 环境变量",
        "env 鉴权或 Vertex ADC 使用的环境变量对象",
        &["providers", "vibex", "env"],
    )),
    authentication(tagged_text_field(
        "kimi_model",
        "模型 ID",
        "Kimi Code 默认模型",
        &["models", "vibex", "model"],
        ("provider", "vibex"),
    )),
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
pub(super) const KIMI_CONFIG: &[NativeConfigBinding] = &[NativeConfigBinding {
    binding_id: "config",
    home_relative_path: ".kimi-code/config.toml",
    directory_override_env: Some("KIMI_CODE_HOME"),
    override_relative_path: "config.toml",
    format: NativeConfigFormat::Toml,
    fields: KIMI_FIELDS,
}];

pub(super) const GROK_PERMISSION_OPTIONS: &[(&str, &str)] = &[
    ("ask", "询问"),
    ("auto", "自动执行"),
    ("always-approve", "跳过权限确认"),
];
pub(super) const GROK_FIELDS: &[NativeConfigField] = &[
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
    with_default(
        number_field(
            "grok_auto_compact_threshold",
            "自动压缩阈值（%）",
            "session.auto_compact_threshold_percent（0–100）",
            &["session", "auto_compact_threshold_percent"],
        ),
        "85",
    ),
];
pub(super) const GROK_CONFIG: &[NativeConfigBinding] = &[NativeConfigBinding {
    binding_id: "config",
    home_relative_path: ".grok/config.toml",
    directory_override_env: Some("GROK_HOME"),
    override_relative_path: "config.toml",
    format: NativeConfigFormat::Toml,
    fields: GROK_FIELDS,
}];

pub(super) const CURSOR_SANDBOX_OPTIONS: &[(&str, &str)] = &[("enabled", "启用"), ("disabled", "关闭")];
pub(super) const CURSOR_FIELDS: &[NativeConfigField] = &[
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
pub(super) const CURSOR_CONFIG: &[NativeConfigBinding] = &[NativeConfigBinding {
    binding_id: "config",
    home_relative_path: ".cursor/cli-config.json",
    directory_override_env: Some("CURSOR_CONFIG_DIR"),
    override_relative_path: "cli-config.json",
    format: NativeConfigFormat::Json,
    fields: CURSOR_FIELDS,
}];
pub(super) const DEEPSEEK_HARNESS_FIELDS: &[NativeConfigField] = &[authentication(secret_field(
    "deepseek_harness_api_key",
    "API Key",
    "DeepSeek API Key",
    &["refs", "DEEPSEEK_API_KEY"],
))];
pub(super) const DEEPSEEK_HARNESS_CONFIG: &[NativeConfigBinding] = &[
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

pub(super) const QODER_CONFIG: &[NativeConfigBinding] = &[NativeConfigBinding {
    binding_id: "settings",
    home_relative_path: ".qoder/settings.json",
    directory_override_env: Some("QODER_CONFIG_DIR"),
    override_relative_path: "settings.json",
    format: NativeConfigFormat::Json,
    fields: &[],
}];

pub(super) const fn text_field(
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
        default_value: None,
    }
}

pub(super) const fn tagged_text_field(
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
        default_value: None,
    }
}

pub(super) const fn secret_field(
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
        default_value: None,
    }
}

pub(super) const fn tagged_secret_field(
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
        default_value: None,
    }
}

pub(super) const fn select_field(
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
        default_value: None,
    }
}

pub(super) const fn boolean_field(
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
        default_value: None,
    }
}

pub(super) const fn boolean_field_default(
    field_id: &'static str,
    label: &'static str,
    description: &'static str,
    path: &'static [&'static str],
    default_value: &'static str,
) -> NativeConfigField {
    let mut field = boolean_field(field_id, label, description, path);
    field.default_value = Some(default_value);
    field
}

pub(super) const fn number_field(
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
        default_value: None,
    }
}

pub(super) const fn json_field(
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
        default_value: None,
    }
}

pub(super) const fn authentication(mut field: NativeConfigField) -> NativeConfigField {
    field.surface = NativeConfigSurface::Authentication;
    field
}

pub(super) const fn with_default(
    mut field: NativeConfigField,
    default_value: &'static str,
) -> NativeConfigField {
    field.default_value = Some(default_value);
    field
}

pub(super) fn npx(
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

pub(super) fn native_npx(
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

pub(super) const AUTH_MODE_SETTINGS: &[AgentSettingsFeature] = &[
    AgentSettingsFeature::AuthenticationMode,
    AgentSettingsFeature::ReusableModelProviders,
    AgentSettingsFeature::GrokPlugins,
    AgentSettingsFeature::NativeMcp,
    AgentSettingsFeature::NativeSkills,
];
pub(super) const CLAUDE_SETTINGS: &[AgentSettingsFeature] = &[
    AgentSettingsFeature::AuthenticationMode,
    AgentSettingsFeature::ReusableModelProviders,
    AgentSettingsFeature::NativeMcp,
    AgentSettingsFeature::NativeSkills,
];
pub(super) const CODEX_SETTINGS: &[AgentSettingsFeature] = &[
    AgentSettingsFeature::AuthenticationMode,
    AgentSettingsFeature::ReusableModelProviders,
    AgentSettingsFeature::NativeMcp,
    AgentSettingsFeature::NativeSkills,
];
pub(super) const ANTIGRAVITY_SETTINGS: &[AgentSettingsFeature] = &[
    AgentSettingsFeature::AuthenticationMode,
    AgentSettingsFeature::ReusableModelProviders,
    AgentSettingsFeature::NativeMcp,
    AgentSettingsFeature::NativeSkills,
];
pub(super) const OPENCODE_SETTINGS: &[AgentSettingsFeature] = &[
    AgentSettingsFeature::AuthenticationMode,
    AgentSettingsFeature::OpenCodeProviders,
    AgentSettingsFeature::OpenCodePlugins,
    AgentSettingsFeature::NativeMcp,
    AgentSettingsFeature::NativeSkills,
];
/// Qoder authenticates through `qoder login` (or `QODER_PERSONAL_ACCESS_TOKEN`
/// as the same account's headless credential). There is no official API Key
/// env and no custom endpoint. Skills live in `~/.qoder/skills`; MCP servers
/// live in `~/.qoder/settings.json` `mcpServers`.
pub(super) const QODER_SETTINGS: &[AgentSettingsFeature] = &[
    AgentSettingsFeature::AuthenticationMode,
    AgentSettingsFeature::ReusableModelProviders,
    AgentSettingsFeature::NativeMcp,
    AgentSettingsFeature::NativeSkills,
];
/// Subscription login, plus a same-account headless secret that is not an
/// official API mode. Supports native MCP and Skills directories.
pub(super) const SUBSCRIPTION_AUTH_SETTINGS: &[AgentSettingsFeature] = &[
    AgentSettingsFeature::AuthenticationMode,
    AgentSettingsFeature::NativeMcp,
    AgentSettingsFeature::NativeSkills,
];
pub(super) const PROVIDER_AUTH_SETTINGS: &[AgentSettingsFeature] = &[
    AgentSettingsFeature::AuthenticationMode,
    AgentSettingsFeature::ReusableModelProviders,
    AgentSettingsFeature::NativeMcp,
    AgentSettingsFeature::NativeSkills,
];
/// Command Code documents `~/.commandcode/skills`, `.commandcode/skills`, and
/// `~/.commandcode/mcp.json`.
pub(super) const COMMAND_CODE_SETTINGS: &[AgentSettingsFeature] = &[
    AgentSettingsFeature::AuthenticationMode,
    AgentSettingsFeature::ReusableModelProviders,
    AgentSettingsFeature::NativeMcp,
    AgentSettingsFeature::NativeSkills,
];
/// Official ZCode owns the account. User skills live under
/// `$ZCODE_HOME/skills` or `~/.zcode/skills`. Client MCP entries live under
/// `$ZCODE_HOME/mcp.json` and are forwarded over `session/new`.
pub(super) const ZCODE_SETTINGS: &[AgentSettingsFeature] = &[
    AgentSettingsFeature::AuthenticationMode,
    AgentSettingsFeature::ReusableModelProviders,
    AgentSettingsFeature::NativeMcp,
    AgentSettingsFeature::NativeSkills,
];
pub(super) const ZCODE_ACTIONS: &[ProfileManagementAction] = &[terminal_action(
    "login",
    "登录 ZCode",
    "打开浏览器完成 ZCode 官方账号登录",
    ProfileManagementActionKind::Login,
    &[
        program("zcode", &["login"]),
        program("zcode-acp-server", &["login"]),
    ],
)];
pub(super) const KIMI_SETTINGS: &[AgentSettingsFeature] = &[
    AgentSettingsFeature::AuthenticationMode,
    AgentSettingsFeature::ReusableModelProviders,
    AgentSettingsFeature::ModelCatalog,
    AgentSettingsFeature::NativeMcp,
    AgentSettingsFeature::NativeSkills,
];
pub(super) const PI_SETTINGS: &[AgentSettingsFeature] = &[
    AgentSettingsFeature::AuthenticationMode,
    AgentSettingsFeature::ReusableModelProviders,
    AgentSettingsFeature::PiConfiguration,
    AgentSettingsFeature::PiPlugins,
    AgentSettingsFeature::NativeSkills,
];
pub(super) const CURSOR_SETTINGS: &[AgentSettingsFeature] = &[
    AgentSettingsFeature::AuthenticationMode,
    AgentSettingsFeature::ModelCatalog,
    AgentSettingsFeature::NativeMcp,
    AgentSettingsFeature::NativeSkills,
];
pub(super) const DEEPSEEK_HARNESS_SETTINGS: &[AgentSettingsFeature] = &[
    AgentSettingsFeature::AuthenticationMode,
    AgentSettingsFeature::DshPlugins,
    AgentSettingsFeature::NativeMcp,
    AgentSettingsFeature::NativeSkills,
];
/// MiMo Code is an OpenCode fork: Xiaomi OAuth is the official subscription,
/// first-party keys live in `auth.json`, and catalog/custom endpoints use the
/// same provider JSON as OpenCode. Plugins are the `plugin` array in
/// `mimocode.json` plus the cache under `~/.cache/mimocode`.
pub(super) const MIMO_CODE_SETTINGS: &[AgentSettingsFeature] = &[
    AgentSettingsFeature::AuthenticationMode,
    AgentSettingsFeature::OpenCodeProviders,
    AgentSettingsFeature::OpenCodePlugins,
    AgentSettingsFeature::NativeMcp,
    AgentSettingsFeature::NativeSkills,
];
