import { tauriInvoke } from './base';

export interface CodexRateLimitWindow {
  usedPercent: number | null;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface CodexCreditsSnapshot {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
}

export interface CodexRateLimitSnapshot {
  limitId: string | null;
  limitName: string | null;
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
  credits: CodexCreditsSnapshot | null;
  planType: string | null;
  rateLimitReachedType: string | null;
}

export interface CodexAccountRateLimitsResponse {
  rateLimits: CodexRateLimitSnapshot | null;
  rateLimitsByLimitId: Record<
    string,
    CodexRateLimitSnapshot | undefined
  > | null;
}

export const codexAccountApi = {
  getRateLimits(): Promise<CodexAccountRateLimitsResponse> {
    return tauriInvoke<CodexAccountRateLimitsResponse>(
      'get_codex_account_rate_limits'
    );
  },
};
