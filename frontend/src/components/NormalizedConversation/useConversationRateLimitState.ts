import { useCallback, useMemo, useState } from 'react';
import type { ConversationError, TimelineRow } from 'shared/types';
import { conversationApi } from '@/features/conversation/conversationApi';
import { formatAgentDisplayLabel } from '@/lib/providerInstancesApi';
import type { RateLimitIndicatorState } from './RateLimitRecoveryBanner';

function toIsoTimestamp(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const num = Number(trimmed);
      if (Number.isFinite(num) && num > 0) {
        const ms = num < 1e12 ? num * 1000 : num;
        return new Date(ms).toISOString();
      }
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  return null;
}

function readResetTimestamp(record: Record<string, unknown> | null | undefined): string | null {
  if (!record) return null;
  const primary =
    record.primary && typeof record.primary === 'object'
      ? (record.primary as Record<string, unknown>)
      : null;
  const secondary =
    record.secondary && typeof record.secondary === 'object'
      ? (record.secondary as Record<string, unknown>)
      : null;
  return toIsoTimestamp(
    record.resetAt ??
      record.reset_at ??
      record.resetsAt ??
      record.resets_at ??
      primary?.resetsAt ??
      primary?.resetAt ??
      secondary?.resetsAt ??
      secondary?.resetAt
  );
}

function isFullUtilization(value: unknown, isFractionScale: boolean): boolean {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  return isFractionScale
    ? (value >= 0.9999 && value <= 1.05) || value >= 100
    : value >= 100;
}

function isRecordRateLimited(nested: Record<string, unknown>): boolean {
  const explicit =
    nested.isRateLimited ?? nested.is_rate_limited ?? nested.active;
  if (typeof explicit === 'boolean') return explicit;
  const status =
    typeof nested.status === 'string'
      ? nested.status.trim().toLowerCase()
      : '';
  if (
    status === 'rejected' ||
    status === 'rate_limited' ||
    status === 'exceeded' ||
    status === 'limited'
  ) {
    return true;
  }
  const hasReset = Boolean(readResetTimestamp(nested));
  if (
    hasReset &&
    (nested.requestsRemaining === 0 ||
      nested.requests_remaining === 0 ||
      nested.tokensRemaining === 0 ||
      nested.tokens_remaining === 0)
  ) {
    return true;
  }
  if (
    hasReset &&
    (isFullUtilization(nested.utilization, true) ||
      isFullUtilization(nested.usedPercent ?? nested.used_percent, false))
  ) {
    return true;
  }
  for (const key of ['primary', 'secondary']) {
    const win = nested[key];
    if (win && typeof win === 'object' && isRecordRateLimited(win as Record<string, unknown>)) {
      return true;
    }
  }
  return false;
}

function parseExplicitRateLimitRecord(
  raw: unknown,
  fallbackEngine: string
): RateLimitIndicatorState | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  const nested =
    (rec.rateLimit as Record<string, unknown> | undefined) ??
    (rec.rate_limit as Record<string, unknown> | undefined) ??
    (rec.rateLimits as Record<string, unknown> | undefined) ??
    (rec.rate_limits as Record<string, unknown> | undefined) ??
    (rec.rateLimitState as Record<string, unknown> | undefined) ??
    (rec.rate_limit_state as Record<string, unknown> | undefined) ??
    rec;

  if (!isRecordRateLimited(nested)) return null;

  const limitedAt =
    toIsoTimestamp(nested.limitedAt ?? nested.limited_at) ??
    new Date().toISOString();
  const resetAt = readResetTimestamp(nested) ?? '';
  const countdownRaw = nested.countdownSeconds ?? nested.countdown_seconds;
  const countdownSeconds =
    typeof countdownRaw === 'number' && Number.isFinite(countdownRaw)
      ? countdownRaw
      : undefined;

  return {
    isRateLimited: true,
    engine:
      typeof nested.engine === 'string' && nested.engine.trim().length > 0
        ? nested.engine.trim()
        : fallbackEngine,
    limitedAt,
    resetAt,
    countdownSeconds,
    autoResume:
      typeof nested.autoResume === 'boolean'
        ? nested.autoResume
        : typeof nested.auto_resume === 'boolean'
          ? nested.auto_resume
          : true,
    continuationPrompt:
      typeof (nested.continuationPrompt ?? nested.continuation_prompt) ===
      'string'
        ? String(nested.continuationPrompt ?? nested.continuation_prompt)
        : undefined,
  };
}

