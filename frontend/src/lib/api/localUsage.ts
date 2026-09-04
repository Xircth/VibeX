import { backendCall } from './base';

export interface ProjectUsageTokenCounts {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_write_tokens?: number | null;
  cache_read_tokens?: number | null;
  total_tokens?: number | null;
}

export interface ProjectUsageSourcedTokens {
  protocol?: ProjectUsageTokenCounts | null;
  vendor_log?: ProjectUsageTokenCounts | null;
  sources_disagree: boolean;
}

export type ProjectUsageUsageData = ProjectUsageTokenCounts;

export interface ProjectUsageDailyUsage {
  date: string;
  sessions: number;
  tokens: ProjectUsageSourcedTokens;
  cost?: number | null;
  models_used: string[];
}

export interface ProjectUsageModelUsage {
  model: string;
  session_count: number;
  tokens: ProjectUsageSourcedTokens;
  cost?: number | null;
}

export interface ProjectUsageFolderUsage {
  workspace_id: string;
  folder?: string | null;
  session_count: number;
  tokens: ProjectUsageSourcedTokens;
  cost?: number | null;
}

export interface ProjectUsageAgentUsage {
  agent_id: string;
  session_count: number;
  tokens: ProjectUsageSourcedTokens;
  cost?: number | null;
}

export interface ProjectUsageSessionSummary {
  session_id: string;
  workspace_id: string;
  folder?: string | null;
  agent_id?: string | null;
  timestamp: number;
  model?: string | null;
  tokens: ProjectUsageSourcedTokens;
  context_used?: number | null;
  context_window_max?: number | null;
  cost?: number | null;
  summary?: string | null;
  external_session_id?: string | null;
}

export interface ProjectUsageWeekData {
  sessions: number;
  cost?: number | null;
  tokens?: number | null;
}

export interface ProjectUsageTrends {
  sessions: number;
  cost: number;
  tokens: number;
}

export interface ProjectUsageWeeklyComparison {
  current_week: ProjectUsageWeekData;
  last_week: ProjectUsageWeekData;
  trends: ProjectUsageTrends;
}

export interface ProjectUsageProviderStatus {
  provider: string;
  success: boolean;
  error?: string | null;
  sessions_scanned: number;
}

export interface ProjectUsageStatistics {
  scope: 'global' | 'project';
  project_id: string;
  project_name: string;
  total_sessions: number;
  total_tokens: ProjectUsageSourcedTokens;
  estimated_cost?: number | null;
  vendor_estimated_cost?: number | null;
  sessions: ProjectUsageSessionSummary[];
  daily_usage: ProjectUsageDailyUsage[];
  weekly_comparison: ProjectUsageWeeklyComparison;
  by_model: ProjectUsageModelUsage[];
  by_folder: ProjectUsageFolderUsage[];
  by_agent: ProjectUsageAgentUsage[];
  provider_status: ProjectUsageProviderStatus[];
  unattributed_vendor_sessions: number;
  last_updated: number;
  pricing_notice?: string | null;
}

export interface GetProjectUsageStatisticsParams {
  scope: 'global' | 'project';
  projectId?: string;
  dateRange?: '7d' | '30d' | 'all';
}

export const localUsageApi = {
  async getProjectStatistics(
    params: GetProjectUsageStatisticsParams
  ): Promise<ProjectUsageStatistics> {
    return backendCall<ProjectUsageStatistics>('get_project_usage_statistics', {
      scope: params.scope,
      projectId: params.projectId ?? null,
      dateRange: params.dateRange ?? '7d',
    });
  },
};
