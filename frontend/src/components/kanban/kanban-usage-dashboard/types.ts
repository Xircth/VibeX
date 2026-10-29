import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { ProjectUsageTokenCounts } from '@/lib/api';

export type UsageTab =
  | 'overview'
  | 'folders'
  | 'agents'
  | 'models'
  | 'sessions'
  | 'plan';
export type DateRange = '7d' | '30d' | 'all';

export const SESSIONS_PER_PAGE = 15;
export const DATE_RANGE_OPTIONS: DateRange[] = ['7d', '30d', 'all'];
export const USAGE_STATS_STALE_TIME_MS = 2 * 60_000;
export const USAGE_STATS_GC_TIME_MS = 10 * 60_000;
export const HEATMAP_OPACITIES = [0.18, 0.29, 0.4, 0.52, 0.64, 0.76, 0.88];

export interface HeatmapHover {
  weekday: number;
  hour: number;
  value: number;
  x: number;
  y: number;
  width: number;
  height: number;
  containerWidth: number;
}

export interface ModelCostRates {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export const UNRESOLVED_MODEL_ALIASES = new Set([
  'opus',
  'fable',
  'sonnet',
  'haiku',
]);

export interface UsageHabitItem {
  id: string;
  icon: LucideIcon;
  label: string;
  value: ReactNode;
  valueTitle?: string;
  badge?: string;
}

export interface UsageRankingItem {
  id: string;
  label: string;
  cost?: number | null;
  totalTokens: number | null;
  sessionCount: number;
}

export interface DimensionSubBreakdown {
  dailyAvgTokens: number | null;
  activeDaysCount: number;
  totalCost: number | null;
  sessionCount: number;
  tokenCounts: ProjectUsageTokenCounts | null;
  topAgents: UsageRankingItem[];
  topModels: UsageRankingItem[];
  topFolders: UsageRankingItem[];
}
