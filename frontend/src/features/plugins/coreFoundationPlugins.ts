import {
  commandRegistry,
  kanbanViewRegistry,
  panelRegistry,
  serviceContainer,
  settingsPageRegistry,
  slashCommandRegistry,
  slotRegistry,
  viewRegistry,
  type VibeXPluginContext,
  type VibexPluginModule,
} from '@vibex/plugin-sdk';
import { useEffect, useState } from 'react';

import { registerBuiltinPanels } from '@/components/layout/panels/PanelRegistry';
import { registerBuiltinCommands } from '@/components/search/SearchPalette';
import { registerBuiltinKanbanViews } from '@/lib/kanbanViewCatalog';
import { registerBuiltinSettingsPages } from '@/pages/settings/SettingsLayout';
import {
  defaultEditorOpenerProviderService,
  defaultModelCatalogProviderService,
  defaultUsageProviderService,
  ensureHostProviderServicesRegistered,
} from './providers/hostProviderServices';
import { pluginRuntimeLoader } from './PluginRuntimeLoader';

export type CorePluginPlane = 'boot' | 'agent' | 'execution' | 'webui';

export type CoreFoundationArtworkKey =
  | 'corePluginManager'
  | 'coreHmr'
  | 'coreSettings'
  | 'coreCredentials'
  | 'coreAgentRuntime'
  | 'coreSession'
  | 'coreLlmProviders'
  | 'coreSkills'
  | 'coreMcp'
  | 'coreDelegation'
  | 'coreCompaction'
  | 'coreApproval'
  | 'coreShell'
  | 'coreWorkspaceGit'
  | 'coreFilesystem'
  | 'coreAutomation'
  | 'coreChannels'
  | 'webuiLayout'
  | 'webuiConversation'
  | 'webuiKanban'
  | 'webuiCommands'
  | 'webuiTheme';

export interface CorePluginPartDescriptor {
  readonly id: string;
  readonly moduleName: string;
  readonly kind:
    | 'service'
    | 'ui-surface'
    | 'tool'
    | 'hook'
    | 'command'
    | 'skill'
    | 'mcp'
    | 'worker';
  readonly titleZh: string;
  readonly titleEn: string;
  readonly summaryZh: string;
  readonly summaryEn: string;
}

export interface CoreFoundationPluginDescriptor {
  readonly id: string;
  readonly packageName: string;
  readonly plane: CorePluginPlane;
  readonly version: string;
  readonly artworkKey: string;
  readonly titleZh: string;
  readonly titleEn: string;
  readonly summaryZh: string;
  readonly summaryEn: string;
  readonly provides: readonly string[];
  readonly injects: readonly string[];
  readonly settingsPath?: string;
  readonly parts: readonly CorePluginPartDescriptor[];
  readonly onActivate?: (ctx: VibeXPluginContext) => void;
}

export interface CorePluginPlaneMetadata {
  readonly id: CorePluginPlane;
  readonly titleZh: string;
  readonly titleEn: string;
  readonly descriptionZh: string;
  readonly descriptionEn: string;
}

export const CORE_PLUGIN_PLANES: readonly CorePluginPlaneMetadata[] = [
  {
    id: 'webui',
    titleZh: 'WebUI 工作台与界面层 (Client WebUI Plane)',
    titleEn: 'Client WebUI Plane',
    descriptionZh:
      '对标 DSH @deepseek-ai/dsh-client-ui-*，将工作台 Dockview 布局、侧边栏、对话流、看板画布、全局命令面板与主题系统全部拆解为独立插件。',
    descriptionEn:
      'Decomposes the Workbench layout, sidebars, conversation stream, Kanban views, command palette, and theme engine into independent plugins.',
  },
  {
    id: 'agent',
    titleZh: 'Agent 运行时与会话层 (Agent & Session Plane)',
    titleEn: 'Agent & Session Plane',
    descriptionZh:
      '对标 DSH agent / agent-loop / session / skill-filesystem / delegation / compaction，提供多智能体会话循环、JSONL 持久化、Skill 与 MCP 生命周期管理。',
    descriptionEn:
      'Provides the multi-agent turn loop, durable JSONL session projection, Skill discovery, MCP supervision, delegation, and context compaction.',
  },
  {
    id: 'execution',
    titleZh: '环境、终端与执行层 (Environment & Execution Plane)',
    titleEn: 'Environment & Execution Plane',
    descriptionZh:
      '对标 DSH terminal / workspace-changes / fs-local / tool-schedule / workflow-ptc，将 Shell 终端、Git Worktree、文件系统、外部渠道与定时工作流全部插件化。',
    descriptionEn:
      'Pluginizes PTY shell terminals, Git worktrees & diff engine, local filesystem & editor openers, chat channels, and DAG workflow scheduling.',
  },
  {
    id: 'boot',
    titleZh: '内核与底座层 (Kernel & Boot Plane)',
    titleEn: 'Kernel & Boot Plane',
    descriptionZh:
      '对标 DSH dsh-base 内核底座，负责 Cordis 风格服务容器、HMR 副作用隔离、设置中心注册表与凭据额度探测。',
    descriptionEn:
      'Cordis-inspired service container, HMR fiber effect isolation, settings schema registry, and credential/usage probing.',
  },
] as const;

