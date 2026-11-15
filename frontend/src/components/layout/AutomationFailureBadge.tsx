import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Activity, AlertTriangle } from 'lucide-react';

import { automationApi } from '@/lib/api/automations';
import { pulseApi } from '@/lib/api/pulse';

const POLL_MS = 60_000;

/**
 * Status-bar badge surfacing unseen automation failures and pending Pulse
 * Observe candidates. Clicking navigates to automations settings.
 */
export function AutomationFailureBadge() {
  const navigate = useNavigate();
  const { t } = useTranslation('statusbar');
  const [count, setCount] = useState(0);
  const [observeCount, setObserveCount] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const [failures, snapshot] = await Promise.all([
        automationApi.unseenFailures().catch(() => 0),
        pulseApi.deckSnapshot().catch(() => null),
      ]);
      setCount(failures);
      const pendingObserved = Array.isArray(snapshot?.observedCandidates)
        ? snapshot.observedCandidates.filter((candidate) => !candidate.promoted)
            .length
        : 0;
      setObserveCount(pendingObserved);
    } catch {
      // ignore — badge is best-effort
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  if (count <= 0 && observeCount <= 0) return null;

  return (
    <span className="inline-flex items-center gap-1">
      {observeCount > 0 ? (
        <button
          type="button"
          title={`Pulse Observe candidates (${observeCount})`}
          data-testid="pulse-observe-status-badge"
          className="inline-flex items-center gap-1 rounded-full px-1.5 text-[10px] text-muted-foreground tabular-nums transition-colors hover:text-foreground"
          onClick={() => {
            navigate('/settings/automations');
          }}
        >
          <Activity className="h-3 w-3 text-primary" />
          <span>{observeCount}</span>
        </button>
      ) : null}
      {count > 0 ? (
        <button
          type="button"
          title={t('automationFailureTitle')}
          data-testid="automation-failure-status-badge"
          className="inline-flex items-center gap-1 rounded-full px-1.5 text-[10px] text-destructive tabular-nums hover:opacity-80"
          onClick={() => {
            void automationApi.markSeen().finally(() => setCount(0));
            navigate('/settings/automations');
          }}
        >
          <AlertTriangle className="h-3 w-3" />
          {count}
        </button>
      ) : null}
    </span>
  );
}
