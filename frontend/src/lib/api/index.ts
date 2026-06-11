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

// Config, Settings, MCP, Profiles, Agent Settings, Queue, Settings Window
export {
  configApi,
  claudeSettingsApi,
  mcpServersApi,
  profilesApi,
  agentSettingsApi,
  settingsWindowApi,
  queueApi,
} from './config';
export type {
  ClaudeSettings,
  AgentSettingInfo,
  PreflightCheck,
  PreflightFix,
  PreflightResult,
  RunAgentFixRequest,
  OpencodeModelsResponse,
  AppReleaseStatus,
  RuntimeStatus,
  LocalToolStatus,
  SystemMaintenanceStatus,
  InstallSystemDependenciesResult,
  PromptEnhancementContextMessage,
  PromptEnhancementRequest,
  PromptEnhancementResponse,
} from './config';

// Misc: Execution Processes, File Tree, Desktop, File System, Tags, Images, Approvals, Scratch, Search, Skills
export {
  executionProcessesApi,
  fileTreeApi,
  desktopApi,
  fileSystemApi,
  tagsApi,
  imagesApi,
  approvalsApi,
  scratchApi,
  searchApi,
  skillsApi,
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

// Codex account quota
export { codexAccountApi } from './codexAccount';
export type {
  CodexAccountRateLimitsResponse,
  CodexCreditsSnapshot,
  CodexRateLimitSnapshot,
  CodexRateLimitWindow,
} from './codexAccount';

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
