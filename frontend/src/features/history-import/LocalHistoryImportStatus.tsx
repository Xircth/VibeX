import { useTranslation } from 'react-i18next';
import type { LocalHistoryImportJobSnapshot } from 'shared/types';
import { Progress } from '@/components/ui/progress';
import {
  localHistoryImportLogTitle,
  localHistoryImportPercent,
  localHistoryImportTitle,
} from './importLocalSessions';

export function LocalHistoryImportStatus({
  job,
}: {
  job: LocalHistoryImportJobSnapshot;
}) {
  const { t } = useTranslation('tasks');
  if (job.status === 'idle') {
    return null;
  }

  const untitled = t('importSessions.untitled');
  const progress = job.progress;
  const percent = progress ? localHistoryImportPercent(progress) : 0;
  const sessionTitle = progress
    ? localHistoryImportTitle(progress, [], untitled)
    : null;
  const running = job.status === 'running';
  const stats = progress
    ? [
        progress.imported > 0
          ? t('importSessions.importingImportedOnly', {
              imported: progress.imported,
            })
          : null,
        progress.skipped > 0
          ? t('importSessions.importingSkippedOnly', {
              skipped: progress.skipped,
            })
          : null,
        progress.failed > 0
          ? t('importSessions.importingFailedOnly', {
              failed: progress.failed,
            })
          : null,
      ]
        .filter((part): part is string => Boolean(part))
        .join(' · ')
    : '';

  return (
    <div className="import-local-progress import-local-progress--embedded">
      <div className="import-local-progress__copy">
        <h3>
          {running
            ? t('importSessions.importingTitle')
            : t('importSessions.doneTitle')}
        </h3>
        {running && sessionTitle ? (
          <p className="import-local-progress__session">{sessionTitle}</p>
        ) : null}
      </div>
      {progress ? (
        <div className="import-local-progress__meter">
          <Progress
            className="import-local-progress__track"
            value={running ? percent : 100}
            aria-label={
              running
                ? t('importSessions.importingTitle')
                : t('importSessions.doneTitle')
            }
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={running ? percent : 100}
            aria-valuetext={t('importSessions.importingCount', {
              current: progress.current,
              total: progress.total,
            })}
          />
          <div className="import-local-progress__meta">
            <span className="import-local-progress__count">
              {t('importSessions.importingCount', {
                current: progress.current,
                total: progress.total,
              })}
            </span>
            {stats ? (
              <span className="import-local-progress__stats">{stats}</span>
            ) : null}
          </div>
        </div>
      ) : null}
      {job.log.length > 0 ? (
        <ol className="import-local-progress__log">
          {job.log.map((entry, index) => (
            <li key={`${entry.external_session_id}:${index}`}>
              {t(
                entry.phase === 'skipped'
                  ? 'importSessions.logSkipped'
                  : entry.phase === 'failed'
                    ? 'importSessions.logFailed'
                    : 'importSessions.logImported',
                {
                  title: localHistoryImportLogTitle(entry, untitled),
                }
              )}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
