export type SearchPerfBaselineConfig = {
  workspaceCount: number;
  filesPerWorkspace: number;
  threadsPerWorkspace: number;
  messagesPerThread: number;
  maxElapsedMs: number;
};

export const SEARCH_PERF_BASELINE_GLOBAL: SearchPerfBaselineConfig = {
  workspaceCount: 8,
  filesPerWorkspace: 1500,
  threadsPerWorkspace: 180,
  messagesPerThread: 16,
  maxElapsedMs: 1600,
};
