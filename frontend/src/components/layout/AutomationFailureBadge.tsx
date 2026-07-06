import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';

import { automationApi } from '@/lib/api/automations';

const POLL_MS = 60_000;

/**
 * Status-bar badge (P3) surfacing unseen automation failures (backend counter
 * built in P0-3). Clicking opens the automations settings and clears the badge.
 */
export function AutomationFailureBadge() {
  const navigate = useNavigate();
  const { t } = useTranslation('statusbar');
  const [count, setCount] = useState(0);

  const refresh = useCallback(async () => {
    try {
      setCount(await automationApi.unseenFailures());
    } catch {
      // ignore — badge is best-effort
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  if (count <= 0) return null;

  return (
    <button
      type="button"
      title={t('automationFailureTitle')}
      className="inline-flex items-center gap-1 rounded-full px-1.5 text-[10px] text-destructive hover:opacity-80"
      onClick={() => {
        void automationApi.markSeen().finally(() => setCount(0));
        navigate('/settings/automations');
      }}
    >
      <AlertTriangle className="h-3 w-3" />
      {count}
    </button>
  );
}