export const CORE_FOUNDATION_PLUGIN_DESCRIPTORS: readonly CoreFoundationPluginDescriptor[] =
  [
    // ---------------------------------------------------------------------------
    // 1. Kernel & Boot Plane (`boot`)
    // ---------------------------------------------------------------------------
    {
      id: 'vibex.core.plugin-manager',
      packageName: '@vibex/core-plugin-manager',
      plane: 'boot',
      version: '2.0.0',
      artworkKey: 'corePluginManager',
      titleZh: '插件控制面与市场管理',
      titleEn: 'Plugin Manager & Market',
      summaryZh:
        '负责 V2 插件包生命周期调度、依赖图解析、离线内置插件目录与插件市场发现。',
      summaryEn:
        'Coordinates V2 plugin lifecycles, dependency graph resolution, monorepo bundles, and marketplace discovery.',
      provides: ['vibex.plugin-manager', 'vibex.plugin-market'],
      injects: [],
      settingsPath: '/plugins',
      parts: [
        {
          id: 'plugin-control-plane',
          moduleName: 'PluginControlPlaneService',
          kind: 'service',
          titleZh: '插件控制面协调器',
          titleEn: 'Plugin Control Plane Coordinator',
          summaryZh: '管理插件安装、启用、停用、卸载与代次 (Generation) 原子切换。',
          summaryEn:
            'Manages plugin installation, activation generations, and atomic teardown.',
        },
        {
          id: 'plugin-dependency-graph',
          moduleName: 'DependencyFiberWatcher',
          kind: 'hook',
          titleZh: '跨插件依赖纤维监听器',
          titleEn: 'Cross-Plugin Dependency Watcher',
          summaryZh: '基于 ctx.services.inject 自动挂起与恢复下游依赖插件。',
          summaryEn:
            'Automatically suspends and resumes downstream plugins when upstream services change.',
        },
        {
          id: 'ui-plugin-manager-page',
          moduleName: 'PluginCatalogPage',
          kind: 'ui-surface',
          titleZh: 'DSH 风格插件管理视图',
          titleEn: 'DSH-Style Plugin Manager View',
          summaryZh: '提供已安装、发现市场与核心底座插件清单的统一管理界面。',
          summaryEn:
            'Unified management UI for installed packages, marketplace discovery, and core inventory.',
        },
      ],
    },
    {
      id: 'vibex.core.hmr',
      packageName: '@vibex/core-hmr',
      plane: 'boot',
      version: '2.0.0',
      artworkKey: 'coreHmr',
      titleZh: '热重载与副作用隔离引擎',
      titleEn: 'HMR & Fiber Effect Isolation',
      summaryZh:
        '基于 EffectScope 追踪每个插件纤维的全部注册项与 DOM 样式，支持毫秒级热替换与异常熔断隔离。',
      summaryEn:
        'Tracks all disposers and CSS layers per plugin fiber via EffectScope for sub-frame HMR and crash quarantine.',
      provides: ['vibex.hmr', 'vibex.boundary'],
      injects: ['vibex.plugin-manager'],
      parts: [
        {
          id: 'effect-scope-disposer',
          moduleName: 'EffectScopeKernel',
          kind: 'service',
          titleZh: 'LIFO 副作用自动回收栈',
          titleEn: 'LIFO EffectScope Disposer',
          summaryZh: '插件停用或重载时按后进先出顺序同帧清理全部 UI 槽位与拦截器。',
          summaryEn:
            'Cleans up all UI slots, commands, and interceptors in LIFO order on unload.',
        },
        {
          id: 'plugin-crash-boundary',
          moduleName: 'PluginErrorBoundary',
          kind: 'ui-surface',
          titleZh: '组件级错误边界与自动熔断',
          titleEn: 'Component Error Boundary & Quarantine',
          summaryZh: '捕获渲染异常并自动隔离崩溃插件，保护宿主工作台不白屏。',
          summaryEn:
            'Isolates component rendering crashes and quarantines failing plugins.',
        },
      ],
    },
    {
      id: 'vibex.core.settings',
      packageName: '@vibex/core-settings',
      plane: 'boot',
      version: '2.0.0',
      artworkKey: 'coreSettings',
      titleZh: '设置中心与 Schema 配置引擎',
      titleEn: 'Settings & Config Schema Engine',
      summaryZh:
        '统一托管系统设置导航路由，并为声明式插件提供零 UI JSON Schema 配置表单自动生成。',
      summaryEn:
        'Manages host settings navigation and auto-generates zero-UI JSON Schema configuration forms.',
      provides: ['vibex.settings', 'vibex.config-schema'],
      injects: [],
      settingsPath: '/settings/general',
      onActivate: () => {
        registerBuiltinSettingsPages();
      },
      parts: [
        {
          id: 'settings-page-registry',
          moduleName: 'SettingsPageRegistry',
          kind: 'ui-surface',
          titleZh: '设置路由与分组注册表',
          titleEn: 'Settings Route & Section Registry',
          summaryZh: '将通用、Agent、模型、MCP、Skill、渠道与自动化页面注册到设置树。',
          summaryEn:
            'Registers built-in and plugin settings pages into the unified navigation rail.',
        },
        {
          id: 'schema-settings-renderer',
          moduleName: 'PluginSchemaSettingsForm',
          kind: 'ui-surface',
          titleZh: 'JSON Schema 零代码表单引擎',
          titleEn: 'JSON Schema Form Renderer',
          summaryZh: '自动解析 plugin.json 中的 config.schema 渲染交互式设置表单。',
          summaryEn:
            'Renders interactive settings controls directly from declarative JSON Schema.',
        },
      ],
    },
    {
      id: 'vibex.core.credentials',
      packageName: '@vibex/core-credentials',
      plane: 'boot',
      version: '2.0.0',
      artworkKey: 'coreCredentials',
      titleZh: '凭据存储与订阅用量探针',
      titleEn: 'Credentials & Usage Prober',
      summaryZh:
        '管理本地 API 密钥、OAuth 登录态，并通过可插拔探针实时采集各 Agent 订阅额度与用量。',
      summaryEn:
        'Manages local credentials and probes real-time subscription quotas across agents.',
      provides: ['vibex.credentials', 'vibex.usage', 'provider.usage'],
      injects: ['vibex.settings'],
      settingsPath: '/settings/agents',
      onActivate: (ctx) => {
        ensureHostProviderServicesRegistered();
        ctx.services.provide('vibex.usage', defaultUsageProviderService);
        ctx.services.provide('provider.usage', defaultUsageProviderService);
      },
      parts: [
        {
          id: 'usage-provider-service',
          moduleName: 'UsageProviderService',
          kind: 'service',
          titleZh: '多智能体订阅用量探测服务',
          titleEn: 'Agent Subscription Usage Service',
          summaryZh: '支持通过 registerUsageProber 与瀑布流拦截器扩展套餐余量检测。',
          summaryEn:
            'Extensible usage prober pipeline with waterfall interception.',
        },
        {
          id: 'credential-auth-probe',
          moduleName: 'AgentAuthProbe',
          kind: 'service',
          titleZh: '本地凭据与鉴权状态中心',
          titleEn: 'Credential & Auth Status Probe',
          summaryZh: '统一检测 Claude Code、Codex、DSH、OpenCode 等 CLI 鉴权状态。',
          summaryEn:
            'Verifies authentication status across local CLI and API providers.',
        },
      ],
    },

    // ---------------------------------------------------------------------------
    // 2. Agent & Session Runtime Plane (`agent`)
    // ---------------------------------------------------------------------------
    {
      id: 'vibex.core.agent-runtime',
      packageName: '@vibex/core-agent-runtime',
      plane: 'agent',
      version: '2.0.0',
      artworkKey: 'coreAgentRuntime',
      titleZh: 'Agent 运行时与对话循环',
      titleEn: 'Agent Runtime & Turn Loop',
      summaryZh:
        '驱动 ACP v1/v2 对话轮次状态机、beforeTurn/afterTurn 洋葱拦截器链以及流式内部元数据侧信道。',
      summaryEn:
        'Drives the ACP v1/v2 conversation turn loop, beforeTurn/afterTurn waterfall hooks, and side-channel capture.',
      provides: [
        'vibex.agent-runtime',
        'vibex.agent-loop',
        'vibex.turn-hooks',
      ],
      injects: ['vibex.session', 'vibex.llm-providers'],
      settingsPath: '/settings/agents',
      parts: [
        {
          id: 'acp-session-driver',
          moduleName: 'AcpTurnLoopDriver',
          kind: 'service',
          titleZh: 'ACP 统一会话轮次驱动器',
          titleEn: 'ACP Unified Turn Driver',
          summaryZh: '协调 Claude Code、Codex、DeepSeek Harness、Gemini、OpenCode 等执行器。',
          summaryEn:
            'Coordinates turn execution across Claude Code, Codex, DSH, Gemini, and OpenCode.',
        },
        {
          id: 'turn-lifecycle-waterfall',
          moduleName: 'TurnHookWaterfall',
          kind: 'hook',
          titleZh: 'beforeTurn / afterTurn 洋葱拦截器链',
          titleEn: 'beforeTurn / afterTurn Onion Waterfall',
          summaryZh: '支持隐式上下文注入、草稿重写、超时降级与轮次完成回调。',
          summaryEn:
            'Supports implicit prompt injection, draft rewriting, per-hook timeouts, and after-turn callbacks.',
        },
        {
          id: 'internal-sidechannel-parser',
          moduleName: 'InternalMessageCapture',
          kind: 'hook',
          titleZh: '流式内部元数据侧信道解析器',
          titleEn: 'Streaming Internal Side-Channel Parser',
          summaryZh: '跨流式分片实时剥离 <vibex-internal-meta> 标签并路由至插件处理器。',
          summaryEn:
            'Strips internal metadata frames across streaming chunks and dispatches validated payloads.',
        },
      ],
    },
    {
      id: 'vibex.core.session',
      packageName: '@vibex/core-session',
      plane: 'agent',
      version: '2.0.0',
      artworkKey: 'coreSession',
      titleZh: '会话持久化与时间线投影',
      titleEn: 'Session Persistence & Projection',
      summaryZh:
        '提供 JSONL 增量会话落盘、SQLite 索引查询以及高性能分页对话时间线投影。',
      summaryEn:
        'Provides durable JSONL transcript persistence, SQLite indexing, and paginated timeline projection.',
      provides: [
        'vibex.session',
        'vibex.session-projection',
        'vibex.session-persistence',
      ],
      injects: [],
      parts: [
        {
          id: 'session-jsonl-store',
          moduleName: 'SessionPersistenceJsonl',
          kind: 'service',
          titleZh: 'JSONL 增量会话存储引擎',
          titleEn: 'JSONL Incremental Transcript Store',
          summaryZh: '按轮次与事件序号持久化原始对话流与工具调用快照。',
          summaryEn:
            'Persists raw conversation events and tool call snapshots in append-only JSONL.',
        },
        {
          id: 'session-timeline-projector',
          moduleName: 'ConversationTimelineProjector',
          kind: 'service',
          titleZh: '对话时间线聚合投影器',
          titleEn: 'Conversation Timeline Projector',
          summaryZh: '将细粒度流式增量合并为结构化消息块、思考链与工具轨迹组。',
          summaryEn:
            'Folds streaming deltas into structured message blocks, reasoning chains, and tool groups.',
        },
      ],
    },
    {
      id: 'vibex.core.llm-providers',
      packageName: '@vibex/core-llm-providers',
      plane: 'agent',
      version: '2.0.0',
      artworkKey: 'coreLlmProviders',
      titleZh: 'LLM 模型与供应商目录服务',
      titleEn: 'LLM Model & Provider Catalog',
      summaryZh:
        '聚合官方、合作伙伴与插件注册的模型供应商模板，支持一键切换与端点健康探测。',
      summaryEn:
        'Aggregates built-in and plugin-contributed model provider templates with endpoint probing.',
      provides: [
        'vibex.llm-providers',
        'vibex.model-catalog',
        'provider.model.catalog',
      ],
      injects: ['vibex.credentials'],
      settingsPath: '/settings/models',
      onActivate: (ctx) => {
        ensureHostProviderServicesRegistered();
        ctx.services.provide(
          'vibex.model-catalog',
          defaultModelCatalogProviderService
        );
        ctx.services.provide(
          'provider.model.catalog',
          defaultModelCatalogProviderService
        );
      },
      parts: [
        {
          id: 'model-catalog-registry',
          moduleName: 'ModelCatalogProviderService',
          kind: 'service',
          titleZh: '动态供应商模板注册表',
          titleEn: 'Dynamic Provider Template Registry',
          summaryZh: '合并静态目录与运行时插件注入的供应商配置模板。',
          summaryEn:
            'Merges static provider catalogs with runtime plugin catalog sources.',
        },
        {
          id: 'model-selection-ui',
          moduleName: 'ModelSelectorSurface',
          kind: 'ui-surface',
          titleZh: '输入框模型与推理强度选择器',
          titleEn: 'Composer Model & Effort Selector',
          summaryZh: '在会话输入框内快速切换模型、推理等级与供应商预设。',
          summaryEn:
            'Inline model, reasoning effort, and provider preset selector in the composer.',
        },
      ],
    },
    {
      id: 'vibex.core.skills',
      packageName: '@vibex/core-skills',
      plane: 'agent',
      version: '2.0.0',
      artworkKey: 'coreSkills',
      titleZh: 'Skill 技能管理器',
      titleEn: 'Skill Manager & Filesystem',
      summaryZh:
        '自动扫描工作区、全局与插件内置的 SKILL.md 技能包，向全量 Agent 同步投影并注入 / 技能命令。',
      summaryEn:
        'Discovers workspace, global, and plugin SKILL.md packages, projecting them across agents and `/` commands.',
      provides: ['vibex.skills', 'vibex.skill-filesystem', 'vibex.tool-skill'],
      injects: ['vibex.filesystem'],
      settingsPath: '/settings/skills',
      parts: [
        {
          id: 'skill-filesystem-scanner',
          moduleName: 'SkillFilesystemScanner',
          kind: 'service',
          titleZh: '多级 SKILL.md 文件系统扫描器',
          titleEn: 'Multi-Root SKILL.md Scanner',
          summaryZh: '解析 YAML Frontmatter、脚本与参考文档，构建统一技能索引。',
          summaryEn:
            'Parses SKILL.md frontmatter, scripts, and references across roots.',
        },
        {
          id: 'skill-cross-agent-projector',
          moduleName: 'SkillAgentProjector',
          kind: 'service',
          titleZh: '跨 Agent 技能目录同步投影器',
          titleEn: 'Cross-Agent Skill Projector',
          summaryZh: '将启用的插件技能自动投影至 Claude、Codex、DSH 等 Agent 技能目录。',
          summaryEn:
            'Projects enabled skills into Claude, Codex, DSH, and OpenCode skill directories.',
        },
        {
          id: 'ui-settings-skills',
          moduleName: 'SkillsSettingsPage',
          kind: 'ui-surface',
          titleZh: '设置 → 技能管理面板',
          titleEn: 'Settings → Skills Management Panel',
          summaryZh: '可视化查看、编辑、启停与导入导出全部 Agent 技能。',
          summaryEn: 'Visual manager for inspecting, toggling, and editing skills.',
        },
      ],
    },
    {
      id: 'vibex.core.mcp',
      packageName: '@vibex/core-mcp',
      plane: 'agent',
      version: '2.0.0',
      artworkKey: 'coreMcp',
      titleZh: 'MCP 协议服务管理器',
      titleEn: 'MCP Server Lifecycle Manager',
      summaryZh:
        '管理 Stdio、SSE 与 Worker HTTP 模式的 MCP 服务器进程池、工具清单缓存与多 Agent 绑定。',
      summaryEn:
        'Supervises Stdio, SSE, and Worker-HTTP MCP servers, tool schema caching, and multi-agent bindings.',
      provides: ['vibex.mcp', 'vibex.mcp-lifecycle'],
      injects: ['vibex.settings'],
      settingsPath: '/settings/mcp',
      parts: [
        {
          id: 'mcp-process-supervisor',
          moduleName: 'McpRuntimeSupervisor',
          kind: 'service',
          titleZh: '托管 MCP 运行时监管器',
          titleEn: 'Managed MCP Runtime Supervisor',
          summaryZh: '按需拉起插件内置 Node/二进制 MCP 服务并维护健康心跳。',
          summaryEn:
            'Spawns and health-checks plugin-bundled Node and native MCP servers.',
        },
        {
          id: 'mcp-agent-config-sync',
          moduleName: 'McpAgentConfigBinder',
          kind: 'service',
          titleZh: '全量 Agent MCP 配置同步器',
          titleEn: 'Multi-Agent MCP Config Synchronizer',
          summaryZh: '一键将 MCP 服务器写入各兼容 Agent 的配置文件。',
          summaryEn:
            'Synchronizes MCP server registrations across all compatible agents.',
        },
      ],
    },
    {
      id: 'vibex.core.delegation',
      packageName: '@vibex/core-delegation',
      plane: 'agent',
      version: '2.0.0',
      artworkKey: 'coreDelegation',
      titleZh: '多智能体协同与角色委派',
      titleEn: 'Multi-Agent Delegation & Teams',
      summaryZh:
        '内置多智能体协作空间、角色定义、团队编排与 & 子智能体任务并发委派引擎。',
      summaryEn:
        'Built-in multi-agent collaboration spaces, role definitions, team orchestration, and `&` subagent delegation.',
      provides: [
        'vibex.delegation',
        'vibex.subagent',
        'vibex.collaboration-space',
      ],
      injects: ['vibex.agent-runtime', 'vibex.session'],
      settingsPath: '/settings/subagents',
      parts: [
        {
          id: 'subagent-delegation-mcp',
          moduleName: 'DelegationMcpBridge',
          kind: 'mcp',
          titleZh: 'delegate_to_agent 协同调度工具',
          titleEn: 'delegate_to_agent Coordination Tool',
          summaryZh: '提供子智能体派发、状态轮询与任务取消的标准工具接口。',
          summaryEn:
            'Provides tools for spawning, monitoring, and cancelling delegated subagent tasks.',
        },
        {
          id: 'collaboration-space-ui',
          moduleName: 'CollaborationSpacesView',
          kind: 'ui-surface',
          titleZh: '多智能体协同空间与角色工作台',
          titleEn: 'Multi-Agent Collaboration Space UI',
          summaryZh: '可视化编排智能体角色、团队分工与跨会话协作消息流。',
          summaryEn:
            'Visual workspace for orchestrating agent roles, teams, and shared tasks.',
        },
      ],
    },
    {
      id: 'vibex.core.compaction',
      packageName: '@vibex/core-compaction',
      plane: 'agent',
      version: '2.0.0',
      artworkKey: 'coreCompaction',
      titleZh: '上下文压缩与结果修剪',
      titleEn: 'Context Compaction & Pruning',
      summaryZh:
        '监测 Token 窗口水位，支持 /compact 摘要压缩与大体积工具输出自动裁剪。',
      summaryEn:
        'Monitors token window utilization, providing `/compact` summarization and large tool output pruning.',
      provides: ['vibex.compaction', 'vibex.tool-result-pruner'],
      injects: ['vibex.session'],
      parts: [
        {
          id: 'session-compactor',
          moduleName: 'SessionContextCompactor',
          kind: 'service',
          titleZh: '长对话结构化摘要压缩器',
          titleEn: 'Structured Transcript Compactor',
          summaryZh: '保留关键架构决策与文件变更轨迹，释放上下文窗口空间。',
          summaryEn:
            'Summarizes long transcripts while preserving architectural decisions and file state.',
        },
      ],
    },
    {
      id: 'vibex.core.approval',
      packageName: '@vibex/core-approval',
      plane: 'agent',
      version: '2.0.0',
      artworkKey: 'coreApproval',
      titleZh: '工具审批与结构化提问',
      titleEn: 'Tool Approval & User Questions',
      summaryZh:
        '拦截高风险命令与文件修改请求进行交互式审批，并渲染多选澄清问题卡片。',
      summaryEn:
        'Gates sensitive tool executions behind interactive approvals and renders structured user question cards.',
      provides: ['vibex.approval', 'vibex.ask-user'],
      injects: ['vibex.agent-runtime'],
      parts: [
        {
          id: 'tool-approval-gate',
          moduleName: 'ApprovalGateController',
          kind: 'ui-surface',
          titleZh: '分级权限审批门禁卡片',
          titleEn: 'Tiered Tool Approval Card',
          summaryZh: '在时间线内联展示待审批命令参数、Diff 预览与允许/拒绝操作。',
          summaryEn:
            'Inline approval card for reviewing command arguments and file diffs.',
        },
        {
          id: 'user-questions-modal',
          moduleName: 'UserQuestionCardHost',
          kind: 'ui-surface',
          titleZh: '交互式需求澄清提问器',
          titleEn: 'Interactive Clarification Question Host',
          summaryZh: '渲染单选/多选与自定义填写的需求确认表单并回传给 Agent。',
          summaryEn:
            'Renders single/multi-select clarification questions from the agent.',
        },
      ],
    },

    // ---------------------------------------------------------------------------
    // 3. Environment & Execution Plane (`execution`)
    // ---------------------------------------------------------------------------
    {
      id: 'vibex.core.shell',
      packageName: '@vibex/core-shell',
      plane: 'execution',
      version: '2.0.0',
      artworkKey: 'coreShell',
      titleZh: 'Shell 终端与子进程执行器',
      titleEn: 'Shell & PTY Terminal Host',
      summaryZh:
        '提供跨平台持久化 PTY 终端池、PowerShell / Bash 命令执行器以及 Agent 后台长任务终端复用。',
      summaryEn:
        'Provides persistent cross-platform PTY terminals, Bash/PowerShell execution, and background process multiplexing.',
      provides: ['vibex.shell', 'vibex.terminal', 'vibex.subprocess'],
      injects: ['vibex.workspace-git'],
      parts: [
        {
          id: 'pty-session-manager',
          moduleName: 'PtyTerminalSessionPool',
          kind: 'service',
          titleZh: '持久化 PTY 终端会话池',
          titleEn: 'Persistent PTY Session Pool',
          summaryZh: '管理工作区多标签终端、工作目录继承与环境变量注入。',
          summaryEn:
            'Manages multi-tab PTY sessions with working directory and env inheritance.',
        },
        {
          id: 'ui-terminal-dock-panel',
          moduleName: 'TerminalDockPanel',
          kind: 'ui-surface',
          titleZh: 'Xterm.js 终端停靠面板',
          titleEn: 'Xterm.js Terminal Dock Panel',
          summaryZh: '支持 WebGL 加速渲染、链接点击拦截与 Agent 实时输出流查看。',
          summaryEn:
            'WebGL-accelerated terminal view with link interception and live agent output.',
        },
      ],
    },
    {
      id: 'vibex.core.workspace-git',
      packageName: '@vibex/core-workspace-git',
      plane: 'execution',
      version: '2.0.0',
      artworkKey: 'coreWorkspaceGit',
      titleZh: '工作区与 Git 版本控制引擎',
      titleEn: 'Workspace & Git VCS Engine',
      summaryZh:
        '管理项目根目录、Git Worktree 并行分支隔离、实时文件变更集监控与统一 Diff 对比视图。',
      summaryEn:
        'Manages project workspaces, isolated Git worktrees, live change tracking, and side-by-side diff previews.',
      provides: ['vibex.workspace-git', 'vibex.worktree', 'vibex.diff-engine'],
      injects: ['vibex.filesystem'],
      parts: [
        {
          id: 'git-worktree-isolation',
          moduleName: 'GitWorktreeCoordinator',
          kind: 'service',
          titleZh: 'Git Worktree 隔离沙箱协调器',
          titleEn: 'Git Worktree Isolation Coordinator',
          summaryZh: '为并行任务自动创建独立 Worktree 分支并支持一键合并或清理。',
          summaryEn:
            'Creates isolated Git worktrees for parallel tasks with merge and cleanup flows.',
        },
        {
          id: 'workspace-changes-diff',
          moduleName: 'WorkspaceDiffViewer',
          kind: 'ui-surface',
          titleZh: '工作区变更集与 Diff 审查面板',
          titleEn: 'Workspace Changes & Diff Panel',
          summaryZh: '实时展示暂存/未暂存文件统计、行级 Diff 对比与提交历史。',
          summaryEn:
            'Displays staged/unstaged file stats, line-by-line diffs, and commit history.',
        },
      ],
    },
    {
      id: 'vibex.core.filesystem',
      packageName: '@vibex/core-filesystem',
      plane: 'execution',
      version: '2.0.0',
      artworkKey: 'coreFilesystem',
      titleZh: '本地文件系统与外部编辑器桥',
      titleEn: 'Filesystem & External Editor Bridge',
      summaryZh:
        '提供工作区文件树监听、@ 文件引用秒级检索、产物预览租约以及外部 IDE 一键跳转。',
      summaryEn:
        'Provides workspace file tree watching, `@` file reference indexing, artifact preview leases, and external IDE openers.',
      provides: ['vibex.filesystem', 'vibex.editor', 'provider.editor.opener'],
      injects: [],
      onActivate: (ctx) => {
        ensureHostProviderServicesRegistered();
        ctx.services.provide('vibex.editor', defaultEditorOpenerProviderService);
        ctx.services.provide(
          'provider.editor.opener',
          defaultEditorOpenerProviderService
        );
      },
      parts: [
        {
          id: 'fs-workspace-tree',
          moduleName: 'WorkspaceFileTreeService',
          kind: 'service',
          titleZh: '工作区文件树与 @ 引用索引',
          titleEn: 'Workspace File Tree & `@` Indexer',
          summaryZh: '实时监听目录变更并为输入框 @ 引用提供模糊匹配。',
          summaryEn:
            'Watches directory changes and indexes files for `@` composer references.',
        },
        {
          id: 'external-editor-opener',
          moduleName: 'EditorOpenerProviderService',
          kind: 'service',
          titleZh: '外部 IDE 与自定义编辑器打开器',
          titleEn: 'External IDE & Custom Editor Opener',
          summaryZh: '支持 VS Code、Cursor、Windsurf、Zed 及插件注册的自定义打开器。',
          summaryEn:
            'Opens projects and files at exact lines in VS Code, Cursor, Zed, or plugin editors.',
        },
      ],
    },
    {
      id: 'vibex.core.automation',
      packageName: '@vibex/core-automation',
      plane: 'execution',
      version: '2.0.0',
      artworkKey: 'coreAutomation',
      titleZh: '定时任务与自动化工作流引擎',
      titleEn: 'Scheduled Automation & Workflow Engine',
      summaryZh:
        '执行 Cron 定时对话轮次、后台周期巡检以及多步骤版本化 DAG 工作流自动化。',
      summaryEn:
        'Executes Cron-scheduled agent turns, recurring background jobs, and versioned multi-step DAG workflows.',
      provides: [
        'vibex.automation',
        'vibex.scheduler',
        'vibex.workflow-runner',
      ],
      injects: ['vibex.agent-runtime'],
      settingsPath: '/settings/automation',
      parts: [
        {
          id: 'cron-turn-scheduler',
          moduleName: 'AutomationCronScheduler',
          kind: 'service',
          titleZh: 'Cron 定时唤醒与轮次调度器',
          titleEn: 'Cron Wakeup & Turn Scheduler',
          summaryZh: '按 Cron 表达式在指定工作区自动发起 Agent 巡检或汇报任务。',
          summaryEn:
            'Triggers scheduled agent turns across workspaces using Cron expressions.',
        },
        {
          id: 'dag-workflow-runtime',
          moduleName: 'WorkflowRunEngine',
          kind: 'service',
          titleZh: '版本化 DAG 工作流状态机',
          titleEn: 'Versioned DAG Workflow Runner',
          summaryZh: '驱动多节点工作流执行、条件分支跳转与产物传递。',
          summaryEn:
            'Executes multi-node DAG workflows with conditional branching and artifact passing.',
        },
      ],
    },
    {
      id: 'vibex.core.channels',
      packageName: '@vibex/core-channels',
      plane: 'execution',
      version: '2.0.0',
      artworkKey: 'coreChannels',
      titleZh: '外部即时通讯渠道网关',
      titleEn: 'External Chat Channels Gateway',
      summaryZh:
        '将 Telegram Topic、微信 iLink 机器人与企业微信长连接双向桥接至本地 Agent 会话。',
      summaryEn:
        'Bridges Telegram Topics, WeChat iLink bots, and WeCom WebSocket channels bidirectionally to local agent sessions.',
      provides: ['vibex.channels', 'vibex.channel-router'],
      injects: ['vibex.agent-runtime', 'vibex.session'],
      settingsPath: '/settings/channels',
      parts: [
        {
          id: 'telegram-topic-adapter',
          moduleName: 'TelegramTopicChannel',
          kind: 'service',
          titleZh: 'Telegram Forum Topic 双向桥',
          titleEn: 'Telegram Forum Topic Bridge',
          summaryZh: '将每个群组话题映射为独立本地会话并实时流式同步回复。',
          summaryEn:
            'Maps Telegram forum topics to local conversations with streaming replies.',
        },
        {
          id: 'wechat-wecom-adapter',
          moduleName: 'WeChatWeComChannel',
          kind: 'service',
          titleZh: '微信 iLink 与企业微信机器人桥',
          titleEn: 'WeChat iLink & WeCom Bot Bridge',
          summaryZh: '支持移动端扫码接入、随时随地远程下发编码指令与审批。',
          summaryEn:
            'Enables mobile remote task dispatch and tool approval via WeChat and WeCom.',
        },
      ],
    },

    // ---------------------------------------------------------------------------
    // 4. Client WebUI Plane (`webui`)
    // ---------------------------------------------------------------------------
    {
      id: 'vibex.webui.layout',
      packageName: '@vibex/webui-layout',
      plane: 'webui',
      version: '2.0.0',
      artworkKey: 'webuiLayout',
      titleZh: 'WebUI 工作台与 Dockview 布局',
      titleEn: 'WebUI Workbench & Dockview Layout',
      summaryZh:
        '托管主窗口三栏布局、Dockview 多面板停靠容器、左右侧边栏、状态栏槽位与多窗口协调。',
      summaryEn:
        'Hosts the tri-pane workbench shell, Dockview panel container, left/right sidebars, status bar slots, and multi-window sync.',
      provides: ['vibex.webui.layout', 'vibex.webui.panels'],
      injects: ['vibex.settings'],
      onActivate: () => {
        registerBuiltinPanels();
      },
      parts: [
        {
          id: 'dockview-panel-host',
          moduleName: 'WorkbenchDockviewHost',
          kind: 'ui-surface',
          titleZh: 'Dockview 可拖拽多面板容器',
          titleEn: 'Dockview Multi-Panel Container',
          summaryZh: '将内置面板与插件面板统一挂载到左、中、右、底停靠区域。',
          summaryEn:
            'Mounts built-in and plugin panels across left, center, right, and bottom zones.',
        },
        {
          id: 'sidebar-rail-host',
          moduleName: 'RightPanelSidebar',
          kind: 'ui-surface',
          titleZh: '导航栏与右侧工具栏宿主',
          titleEn: 'Navigation Rail & Right Sidebar Host',
          summaryZh: '响应式订阅 panelRegistry 与 slotRegistry 动态渲染工具图标。',
          summaryEn:
            'Reactively renders sidebar and statusbar slots from plugin registries.',
        },
      ],
    },
    {
      id: 'vibex.webui.conversation',
      packageName: '@vibex/webui-conversation',
      plane: 'webui',
      version: '2.0.0',
      artworkKey: 'webuiConversation',
      titleZh: 'WebUI 对话流与富文本输入器',
      titleEn: 'WebUI Conversation & Composer',
      summaryZh:
        '渲染虚拟化对话时间线、Streamdown 代码高亮与图表管线、以及支持 @ / $ & 触发器的富文本输入框。',
      summaryEn:
        'Renders the virtualized conversation timeline, Streamdown/Shiki/Mermaid markdown pipeline, and `@`/`/`/`$`/`&` trigger composer.',
      provides: [
        'vibex.webui.conversation',
        'vibex.webui.composer',
        'vibex.webui.markdown',
      ],
      injects: ['vibex.agent-runtime', 'vibex.session'],
      parts: [
        {
          id: 'normalized-timeline-renderer',
          moduleName: 'NormalizedConversationView',
          kind: 'ui-surface',
          titleZh: '标准化对话时间线与工具卡片流',
          titleEn: 'Normalized Timeline & Tool Cards',
          summaryZh: '支持对话模式接管 (ConversationMode)、插件时间线卡片与右键菜单。',
          summaryEn:
            'Supports full conversation mode takeover, plugin timeline cards, and context menus.',
        },
        {
          id: 'composer-trigger-engine',
          moduleName: 'FollowUpComposer',
          kind: 'ui-surface',
          titleZh: '多模态触发器输入框 (@ / $ &)',
          titleEn: 'Multi-Trigger Composer (`@` `/` `$` `&`)',
          summaryZh: '聚合文件引用、斜杠技能、插件动作与多智能体委派自动补全。',
          summaryEn:
            'Unifies file references, slash commands, composer actions, and subagent mentions.',
        },
      ],
    },
    {
      id: 'vibex.webui.kanban',
      packageName: '@vibex/webui-kanban',
      plane: 'webui',
      version: '2.0.0',
      artworkKey: 'webuiKanban',
      titleZh: 'WebUI 看板矩阵与画布视图',
      titleEn: 'WebUI Kanban, Matrix & Canvas Views',
      summaryZh:
        '将多列任务看板、多会话并行矩阵、无限节点画布与用量仪表盘作为插件化视图注册到工作台。',
      summaryEn:
        'Registers multi-column Kanban boards, parallel session matrices, infinite canvas, and usage dashboards into the workbench.',
      provides: ['vibex.webui.kanban'],
      injects: ['vibex.webui.layout'],
      onActivate: () => {
        registerBuiltinKanbanViews();
      },
      parts: [
        {
          id: 'builtin-kanban-views',
          moduleName: 'KanbanViewCatalog',
          kind: 'ui-surface',
          titleZh: '看板、会话矩阵、画布与用量四合一视图',
          titleEn: 'Columns, Sessions, Canvas & Usage Views',
          summaryZh: '通过 kanbanViewRegistry 动态组合内置视图与第三方扩展视图。',
          summaryEn:
            'Composes built-in board views and plugin Kanban views via kanbanViewRegistry.',
        },
      ],
    },
    {
      id: 'vibex.webui.commands',
      packageName: '@vibex/webui-commands',
      plane: 'webui',
      version: '2.0.0',
      artworkKey: 'webuiCommands',
      titleZh: 'WebUI 全局命令面板与快捷键',
      titleEn: 'WebUI Command Palette & Shortcuts',
      summaryZh:
        '提供 ⌘K 全局命令与文件搜索面板、多键序列追踪器以及插件命令统一分发。',
      summaryEn:
        'Provides the `⌘K` global command and file search palette, key sequence tracker, and plugin command dispatch.',
      provides: ['vibex.webui.commands', 'vibex.webui.shortcuts'],
      injects: ['vibex.webui.layout'],
      onActivate: () => {
        registerBuiltinCommands();
      },
      parts: [
        {
          id: 'search-command-palette',
          moduleName: 'SearchPalette',
          kind: 'command',
          titleZh: '⌘K 全局命令与文件搜索调色板',
          titleEn: '`⌘K` Global Command & File Palette',
          summaryZh: '实时检索内置操作、插件注册命令与工作区文件。',
          summaryEn:
            'Searches built-in actions, plugin commands, and workspace files.',
        },
        {
          id: 'sequence-keybinding-tracker',
          moduleName: 'SequenceTrackerProvider',
          kind: 'service',
          titleZh: '快捷键与多键序列调度器',
          titleEn: 'Keybinding & Sequence Tracker',
          summaryZh: '管理全局、工作区与看板作用域快捷键绑定。',
          summaryEn:
            'Manages scoped keyboard shortcuts and multi-key chord sequences.',
        },
      ],
    },
    {
      id: 'vibex.webui.theme',
      packageName: '@vibex/webui-theme',
      plane: 'webui',
      version: '2.0.0',
      artworkKey: 'webuiTheme',
      titleZh: 'WebUI 主题与视觉设计令牌',
      titleEn: 'WebUI Theme & Design Tokens',
      summaryZh:
        '管理 macOS Tahoe 双模式语义色彩令牌、动态强调色、UI 缩放与插件 CSS @layer 样式隔离。',
      summaryEn:
        'Manages macOS Tahoe dual-mode semantic color tokens, accent colors, UI zoom, and `@layer vibex-plugins` CSS isolation.',
      provides: ['vibex.webui.theme'],
      injects: ['vibex.settings'],
      settingsPath: '/settings/general',
      parts: [
        {
          id: 'tahoe-design-tokens',
          moduleName: 'ThemeProvider',
          kind: 'service',
          titleZh: 'Tahoe 双模式语义色彩引擎',
          titleEn: 'Tahoe Dual-Mode Token Engine',
          summaryZh: '驱动浅色/深色/跟随系统主题切换与插件自定义主题变量注入。',
          summaryEn:
            'Drives light/dark/system themes and reactive plugin theme CSS variables.',
        },
      ],
    },
  ];