export function deriveRateLimitIndicatorState(params: {
  engineLabel: string;
  sessionRecord?: unknown;
  sideRows: ReadonlyArray<TimelineRow>;
  latestTurnError: ConversationError | null;
  latestTurnErrorRowId?: string | null;
}): { key: string; state: RateLimitIndicatorState } | null {
  const {
    engineLabel,
    sessionRecord,
    sideRows,
    latestTurnError,
    latestTurnErrorRowId,
  } = params;

  const fromRecord = parseExplicitRateLimitRecord(sessionRecord, engineLabel);
  if (fromRecord) {
    return {
      key: `record:${fromRecord.limitedAt}:${fromRecord.resetAt}`,
      state: fromRecord,
    };
  }

  for (let idx = sideRows.length - 1; idx >= 0; idx -= 1) {
    const entry = sideRows[idx]!;
    if (entry.row.kind !== 'session_notice') continue;
    const notice = entry.row.notice;
    const announcementId = notice?.announcement_id ?? '';
    if (
      entry.row_id === 'notice:rate-limit' ||
      announcementId === 'rate_limit' ||
      announcementId.startsWith('rate_limit:') ||
      announcementId.startsWith('{')
    ) {
      let parsedAnnouncement: unknown = null;
      if (announcementId.startsWith('{')) {
        try {
          parsedAnnouncement = JSON.parse(announcementId);
        } catch {
          parsedAnnouncement = null;
        }
      }
      const fromNotice = parseExplicitRateLimitRecord(
        parsedAnnouncement,
        engineLabel
      );
      if (fromNotice) {
        return {
          key: `notice:${entry.row_id}:${fromNotice.resetAt || String(entry.revision)}`,
          state: fromNotice,
        };
      }
      if (
        entry.row_id === 'notice:rate-limit' ||
        announcementId === 'rate_limit' ||
        announcementId.startsWith('rate_limit:')
      ) {
        const inlineReset = announcementId.startsWith('rate_limit:')
          ? toIsoTimestamp(announcementId.slice('rate_limit:'.length))
          : null;
        return {
          key: `notice:${entry.row_id}:${inlineReset ?? String(entry.revision)}`,
          state: {
            isRateLimited: true,
            engine: engineLabel,
            limitedAt: new Date().toISOString(),
            resetAt: inlineReset ?? '',
            autoResume: true,
          },
        };
      }
    }
    const req = notice?.request_status;
    const retry = req?.activity.retry;
    if (req?.activity.phase !== 'retrying' || !retry) continue;
    const isRateLimitRetry =
      retry.code === 'rate_limited' ||
      retry.code === '429' ||
      /rate[\s_-]*limit|\b429\b/i.test(retry.reason ?? '');
    if (!isRateLimitRetry) continue;
    const delayMs = retry.delay_ms != null ? Number(retry.delay_ms) : 0;
    const sinceMs = Date.parse(req.since);
    const baseMs = Number.isFinite(sinceMs) ? sinceMs : Date.now();
    const resetAt =
      delayMs > 0 ? new Date(baseMs + delayMs).toISOString() : '';
    return {
      key: `retry:${entry.row_id}:${req.since}`,
      state: {
        isRateLimited: true,
        engine: engineLabel,
        limitedAt: new Date(baseMs).toISOString(),
        resetAt,
        countdownSeconds:
          delayMs > 0 ? Math.max(1, Math.ceil(delayMs / 1000)) : undefined,
        autoResume: true,
      },
    };
  }

  if (latestTurnError?.kind === 'rate_limited') {
    const rawRec =
      latestTurnError.raw && typeof latestTurnError.raw === 'object'
        ? (latestTurnError.raw as Record<string, unknown>)
        : null;
    const explicitFromRaw = parseExplicitRateLimitRecord(rawRec, engineLabel);
    if (explicitFromRaw) {
      return {
        key: `turn-error:${latestTurnErrorRowId ?? explicitFromRaw.resetAt}`,
        state: explicitFromRaw,
      };
    }
    const windowResetMs =
      latestTurnError.plan_usage?.windows.find((w) => w.resetsAtMs != null)
        ?.resetsAtMs ?? null;
    const resetAt =
      (windowResetMs != null ? toIsoTimestamp(windowResetMs) : null) ??
      readResetTimestamp(rawRec);
    const retrySecondsRaw =
      rawRec?.retry_after_seconds ?? rawRec?.retryAfterSeconds;
    const countdownSeconds =
      typeof retrySecondsRaw === 'number' && retrySecondsRaw > 0
        ? retrySecondsRaw
        : undefined;
    if (resetAt || countdownSeconds) {
      return {
        key: `turn-error:${latestTurnErrorRowId ?? resetAt ?? countdownSeconds}`,
        state: {
          isRateLimited: true,
          engine: engineLabel,
          limitedAt: new Date().toISOString(),
          resetAt: resetAt ?? '',
          countdownSeconds,
          autoResume: true,
        },
      };
    }
  }

  return null;
}

export function useConversationRateLimitState(params: {
  sessionId: string | null;
  agentId: string | null | undefined;
  sessionRecord?: unknown;
  sideRows: ReadonlyArray<TimelineRow>;
  latestTurnError: ConversationError | null;
  latestTurnErrorRowId?: string | null;
}) {
  const {
    sessionId,
    agentId,
    sessionRecord,
    sideRows,
    latestTurnError,
    latestTurnErrorRowId,
  } = params;
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  const engineLabel = useMemo(
    () => (agentId ? formatAgentDisplayLabel(agentId) : 'Agent'),
    [agentId]
  );

  const derived = useMemo(
    () =>
      sessionId
        ? deriveRateLimitIndicatorState({
            engineLabel,
            sessionRecord,
            sideRows,
            latestTurnError,
            latestTurnErrorRowId,
          })
        : null,
    [
      engineLabel,
      latestTurnError,
      latestTurnErrorRowId,
      sessionId,
      sessionRecord,
      sideRows,
    ]
  );

  const rateLimit =
    derived && derived.key !== dismissedKey ? derived.state : null;

  const handleUpdateAutoResume = useCallback(
    async (update: {
      conversationId: string;
      autoResume: boolean;
      continuationPrompt: string;
    }) => {
      await conversationApi.updateRateLimitAutoResume(update);
    },
    []
  );

  const handleCancelWait = useCallback(
    async (conversationId: string) => {
      await conversationApi.cancelRateLimitWait({ conversationId });
      if (derived) {
        setDismissedKey(derived.key);
      }
    },
    [derived]
  );

  return {
    rateLimit,
    handleUpdateAutoResume,
    handleCancelWait,
  };
}
