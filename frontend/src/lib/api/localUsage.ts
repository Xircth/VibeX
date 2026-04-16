import { tauriInvoke } from './base';

// ============= Types =============

export interface ProjectUsageUsageData {
  input_tokens: number;
  output_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
}

export interface ProjectUsageDailyUsage {
  date: string;
  sessions: number;
  usage: ProjectUsageUsageData;
  cost: number;
  models_used: string[];
}

export interface ProjectUsageModelUsage {
  model: string;
  total_cost: number;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  session_count: number;
}

export interface ProjectUsageSessionSummary {
  session_id: string;
  timestamp: number;
  model: string;
  usage: ProjectUsageUsageData;
  cost: number;
  summary?: string | null;
  provider: string;
}

export interface ProjectUsageWeekData {
  sessions: number;
  cost: number;
  tokens: number;
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
  total_usage: ProjectUsageUsageData;
  estimated_cost: number;
  sessions: ProjectUsageSessionSummary[];
  daily_usage: ProjectUsageDailyUsage[];
  weekly_comparison: ProjectUsageWeeklyComparison;
  by_model: ProjectUsageModelUsage[];
  provider_status: ProjectUsageProviderStatus[];
  last_updated: number;
  pricing_notice?: string | null;
}

export interface GetProjectUsageStatisticsParams {
  scope: 'global' | 'project';
  projectId?: string;
  dateRange?: '7d' | '30d' | 'all';
}

// ============= API =============

export const localUsageApi = {
  async getProjectStatistics(
    params: GetProjectUsageStatisticsParams
  ): Promise<ProjectUsageStatistics> {
    const result = await tauriInvoke<ProjectUsageStatistics>(
      'get_project_usage_statistics',
      {
        scope: params.scope,
        projectId: params.projectId ?? null,
        dateRange: params.dateRange ?? '7d',
      }
    );
    return result;
  },
};
