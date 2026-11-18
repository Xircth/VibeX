import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderDown, Loader2 } from 'lucide-react';
import { useLocalHistoryImportJob } from '@/features/history-import/useLocalHistoryImportJob';
import {
  QUIET_HISTORY_IMPORT_EVENT,
  QUIET_HISTORY_IMPORT_HOLD_MS,
  clearQuietHistoryImport,
  noteQuietHistoryImportFinished,
  quietHistoryImportVisible,
  readQuietHistoryImport,
  type QuietHistoryImportRecord,
} from '@/features/history-import/quietHistoryImport';
import { cn } from '@/lib/utils';

function useQuietHistoryImportRecord(): QuietHistoryImportRecord | null {
  const [record, setRecord] = useState<QuietHistoryImportRecord | null>(() =>
    readQuietHistoryImport()
  );
  useEffect(() => {
    const sync = () => setRecord(readQuietHistoryImport());
    window.addEventListener(QUIET_HISTORY_IMPORT_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(QUIET_HISTORY_IMPORT_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  return record;
}

export function HistoryImportStatusButton() {
  const { t } = useTranslation('statusbar');
  const job = useLocalHistoryImportJob();
  const record = useQuietHistoryImportRecord();
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const visible = quietHistoryImportVisible(record, job.status, now);

  useEffect(() => {
    if (!record || record.completedAt != null) return;
    if (job.status === 'completed' || job.status === 'failed') {
      noteQuietHistoryImportFinished();
    }
  }, [job.status, record]);

  useEffect(() => {
    if (!record?.completedAt) return;
    const remaining =
      record.completedAt + QUIET_HISTORY_IMPORT_HOLD_MS - Date.now();
    if (remaining <= 0) {
      clearQuietHistoryImport();
      return;
    }
    const timer = window.setTimeout(() => {
      clearQuietHistoryImport();
      setNow(Date.now());
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [record]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!visible) return null;

  const progress = job.progress;
  const result = job.result;
  const running = job.status === 'running' || record?.completedAt == null;
  const total = progress?.total ?? 0;
  const current = progress?.current ?? 0;
  const percent =
    job.status === 'completed'
      ? 100
      : total > 0
        ? Math.min(100, Math.round((current / total) * 100))
        : 0;
  const counts = result ?? progress;
  const recent = job.log.slice(-6).reverse();

  return (
    <div ref={rootRef} className="relative flex h-5 items-center">
      {open ? (
        <div className="absolute bottom-full right-0 z-50 mb-2">
          <section
            id={panelId}
            role="region"
            aria-label={t('historyImport.title')}
            className="w-72 rounded-md border border-border bg-popover p-2.5 font-sans text-[13px] leading-5 text-popover-foreground shadow-none"
          >
            <div className="flex items-center justify-between gap-2">
              <p className="font-medium">{t('historyImport.title')}</p>
              <p className="tabular-nums text-muted-foreground">
                {running
                  ? total > 0
                    ? t('historyImport.running', { current, total })
                    : t('historyImport.preparing')
                  : job.status === 'failed'
                    ? t('historyImport.failed')
                    : t('historyImport.done')}
              </p>
            </div>
            <div
              className="mt-2 h-1 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={total || 1}
              aria-valuenow={current}
            >
              <div
                className="h-full bg-primary"
                style={{ width: `${percent}%` }}
              />
            </div>
            {progress?.title ? (
              <p className="mt-2 truncate text-muted-foreground">
                {t('historyImport.current', { title: progress.title })}
              </p>
            ) : null}
            {counts ? (
              <p className="mt-1 tabular-nums text-muted-foreground">
                {t('historyImport.counts', counts)}
              </p>
            ) : null}
            {recent.length ? (
              <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto">
                {recent.map((entry) => (
                  <li
                    key={`${entry.phase}-${entry.agent_id}-${entry.external_session_id}`}
                    className={cn(
                      'truncate',
                      entry.phase === 'failed' && 'text-destructive'
                    )}
                  >
                    {entry.title || entry.external_session_id}
                    {entry.error ? ` — ${entry.error}` : ''}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        </div>
      ) : null}
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={t('historyImport.open')}
        className="flex h-5 items-center gap-1 rounded-full border border-border/60 bg-background/50 px-1.5 text-foreground/85 outline-none transition-colors hover:border-border hover:bg-accent/70 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        onClick={() => setOpen((current) => !current)}
      >
        {running ? (
          <Loader2
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 motion-safe:animate-spin"
          />
        ) : (
          <FolderDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        )}
      </button>
    </div>
  );
}
