
function errorSummary(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  if (
    cause &&
    typeof cause === 'object' &&
    'message' in cause &&
    typeof (cause as Record<string, unknown>).message === 'string'
  )
    return (cause as Record<string, string>).message;
  return String(cause);
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleAlert,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import type {
  AgentId,
  LocalHistoryImportJobSnapshot,
  LocalHistoryScanFolder,
  LocalHistoryScanProgress,
  LocalHistoryScanSession,
} from 'shared/types';
import { AgentTypeIcon } from '@/components/agents/AgentTypeIcon';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { agentsApi } from '@/features/agents/api';
import {
  folderImportableKeys,
  formatScanBytes,
  localHistorySessionKey,
} from '@/features/history-import/importLocalSessions';
import { backendListen } from '@/lib/backendTransport';
import {
  filterOnboardingHistory,
  groupOnboardingHistory,
  prepareOnboardingHistoryImport,
} from './onboardingHistory';
import type { OnboardingAgentOption } from './onboardingAgentModel';

const TIME_RANGES = [7, 30, 90] as const;

type ScanState = {
  completed: AgentId[];
  failed: AgentId[];
  progress: LocalHistoryScanProgress | null;
};

function agentLabel(
  agents: readonly OnboardingAgentOption[],
  id: string
): string {
  return agents.find((agent) => agent.agentId === id)?.displayName ?? id;
}

function sessionDate(
  session: LocalHistoryScanSession,
  locale: string
): string | null {
  if (!session.updated_at) return null;
  const parsed = Date.parse(session.updated_at);
  if (!Number.isFinite(parsed)) return null;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(
    new Date(parsed)
  );
}

export function OnboardingHistoryImport({
  sourceAgents,
  active = true,
  onBack,
  onFinish,
}: {
  sourceAgents: readonly OnboardingAgentOption[];
  /** Only the visible page owns the onboarding title anchor. */
  active?: boolean;
  onBack: () => void;
  /** Receives the registered/existing project IDs that should open next. */
  onFinish: (projectIds: string[]) => Promise<void>;
}) {
  const { t, i18n } = useTranslation(['dialogs', 'app']);
  const [phase, setPhase] = useState<
    'discovering' | 'sources' | 'scanning' | 'review'
  >('discovering');
  const [availableSources, setAvailableSources] = useState<AgentId[]>([]);
  const [selectedSources, setSelectedSources] = useState<Set<AgentId>>(
    () => new Set()
  );
  const [scanState, setScanState] = useState<ScanState & { active?: AgentId }>({
    completed: [],
    failed: [],
    progress: null,
  });
  const [folders, setFolders] = useState<LocalHistoryScanFolder[]>([]);
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(
    () => new Set()
  );
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    () => new Set()
  );
  const [timeRangeDays, setTimeRangeDays] = useState<number | null>(null);
  const [rangeNow] = useState(() => new Date());
  const [scanErrors, setScanErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<LocalHistoryImportJobSnapshot | null>(null);
  const [importRequested, setImportRequested] = useState(false);
  const mounted = useRef(false);
  const generation = useRef(0);
  const importInFlight = useRef(false);
  const jobEventEpoch = useRef(0);
  const discoveryRequest = useRef<Promise<string[]> | null>(null);
  const activeSourceIds = useRef<AgentId[]>([]);
  const preparedProjectIds = useRef<string[]>([]);
  const running = busy || job?.status === 'running';
  const visibleFolders = useMemo(
    () => filterOnboardingHistory(folders, timeRangeDays, rangeNow),
    [folders, timeRangeDays, rangeNow]
  );
  const visibleSelection = useMemo(
    () =>
      new Set(
        visibleFolders
          .flatMap(folderImportableKeys)
          .filter((key) => selectedSessions.has(key))
      ),
    [visibleFolders, selectedSessions]
  );
  const scannedSessionCount = folders.reduce(
    (total, folder) => total + folderImportableKeys(folder).length,
    0
  );

  const scan = useCallback(async (ids: AgentId[]) => {
    const request = ++generation.current;
    activeSourceIds.current = ids;
    setPhase('scanning');
    setScanState({ completed: [], failed: [], progress: null });
    setScanErrors([]);
    setError(null);
    const found: LocalHistoryScanFolder[] = [];
    const errors: string[] = [];
    for (const id of ids) {
      if (!mounted.current || generation.current !== request) return;
      setScanState((current) => ({
        ...current,
        progress: null,
        active: id,
      }));
      try {
        const page = await agentsApi.scanLocalHistory(id, (progress) => {
          if (mounted.current && generation.current === request)
            setScanState((current) => ({ ...current, progress }));
        });
        found.push(
          ...page.folders.filter(
            (folder) => folderImportableKeys(folder).length > 0
          )
        );
      } catch (cause) {
        errors.push(
          `${agentLabel(sourceAgents, id)}: ${
            errorSummary(cause)
          }`
        );
        if (mounted.current && generation.current === request)
          setScanState((current) => ({
            ...current,
            failed: [...current.failed, id],
          }));
      }
      if (!mounted.current || generation.current !== request) return;
      setScanState((current) => ({
        ...current,
        completed: [...current.completed, id],
        active: undefined,
      }));
    }
    if (!mounted.current || generation.current !== request) return;
    const grouped = groupOnboardingHistory(found);
    setFolders(grouped);
    setSelectedSessions(new Set(grouped.flatMap(folderImportableKeys)));
    setExpandedFolders(
      new Set(
        grouped
          .filter((folder) => folderImportableKeys(folder).length > 1)
          .map((folder) => folder.path)
      )
    );
    setScanErrors(errors);
    setPhase('review');
  }, [sourceAgents]);

  const discover = useCallback(async () => {
    const request = ++generation.current;
    setPhase('discovering');
    setError(null);
    try {
      discoveryRequest.current ??= agentsApi.discoverLocalHistorySources();
      const ids = await discoveryRequest.current;
      if (!mounted.current || request !== generation.current) return;
      setAvailableSources(ids);
      setSelectedSources(new Set(ids));
      setPhase('sources');
    } catch (cause) {
      if (mounted.current && request === generation.current) {
        discoveryRequest.current = null;
        setError(errorSummary(cause));
        setPhase('sources');
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void discover();
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, [discover]);

  useEffect(() => {
    if (active) document.getElementById('onboarding-title')?.focus();
  }, [active, phase]);

  useEffect(() => {
    let active = true;
    let dispose: (() => void) | undefined;
    let epoch = 0;
    void (async () => {
      dispose = await backendListen<LocalHistoryImportJobSnapshot>(
        'local-history-import-progress',
        (next) => {
          epoch += 1;
          jobEventEpoch.current += 1;
          if (active) setJob(next);
        }
      );
      if (!active) {
        dispose();
        return;
      }
      const before = epoch;
      const snapshot = await agentsApi.localHistoryImportSnapshot();
      if (active && epoch === before && !importInFlight.current)
        setJob(snapshot);
    })().catch((cause) => {
      if (active) setError(errorSummary(cause));
    });
    return () => {
      active = false;
      dispose?.();
    };
  }, []);

  useEffect(() => {
    if (
      !importRequested ||
      !job ||
      job.status === 'running' ||
      job.status === 'idle'
    )
      return;
    setImportRequested(false);
    setBusy(true);
    void (async () => {
      const scans = await Promise.allSettled(
        activeSourceIds.current.map(async (id) => ({
          id,
          page: await agentsApi.scanLocalHistory(id),
        }))
      );
      if (!mounted.current) return;
      const fullyScanned = scans.every((result) => result.status === 'fulfilled');
      if (fullyScanned) {
        const remaining = scans.flatMap((result) =>
          result.status === 'fulfilled'
            ? result.value.page.folders.filter(
                (folder) => folderImportableKeys(folder).length > 0
              )
            : []
        );
        setFolders(groupOnboardingHistory(remaining));
        const keys = new Set(remaining.flatMap(folderImportableKeys));
        setSelectedSessions(
          (current) => new Set([...current].filter((key) => keys.has(key)))
        );
      }
      try {
        if (
          job.status === 'completed' &&
          job.result &&
          job.result.failed === 0 &&
          job.result.errors.length === 0
        )
          await onFinish(preparedProjectIds.current);
      } catch (cause) {
        if (mounted.current)
          setError(errorSummary(cause));
      } finally {
        importInFlight.current = false;
        if (mounted.current) setBusy(false);
      }
    })();
  }, [importRequested, job, onFinish]);

  const toggleSessions = (keys: string[], checked: boolean) =>
    setSelectedSessions((current) => {
      const next = new Set(current);
      for (const key of keys) {
        if (checked) next.add(key);
        else next.delete(key);
      }
      return next;
    });

  const toggleFolder = (path: string) =>
    setExpandedFolders((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const importHistory = async () => {
    if (importInFlight.current || running || !visibleSelection.size) return;
    importInFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await prepareOnboardingHistoryImport(
        visibleFolders,
        visibleSelection,
        {}
      );
      preparedProjectIds.current = result.projectIds;
      setJob(null);
      const before = jobEventEpoch.current;
      const snapshot = await agentsApi.startLocalHistoryImport(
        result.selections
      );
      if (jobEventEpoch.current === before) setJob(snapshot);
      setImportRequested(true);
      if (!result.selections.length) await onFinish(result.projectIds);
    } catch (cause) {
      setError(errorSummary(cause));
      importInFlight.current = false;
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const retryScan = () => {
    discoveryRequest.current = null;
    void (async () => {
      try {
        const ids = await agentsApi.discoverLocalHistorySources();
        if (!mounted.current) return;
        setAvailableSources(ids);
        setSelectedSources(new Set(ids));
        setPhase('sources');
      } catch (cause) {
        if (mounted.current)
          setError(errorSummary(cause));
      }
    })();
  };

  const heading =
    phase === 'discovering'
      ? 'detectingHistorySources'
      : phase === 'sources'
        ? 'historySourcesTitle'
        : phase === 'scanning'
          ? 'scanningHistory'
          : 'importTitle';
  const description =
    phase === 'discovering'
      ? 'detectingHistorySourcesDescription'
      : phase === 'sources'
        ? 'historySourcesDescription'
        : phase === 'scanning'
          ? 'scanDescription'
          : 'importDescription';

  return (
    <main className="onboarding-history-step" inert={running || undefined}>
      <header className="onboarding-page-heading">
        <h1 id={active ? 'onboarding-title' : undefined} tabIndex={-1}>
          {t(`onboarding.${heading}`)}
        </h1>
        <p>{t(`onboarding.${description}`)}</p>
      </header>
      <div className="onboarding-page-content">
        {error ? (
          <p className="onboarding-inline-error" role="alert">
            {error}
          </p>
        ) : null}

        {phase === 'discovering' ? (
          <div className="onboarding-history-wait" role="status">
            <span className="onboarding-history-pulse" aria-hidden="true" />
            <span>{t('onboarding.detectingHistorySources')}</span>
          </div>
        ) : null}

        {phase === 'sources' ? (
          <section className="onboarding-source-panel">
            {availableSources.length ? (
              <fieldset className="onboarding-source-list">
                <legend className="sr-only">
                  {t('onboarding.historySourcesTitle')}
                </legend>
                {availableSources.map((id) => (
                  <label key={id} className="onboarding-source-row">
                    <Checkbox
                      aria-label={agentLabel(sourceAgents, id)}
                      checked={selectedSources.has(id)}
                      onCheckedChange={(checked) =>
                        setSelectedSources((current) => {
                          const next = new Set(current);
                          if (checked) next.add(id);
                          else next.delete(id);
                          return next;
                        })
                      }
                    />
                    <AgentTypeIcon agentType={id} className="size-6" />
                    <span className="onboarding-source-name">
                      {agentLabel(sourceAgents, id)}
                    </span>
                  </label>
                ))}
              </fieldset>
            ) : (
              <p className="onboarding-history-empty" role="status">
                {t('onboarding.noHistorySources')}
              </p>
            )}
            {!availableSources.length ? (
              <div className="onboarding-history-empty-actions">
                <Button variant="outline" onClick={retryScan}>
                  <RefreshCw className="size-4" />
                  {t('onboarding.retry')}
                </Button>
              </div>
            ) : null}
          </section>
        ) : null}

        {phase === 'scanning' ? (
          <section
            className="onboarding-scan-panel"
            aria-label={t('onboarding.scanningHistory')}
          >
            <ol className="onboarding-scan-agents">
              {activeSourceIds.current.map((id) => {
                const failed = scanState.failed.includes(id);
                const complete = scanState.completed.includes(id);
                const active = id === scanState.active;
                return (
                  <li
                    key={id}
                    data-state={
                      failed
                        ? 'failed'
                        : complete
                          ? 'complete'
                          : active
                            ? 'active'
                            : 'waiting'
                    }
                  >
                    <span className="onboarding-scan-mark">
                      {failed ? (
                        <CircleAlert
                          aria-hidden="true"
                          className="size-4 text-destructive"
                        />
                      ) : complete ? (
                        <Check aria-hidden="true" className="size-4" />
                      ) : active ? (
                        <Loader2
                          aria-hidden="true"
                          className="size-4 motion-safe:animate-spin"
                        />
                      ) : (
                        <span className="onboarding-scan-pending" />
                      )}
                    </span>
                    <AgentTypeIcon agentType={id} className="size-6" />
                    <span className="onboarding-scan-name">
                      {agentLabel(sourceAgents, id)}
                    </span>
                    <span className="onboarding-scan-status">
                      {failed
                        ? t('onboarding.scanFailed')
                        : complete
                          ? t('onboarding.scanComplete')
                          : active
                            ? t('onboarding.scanningAgent')
                            : t('onboarding.scanWaiting')}
                    </span>
                    {active && scanState.progress ? (
                      <span className="onboarding-scan-count tabular-nums">
                        {t('onboarding.scanCount', {
                          count: scanState.progress.session_count,
                        })}
                        {' · '}
                        {formatScanBytes(scanState.progress.bytes_scanned)}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ol>
            <div className="onboarding-scan-track" aria-hidden="true">
              <span
                style={{
                  width: `${
                    (scanState.completed.length /
                      Math.max(1, activeSourceIds.current.length)) *
                    100
                  }%`,
                }}
              />
            </div>
            <p className="onboarding-scan-readout tabular-nums" role="status">
              {t('onboarding.scanAgentCount', {
                current: scanState.completed.length,
                total: activeSourceIds.current.length,
              })}
              {scanState.progress
                ? ` · ${t('onboarding.scanCount', {
                    count: scanState.progress.session_count,
                  })}`
                : ''}
            </p>
          </section>
        ) : null}

        {phase === 'review' ? (
          <>
            {scanErrors.length ? (
              <div className="onboarding-scan-warning" role="alert">
                <CircleAlert aria-hidden="true" className="size-4" />
                <div>
                  <p>{t('onboarding.scanIncomplete')}</p>
                  {scanErrors.map((message) => (
                    <p key={message} className="onboarding-scan-error-entry">
                      {message}
                    </p>
                  ))}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={running}
                  onClick={() => void scan(activeSourceIds.current)}
                >
                  {t('onboarding.retry')}
                </Button>
              </div>
            ) : null}
            <div className="onboarding-history-toolbar">
              <p className="onboarding-history-summary tabular-nums">
                {t('onboarding.historyFound', {
                  projects: folders.length,
                  sessions: scannedSessionCount,
                })}
              </p>
              <label className="onboarding-range-control">
                <span>{t('onboarding.historyTimeRange')}</span>
                <div
                  className="onboarding-range-choices"
                  role="radiogroup"
                  aria-label={t('onboarding.historyTimeRange')}
                >
                  <button
                    type="button"
                    role="radio"
                    aria-checked={timeRangeDays === null}
                    disabled={running}
                    onClick={() => setTimeRangeDays(null)}
                  >
                    {t('onboarding.historyAllTime')}
                  </button>
                  {TIME_RANGES.map((days) => (
                    <button
                      key={days}
                      type="button"
                      role="radio"
                      aria-checked={timeRangeDays === days}
                      disabled={running}
                      onClick={() => setTimeRangeDays(days)}
                    >
                      {t('onboarding.historyRecentDays', { count: days })}
                    </button>
                  ))}
                </div>
              </label>
            </div>
            {!visibleFolders.length ? (
              <p className="onboarding-history-empty" role="status">
                {t('onboarding.historyRangeEmpty')}
              </p>
            ) : (
              <ul className="onboarding-history-list">
                {visibleFolders.map((folder) => {
                  const keys = folderImportableKeys(folder);
                  const checkedCount = keys.filter((key) =>
                    selectedSessions.has(key)
                  ).length;
                  const mixed = checkedCount > 0 && checkedCount < keys.length;
                  const expanded = expandedFolders.has(folder.path);
                  const agents = [
                    ...new Set(folder.sessions.map((item) => item.agent_id)),
                  ];
                  return (
                    <li key={folder.path} className="onboarding-history-project">
                      <div className="onboarding-history-project-head">
                        <Checkbox
                          aria-label={folder.name}
                          checked={checkedCount === keys.length && keys.length > 0}
                          aria-checked={
                            mixed ? 'mixed' : checkedCount === keys.length
                          }
                          className={mixed ? 'onboarding-check-mixed' : undefined}
                          onCheckedChange={(value) =>
                            toggleSessions(keys, value === true)
                          }
                        />
                        <div className="onboarding-history-project-copy">
                          <strong>{folder.name}</strong>
                          <span
                            className="onboarding-history-project-path"
                            title={folder.path}
                          >
                            {folder.path || t('onboarding.noSourceDirectory')}
                          </span>
                          <span className="onboarding-history-project-meta">
                            {agents.map((id) => (
                              <span key={id} className="onboarding-agent-chip">
                                <AgentTypeIcon agentType={id} className="size-3.5" />
                                {agentLabel(sourceAgents, id)}
                              </span>
                            ))}
                            <span className="tabular-nums">
                              {t('onboarding.sessionCount', { count: keys.length })}
                            </span>
                          </span>
                        </div>
                        <button
                          type="button"
                          className="onboarding-history-expand"
                          aria-expanded={expanded}
                          onClick={() => toggleFolder(folder.path)}
                        >
                          {t(
                            expanded
                              ? 'onboarding.hideSessions'
                              : 'onboarding.reviewSessions'
                          )}
                        </button>
                      </div>
                      {expanded ? (
                        <ul className="onboarding-history-sessions">
                          {folder.sessions
                            .filter((session) => session.status === 'new')
                            .map((session) => {
                              const key = localHistorySessionKey(session);
                              const date = sessionDate(session, i18n.language);
                              return (
                                <li key={key}>
                                  <label className="onboarding-history-session">
                                    <Checkbox
                                      aria-label={
                                        session.title ||
                                        t('onboarding.untitledSession')
                                      }
                                      checked={selectedSessions.has(key)}
                                      onCheckedChange={(value) =>
                                        toggleSessions([key], value === true)
                                      }
                                    />
                                    <span className="onboarding-history-session-title">
                                      {session.title ||
                                        t('onboarding.untitledSession')}
                                    </span>
                                    <span className="onboarding-history-session-agent">
                                      <AgentTypeIcon
                                        agentType={session.agent_id}
                                        className="size-3.5"
                                      />
                                      {agentLabel(sourceAgents, session.agent_id)}
                                    </span>
                                    <time
                                      className="tabular-nums"
                                      dateTime={session.updated_at ?? undefined}
                                    >
                                      {date ?? t('onboarding.historyDateUnknown')}
                                    </time>
                                  </label>
                                </li>
                              );
                            })}
                        </ul>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
            {timeRangeDays !== null &&
            folders.some((folder) =>
              folder.sessions.some(
                (session) =>
                  !session.updated_at ||
                  !Number.isFinite(Date.parse(session.updated_at))
              )
            ) ? (
              <p className="onboarding-history-note">
                {t('onboarding.historyUnknownDates')}
              </p>
            ) : null}
            <p className="onboarding-history-note">
              {t('onboarding.importContinuity')}
            </p>
            {job && (importRequested || job.status === 'running' || job.result) ? (
              <div
                className="onboarding-import-progress"
                aria-live="polite"
              >
                <div className="onboarding-import-progress-head">
                  <span className="tabular-nums">
                    {job.status === 'running'
                      ? t('onboarding.importProgress', {
                          current: job.progress?.current ?? 0,
                          total: job.progress?.total ?? 0,
                        })
                      : job.result
                        ? t('onboarding.importResult', job.result)
                        : null}
                  </span>
                  {job.status === 'running' ? (
                    <Loader2
                      aria-hidden="true"
                      className="size-4 motion-safe:animate-spin"
                    />
                  ) : null}
                </div>
                {job.status === 'running' && job.progress?.title ? (
                  <p className="onboarding-import-title">{job.progress.title}</p>
                ) : null}
                {job.result?.errors.map((message, index) => (
                  <p
                    className="onboarding-scan-error-entry"
                    key={`${message}-${index}`}
                  >
                    {message}
                  </p>
                ))}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
      <footer className="onboarding-page-footer">
        <Button
          variant="ghost"
          disabled={running}
          onClick={() => {
            generation.current += 1;
            if (phase === 'review') setPhase('sources');
            else onBack();
          }}
        >
          <ArrowLeft className="size-4" />
          {t('onboarding.back')}
        </Button>
        <div className="onboarding-footer-actions">
          {phase === 'sources' ? (
            <button
              type="button"
              className="onboarding-skip-button"
              disabled={running}
              onClick={() => {
                generation.current += 1;
                void onFinish([]);
              }}
            >
              {t('onboarding.skipImport')}
            </button>
          ) : null}
          {phase === 'scanning' ? (
            <button
              type="button"
              className="onboarding-skip-button"
              onClick={() => {
                generation.current += 1;
                setPhase('sources');
              }}
            >
              {t('onboarding.cancelScan')}
            </button>
          ) : null}
          {phase === 'review' ? (
            <>
              <button
                type="button"
                className="onboarding-skip-button"
                disabled={running}
                onClick={() => {
                  importInFlight.current = false;
                  setBusy(false);
                  setJob(null);
                  void onFinish([]);
                }}
              >
                {t('onboarding.skipImport')}
              </button>
              <Button
                disabled={running}
                onClick={() =>
                  visibleSelection.size ? void importHistory() : void onFinish([])
                }
              >
                {running ? <Loader2 className="size-4 motion-safe:animate-spin" /> : null}
                {t(
                  visibleSelection.size
                    ? 'onboarding.importAndContinue'
                    : 'onboarding.next'
                )}
                <ArrowRight className="size-4" />
              </Button>
            </>
          ) : null}
          {phase === 'sources' && availableSources.length ? (
            <Button
              disabled={running || !selectedSources.size}
              onClick={() => void scan([...selectedSources])}
            >
              {t('onboarding.scanSelectedAgents')}
              <ArrowRight className="size-4" />
            </Button>
          ) : null}
        </div>
      </footer>
    </main>
  );
}
