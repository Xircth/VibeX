// Unified API entry point
// All imports from '@/lib/api' continue to work via this re-export barrel

// Base types and utilities
export type {
  Ok,
  Err,
  Result,
  RebaseResult,
  PullResult,
  CommitGraphNode,
  CommitGraphResult,
  SessionSummary,
  SessionStatus,
} from './base';
export { invokeAsResult } from './base';

// Projects
export { projectsApi } from './projects';

// Tasks
export { tasksApi } from './tasks';

// Sessions
export { sessionsApi } from './sessions';

// Attempts / Workspaces
export { attemptsApi } from './attempts';

// Repos
export { repoApi } from './repos';

// Config, Settings, MCP, Profiles, Agent Settings, Settings Window
export {
  configApi,
  claudeSettingsApi,
  mcpServersApi,
  mcpMarketApi,
  profilesApi,
  agentSettingsApi,
  versionControlApi,
  systemSettingsApi,
  backupApi,
  webServiceApi,
  modelProviderApi,
  chatChannelApi,
  settingsWindowApi,
} from './config';
export type {
  ClaudeSettings,
  AgentSettingInfo,
  PreflightCheck,
  PreflightFix,
  PreflightResult,
  RunAgentFixRequest,
  AgentNativeFile,
  OpencodeModelsResponse,
  AppReleaseStatus,
  RuntimeStatus,
  LocalToolStatus,
  SystemMaintenanceStatus,
  InstallSystemDependenciesResult,
  VersionControlCliSettings,
  GitVersionStatus,
  GitHubCliStatus,
  SystemProxySettings,
  SystemRenderingSettings,
  BackupCreateOptions,
  BackupInspectOptions,
  BackupRestoreStagePayload,
  BackupManifest,
  BackupPreviewEntry,
  BackupPreview,
  BackupRestoreResult,
  WebServiceConfig,
  WebServerStatus,
  PortProbeResult,
  ModelProvider,
  ModelProviderPayload,
  ProviderModelsResult,
  ChatChannel,
  ChatChannelPayload,
  ChatEventFilter,
  ChatCommandPrefix,
  ChatChannelTestResult,
  AgentAvailabilityInfo,
  AgentCapability,
  AgentMcpConfig,
  GetMcpServerResponse,
  McpAppType,
  LocalMcpServer,
  McpMarketplaceProvider,
  McpMarketplaceItem,
  McpMarketplaceInstallParameter,
  McpMarketplaceInstallOption,
  McpMarketplaceServerDetail,
  PromptEnhancementContextMessage,
  PromptEnhancementRequest,
  PromptEnhancementResponse,
  UserSystemInfo,
} from './config';

// Misc: Execution Processes, File Tree, Desktop, File System, Tags, Images, Approvals, Scratch, Search, Skills
export {
  executionProcessesApi,
  fileTreeApi,
  desktopApi,
  fileSystemApi,
  tagsApi,
  instructionsApi,
  imagesApi,
  approvalsApi,
  scratchApi,
  searchApi,
  skillsApi,
  skillsMarketApi,
} from './misc';
export type {
  FileTreeEntry,
  DirectoryChildrenResponse,
  BinaryAssetResponse,
  DocumentPreviewResponse,
  ReadFileResponse,
  TextSearchMatch,
  TextSearchFileResult,
  TextSearchResponse,
  TextSearchOptions,
  AgentLocalSkill,
  AgentSkillScope,
  AgentSkillItem,
  AgentSkillLocation,
  AgentSkillsListResult,
  AgentSkillContent,
  LocalSkill,
  SkillMarketItem,
  LocalSkillContent,
  SkillMarketDetail,
  Instruction,
  CreateInstructionPayload,
  UpdateInstructionPayload,
} from './misc';

// Local Usage Statistics
export { localUsageApi } from './localUsage';
export type {
  ProjectUsageUsageData,
  ProjectUsageDailyUsage,
  ProjectUsageModelUsage,
  ProjectUsageSessionSummary,
  ProjectUsageWeekData,
  ProjectUsageTrends,
  ProjectUsageWeeklyComparison,
  ProjectUsageProviderStatus,
  ProjectUsageStatistics,
  GetProjectUsageStatisticsParams,
} from './localUsage';

// ACP-native agents
export { agentsApi } from '@/features/agents/api';
export type {
  AgentCancelPromptRequest,
  AgentConnectRequest,
  AgentNewSessionRequest,
  AgentSendPromptRequest,
  AgentSendWorkspacePromptRequest,
} from '@/features/agents/api';
export type {
  AgentConfigSurface,
  AgentConnectionSnapshot,
  AgentEvent,
  AgentEventEnvelope,
  AgentInstallPlan,
  AgentMcpSurface,
  AgentPromptSnapshot,
  AgentRegistryEntry,
  AgentRuntimeSnapshot,
  AgentSessionSnapshot,
  AgentSkillsSurface,
  AgentType,
} from '@/features/agents/types';
