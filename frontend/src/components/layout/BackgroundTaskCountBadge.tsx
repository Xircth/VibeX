import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';

import { useWindowProjectsStore } from '@/stores/useWindowProjectsStore';

/**
 * Status-bar module (P3-5): count of in-flight (running) sessions across all
 * tracked projects, read from the already-populated project activity snapshots
 * (no extra data subscription). Renders nothing when idle.
 */
export function BackgroundTaskCountBadge() {
  const { t } = useTranslation('statusbar');
  const runningCount = useWindowProjectsStore((state) =>
    Object.values(state.projectSnapshots).reduce(
      (sum, snapshot) => sum + (snapshot.runningCount ?? 0),
      0
    )
  );

  if (runningCount <= 0) return null;

  return (
    <span
      title={t('backgroundTasksTitle', { count: runningCount })}
      className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/50 px-1.5 py-[1px] text-[10px] text-secondary-foreground"
    >
      <Loader2 className="h-3 w-3 animate-spin" />
      {runningCount}
    </span>
  );
}
