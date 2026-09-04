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

// Artifacts
export { artifactApi, createArtifactApi } from './artifacts';
export type { ArtifactPreviewLease, ArtifactRecordView } from './artifacts';

// Attempts / Workspaces
export { attemptsApi } from './attempts';

// Repos
export { repoApi } from './repos';

// Config, Settings, MCP, Profiles, Settings Window
export {
  configApi,
  claudeSettingsApi,
  mcpMarketApi,
  profilesApi,
  versionControlApi,
  worktreeSettingsApi,
  frontendPreferencesApi,
  systemSettingsApi,
  backupApi,
  webServiceApi,
  hostTunnelApi,
  hostClientApi,
  chatChannelApi,
} from './config';
export { settingsWindowApi } from './settingsWindow';
export type {
  ClaudeSettings,
  PromptEnhancementModelsResponse,
  AppReleaseStatus,
  VersionControlCliSettings,
  GitVersionStatus,
  GitHubCliStatus,
  VersionControlInstallResult,
  ProjectWorktreeSettings,
  WorktreeCleanupStatus,
  FrontendPreferences,
  SystemProxySettings,
  ProxyMode,
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
  AdvertisedListenAddress,
  HostTunnelStatus,
  SavedHostTunnel,
  TunnelCheckResult,
  HostPairingChallenge,
  HostPairedDevice,
  HostClientProfile,
  DiscoveredHost,
  HostClientStatus,
  ConnectHostResult,
  PortProbeResult,
  ChatChannel,
  ChatChannelStatus,
  ChatChannelPayload,
  ChatEventFilter,
  ChatCommandPrefix,
  ChatChannelTestResult,
  AgentCapability,
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
  LogLevel,
  LogRecord,
  LogSettings,
  LogSettingsView,
  TargetDirective,
  FileTreeEntry,
  DirectoryChildrenResponse,
  BinaryAssetResponse,
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
  ProjectUsageTokenCounts,
  ProjectUsageSourcedTokens,
  ProjectUsageDailyUsage,
  ProjectUsageModelUsage,
  ProjectUsageFolderUsage,
  ProjectUsageAgentUsage,
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
} from '@/features/agents/api';
export type {
  AgentConnectionSnapshot,
  AgentEvent,
  AgentEventEnvelope,
  AgentPromptSnapshot,
  AgentRuntimeSnapshot,
  AgentSessionSnapshot,
  AgentType,
} from '@/features/agents/types';