const CORE_DESCRIPTOR_BY_ID = new Map<string, CoreFoundationPluginDescriptor>(
  CORE_FOUNDATION_PLUGIN_DESCRIPTORS.map((d) => [d.id, d])
);

export function getCoreFoundationPluginDescriptor(
  pluginId: string
): CoreFoundationPluginDescriptor | undefined {
  return CORE_DESCRIPTOR_BY_ID.get(pluginId);
}

function createCoreFoundationModule(
  descriptor: CoreFoundationPluginDescriptor
): VibexPluginModule {
  return {
    apiVersion: '2.0',
    id: descriptor.id,
    activate(ctx: VibeXPluginContext) {
      descriptor.onActivate?.(ctx);
      for (const serviceKey of descriptor.provides) {
        if (!serviceContainer.has(serviceKey)) {
          ctx.services.provide(serviceKey, {
            pluginId: descriptor.id,
            packageName: descriptor.packageName,
            serviceKey,
            plane: descriptor.plane,
            version: descriptor.version,
            active: true,
          });
        }
      }
    },
  };
}

let coreBootstrapped = false;

export async function bootstrapCoreFoundationPlugins(): Promise<string[]> {
  ensureHostProviderServicesRegistered();
  const activated: string[] = [];
  for (const descriptor of CORE_FOUNDATION_PLUGIN_DESCRIPTORS) {
    const mod = createCoreFoundationModule(descriptor);
    await pluginRuntimeLoader.activateModule(descriptor.id, mod, {
      spec: {
        id: descriptor.id,
        name: descriptor.titleEn,
        version: descriptor.version,
      },
    });
    activated.push(descriptor.id);
  }
  coreBootstrapped = true;
  return activated;
}

