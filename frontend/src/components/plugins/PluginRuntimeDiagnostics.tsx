import { useQuery } from '@tanstack/react-query';
import { Activity, AlertTriangle, ScrollText } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { useBackendTransport } from '@/lib/transport';
import { createPluginControlApi } from '@/lib/api/plugins';

const POLL_MS = 4_000;
const LOG_TAIL = 200;

function clock(atUnixMs: number) {
  return new Date(atUnixMs).toLocaleTimeString();
}

/**
 * Runtime evidence for one installed plugin: whether its Worker is up, which
 * runtimes it still needs, why it last died, and what it printed.
 *
 * Only polls while the section is open. A plugin detail page that quietly
 * refetched for every installed package would cost more than it explains.
 */
export function PluginRuntimeDiagnostics({ pluginId }: { pluginId: string }) {
  const { t } = useTranslation('settings');
  const transport = useBackendTransport();
  const api = useMemo(() => createPluginControlApi(transport), [transport]);
  const [showLogs, setShowLogs] = useState(false);

  const { data, isPending } = useQuery({
    queryKey: ['plugin-diagnostics', pluginId],
    queryFn: () => api.diagnostics(pluginId),
    refetchInterval: POLL_MS,
  });

  const { data: logs } = useQuery({
    queryKey: ['plugin-logs', pluginId],
    queryFn: () => api.logs(pluginId),
    refetchInterval: POLL_MS,
    enabled: showLogs,
  });

  if (isPending || !data) return null;

  const stopped = data.workerExpected && !data.workerRunning;
  const tail = (logs ?? []).slice(-LOG_TAIL);

  return (
    <div className="plugin-detail-section">
      <h4>
        <Activity aria-hidden="true" />
        {t('plugins.diagnosticsTitle')}
      </h4>

      <ul className="plugin-contribution-list">
        <li>
          <span>{t('plugins.diagnosticsWorker')}</span>
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={
                stopped ? 'plugin-runtime-stopped' : 'plugin-runtime-ready'
              }
            >
              {data.workerRunning
                ? t('plugins.diagnosticsWorkerRunning')
                : data.workerExpected
                  ? t('plugins.diagnosticsWorkerStopped')
                  : t('plugins.diagnosticsWorkerNone')}
            </span>
            {data.generation !== null ? (
              <code>
                {t('plugins.diagnosticsGeneration', {
                  generation: data.generation,
                })}
              </code>
            ) : null}
          </div>
        </li>
      </ul>

      {data.missingRuntimes.length ? (
        <div className="plugin-warning-stack" role="status">
          <p>
            <AlertTriangle aria-hidden="true" />
            <span>
              {t('plugins.diagnosticsMissingRuntimes', {
                runtimes: data.missingRuntimes.join('、'),
              })}
            </span>
          </p>
        </div>
      ) : null}

      {data.recentCrashes.length ? (
        <div className="plugin-warning-stack" role="status">
          {data.recentCrashes
            .slice(-3)
            .reverse()
            .map((crash) => (
              <p key={`${crash.atUnixMs}:${crash.message}`}>
                <AlertTriangle aria-hidden="true" />
                <span>
                  {clock(crash.atUnixMs)} — {crash.message}
                </span>
              </p>
            ))}
        </div>
      ) : null}

      <Button
        size="sm"
        variant="outline"
        className="mt-2 gap-2"
        aria-expanded={showLogs}
        onClick={() => setShowLogs((current) => !current)}
      >
        <ScrollText aria-hidden="true" />
        {showLogs
          ? t('plugins.diagnosticsHideLogs')
          : t('plugins.diagnosticsShowLogs')}
      </Button>

      {showLogs ? (
        tail.length ? (
          <ol className="plugin-log-tail" aria-live="polite">
            {tail.map((line) => (
              <li key={line.seq} data-stream={line.stream}>
                <time>{clock(line.atUnixMs)}</time>
                <span>{line.text}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="plugin-detail-empty-copy">
            {t('plugins.diagnosticsNoLogs')}
          </p>
        )
      ) : null}
    </div>
  );
}
