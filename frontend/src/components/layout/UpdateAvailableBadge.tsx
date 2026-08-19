import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { DownloadCloud } from 'lucide-react';

import { useUserSystem } from '@/components/ConfigProvider';
import {
  checkAppUpdate,
  readCachedAppUpdate,
  subscribeAppUpdate,
} from '@/lib/appUpdate';

/**
 * Status-bar badge for an available app update. Availability lives in the
 * shared check cache so this stays in sync with Settings without a second
 * unsigned GitHub poll.
 */
export function UpdateAvailableBadge() {
  const navigate = useNavigate();
  const { t } = useTranslation('statusbar');
  const { config } = useUserSystem();
  const [version, setVersion] = useState<string | null>(
    () => readCachedAppUpdate()?.update?.version ?? null
  );

  const refresh = useCallback(async (force = false) => {
    try {
      const snapshot = await checkAppUpdate({ force });
      setVersion(snapshot.update?.version ?? null);
    } catch {
      // No updater configured / release feed unavailable / offline — stay silent.
    }
  }, []);

  useEffect(
    () =>
      subscribeAppUpdate((snapshot) => {
        setVersion(snapshot.update?.version ?? null);
      }),
    []
  );

  useEffect(() => {
    if (config?.auto_update_enabled === false) return;
    void refresh(false);
  }, [config?.auto_update_enabled, refresh]);

  if (!version) return null;

  return (
    <button
      type="button"
      title={t('updateAvailableTitle')}
      className="inline-flex items-center gap-1 rounded-full px-1.5 text-[10px] text-primary hover:opacity-80"
      onClick={() => navigate('/settings/system')}
    >
      <DownloadCloud className="h-3 w-3" />
      {version}
    </button>
  );
}