export function ensureCoreFoundationPluginsBootstrapped(): void {
  if (coreBootstrapped) return;
  coreBootstrapped = true;
  ensureHostProviderServicesRegistered();
  for (const descriptor of CORE_FOUNDATION_PLUGIN_DESCRIPTORS) {
    for (const serviceKey of descriptor.provides) {
      if (!serviceContainer.has(serviceKey)) {
        serviceContainer.provide(
          serviceKey,
          {
            pluginId: descriptor.id,
            packageName: descriptor.packageName,
            serviceKey,
            plane: descriptor.plane,
            version: descriptor.version,
            active: true,
          },
          descriptor.id
        );
      }
    }
    serviceContainer.provide(
      `plugin.active:${descriptor.id}`,
      { pluginId: descriptor.id, active: true },
      descriptor.id
    );
  }
}

export interface CorePluginRuntimeSnapshot {
  readonly descriptor: CoreFoundationPluginDescriptor;
  readonly active: boolean;
  readonly providedCount: number;
  readonly dependenciesSatisfied: boolean;
  readonly liveRegistrationCount: number;
}

export function getCoreFoundationInventory(): CorePluginRuntimeSnapshot[] {
  ensureCoreFoundationPluginsBootstrapped();
  return CORE_FOUNDATION_PLUGIN_DESCRIPTORS.map((descriptor) => {
    const providedCount = descriptor.provides.filter((key) =>
      serviceContainer.has(key)
    ).length;
    const dependenciesSatisfied = descriptor.injects.every((key) =>
      serviceContainer.has(key)
    );
    const active =
      providedCount > 0 ||
      serviceContainer.has(`plugin.active:${descriptor.id}`);

    let liveRegistrationCount = descriptor.parts.length;
    if (descriptor.id === 'vibex.webui.layout') {
      liveRegistrationCount = Math.max(
        descriptor.parts.length,
        panelRegistry.getAll().length
      );
    } else if (descriptor.id === 'vibex.webui.kanban') {
      liveRegistrationCount = Math.max(
        descriptor.parts.length,
        kanbanViewRegistry.getAll().length
      );
    } else if (descriptor.id === 'vibex.core.settings') {
      liveRegistrationCount = Math.max(
        descriptor.parts.length,
        settingsPageRegistry.getAll().length
      );
    } else if (descriptor.id === 'vibex.webui.commands') {
      liveRegistrationCount = Math.max(
        descriptor.parts.length,
        commandRegistry.getAll().length
      );
    } else if (descriptor.id === 'vibex.webui.conversation') {
      liveRegistrationCount =
        descriptor.parts.length +
        slashCommandRegistry.getAll().length +
        slotRegistry.getBySlot('composer.actions').length +
        viewRegistry.getAll().length;
    }

    return {
      descriptor,
      active,
      providedCount,
      dependenciesSatisfied,
      liveRegistrationCount,
    };
  });
}

export function useCoreFoundationInventory(): CorePluginRuntimeSnapshot[] {
  const [inventory, setInventory] = useState<CorePluginRuntimeSnapshot[]>(() =>
    getCoreFoundationInventory()
  );

  useEffect(() => {
    setInventory(getCoreFoundationInventory());
    return serviceContainer.subscribe(() => {
      setInventory(getCoreFoundationInventory());
    });
  }, []);

  return inventory;
}
