import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { DownloadCloud } from 'lucide-react';

/**
 * Status-bar module (P3-5): surfaces an available app update (P1-6 updater feed).
 * Best-effort — update checks only run in packaged builds. Runtime failures are
 * swallowed so an unavailable release feed leaves the badge hidden.
 * Polls on a long interval to avoid hammering the release feed. Clicking opens the
 * system settings where AppUpdaterSection performs the download/install/relaunch.
 */
const POLL_MS = 60 * 60 * 1000; // 60 minutes

export function UpdateAvailableBadge() {
  const navigate = useNavigate();
  const { t } = useTranslation('statusbar');
  const [version, setVersion] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      // Lazy import so nothing touches the updater plugin at module load.
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check();
      setVersion(update?.version ?? null);
      // check() returns a Tauri Resource (backend rid); we only read the version
      // here (the actual download happens in AppUpdaterSection), so release it to
      // avoid leaking one resource-table entry on every poll.
      await update?.close();
    } catch {
      // No updater configured / release feed unavailable / offline — stay silent.
    }
  }, []);

  useEffect(() => {
    if (import.meta.env.DEV) return;

    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

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
