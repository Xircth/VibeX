import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  ArrowRight,
  FolderOpen,
  GitBranch,
  Globe,
  Loader2,
  Plus,
  RefreshCw,
} from 'lucide-react';
import type {
  AgentId,
  LocalHistoryImportJobSnapshot,
  LocalHistoryScanFolder,
  LocalHistoryScanProgress,
  Project,
} from 'shared/types';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ProjectFormDialog } from '@/components/dialogs/projects/ProjectFormDialog';
import { CloneRepoDialog } from '@/components/dialogs/projects/CloneRepoDialog';
import { agentsApi } from '@/features/agents/api';
import {
  folderImportableKeys,
  localHistorySessionKey,
} from '@/features/history-import/importLocalSessions';
import { projectsApi } from '@/lib/api/projects';
import { backendListen } from '@/lib/backendTransport';
import { orderImportedProjects } from '@/lib/importedProject';
import {
  onboardingHistoryPath,
  prepareOnboardingHistoryImport,
} from './onboardingHistory';

export function OnboardingProjects({
  sourceAgentIds,
  onBack,
  onFinish,
}: {
  sourceAgentIds: AgentId[];
  onBack: () => void;
  onFinish: (projectIds: string[]) => Promise<void>;
}) {
  const { t } = useTranslation(['dialogs', 'app']);
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<'scanning' | 'import' | 'projects'>(
    'scanning'
  );
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjects, setSelectedProjects] = useState<Set<string>>(
    new Set()
  );
  const [folders, setFolders] = useState<LocalHistoryScanFolder[]>([]);
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(
    new Set()
  );
  const [destinations, setDestinations] = useState<Record<string, string>>({});
  const [scanErrors, setScanErrors] = useState<string[]>([]);
  const [scanProgress, setScanProgress] =
    useState<LocalHistoryScanProgress | null>(null);
  const [scanAgent, setScanAgent] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<LocalHistoryImportJobSnapshot | null>(null);
  const [importRequested, setImportRequested] = useState(false);
  const [hasHistory, setHasHistory] = useState(false);
  const mounted = useRef(false);
  const startedSources = useRef<string | null>(null);
  const generation = useRef(0);
  const importInFlight = useRef(false);
  const jobEventEpoch = useRef(0);
  const initializedSelection = useRef(false);
  const running = busy || job?.status === 'running';
  const loadProjects = useCallback(async () => {
    const next = orderImportedProjects(
      (await projectsApi.getAll()).filter((project) => !project.hidden)
    );
    if (mounted.current) {
      setProjects(next);
      if (!initializedSelection.current)
        setSelectedProjects(
          (current) =>
            new Set([
              ...current,
              ...next
                .filter((project) => project.is_home)
                .map((project) => project.id),
            ])
        );
      initializedSelection.current = true;
    }
    return next;
  }, []);
  const scan = useCallback(async () => {
    const request = ++generation.current;
    setPhase('scanning');
    setScanErrors([]);
    setError(null);
    const found: LocalHistoryScanFolder[] = [];
    const errors: string[] = [];
    try {
      await loadProjects();
    } catch (cause) {
      if (mounted.current) setError(String(cause));
    }
    for (const id of sourceAgentIds) {
      if (!mounted.current || generation.current !== request) return;
      setScanAgent(id);
      setScanProgress(null);
      try {
        const page = await agentsApi.scanLocalHistory(id, (progress) => {
          if (mounted.current && generation.current === request)
            setScanProgress(progress);
        });
        found.push(
          ...page.folders.filter(
            (folder) => folderImportableKeys(folder).length > 0
          )
        );
      } catch (cause) {
        errors.push(`${id}: ${String(cause)}`);
      }
    }
    if (!mounted.current || generation.current !== request) return;
    setFolders(found);
    setSelectedSessions(new Set(found.flatMap(folderImportableKeys)));
    setScanErrors(errors);
    setHasHistory(found.length > 0 || errors.length > 0);
    setPhase(found.length > 0 || errors.length > 0 ? 'import' : 'projects');
  }, [loadProjects, sourceAgentIds]);
  useEffect(() => {
    mounted.current = true;
    const sources = sourceAgentIds.join('\0');
    if (startedSources.current !== sources) {
      startedSources.current = sources;
      void scan();
    }
    return () => {
      mounted.current = false;
    };
  }, [scan, sourceAgentIds]);
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
      if (active) setError(String(cause));
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
        sourceAgentIds.map((id) => agentsApi.scanLocalHistory(id))
      );
      if (!mounted.current) return;
      const remaining = scans.flatMap((result) =>
        result.status === 'fulfilled'
          ? result.value.folders.filter(
              (folder) => folderImportableKeys(folder).length > 0
            )
          : []
      );
      if (scans.every((result) => result.status === 'fulfilled')) {
        setFolders(remaining);
        const keys = new Set(remaining.flatMap(folderImportableKeys));
        setSelectedSessions(
          (current) => new Set([...current].filter((key) => keys.has(key)))
        );
      }
      try {
        await loadProjects();
        await queryClient.invalidateQueries({ queryKey: ['projects'] });
        if (
          mounted.current &&
          job.status === 'completed' &&
          job.result &&
          job.result.failed === 0 &&
          job.result.errors.length === 0
        )
          setPhase('projects');
      } catch (cause) {
        if (mounted.current) setError(String(cause));
      } finally {
        importInFlight.current = false;
        if (mounted.current) setBusy(false);
      }
    })();
  }, [importRequested, job, loadProjects, queryClient, sourceAgentIds]);
  const selectProject = (project: Project) => {
    setProjects((current) =>
      orderImportedProjects([
        ...current.filter((item) => item.id !== project.id),
        project,
      ])
    );
    setSelectedProjects((current) => new Set([...current, project.id]));
    void queryClient.invalidateQueries({ queryKey: ['projects'] });
  };
  const projectAction = async (action: 'open' | 'new' | 'clone') => {
    setError(null);
    setDialogOpen(true);
    try {
      if (action === 'clone') {
        const result = await CloneRepoDialog.show();
        if (result?.status === 'cloned') {
          const name = result.repo.display_name || result.repo.name;
          selectProject(
            await projectsApi.create({
              name,
              repositories: [
                { display_name: name, git_repo_path: result.repo.path },
              ],
            })
          );
        }
      } else {
        const result = await ProjectFormDialog.show({
          autoOpenFolderPicker: action === 'open',
        });
        if (result?.status === 'saved') selectProject(result.project);
      }
    } catch (cause) {
      setError(String(cause));
    } finally {
      setDialogOpen(false);
    }
  };
  const importHistory = async () => {
    if (importInFlight.current || running || !selectedSessions.size) return;
    importInFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await prepareOnboardingHistoryImport(
        folders,
        selectedSessions,
        destinations
      );
      setSelectedProjects(
        (current) => new Set([...current, ...result.projectIds])
      );
      await loadProjects();
      setJob(null);
      const before = jobEventEpoch.current;
      const snapshot = await agentsApi.startLocalHistoryImport(
        result.selections
      );
      if (jobEventEpoch.current === before) setJob(snapshot);
      setImportRequested(true);
    } catch (cause) {
      setError(String(cause));
      importInFlight.current = false;
      await loadProjects().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };
  const finish = async () => {
    setBusy(true);
    setError(null);
    try {
      await onFinish([...selectedProjects]);
    } catch (cause) {
      setError(String(cause));
      setBusy(false);
    }
  };
  const goToProjects = () => {
    generation.current += 1;
    setPhase('projects');
    void loadProjects().catch((cause) => setError(String(cause)));
  };
  const toggleSession = (keys: string[], checked: boolean) =>
    setSelectedSessions((current) => {
      const next = new Set(current);
      for (const key of keys) {
        if (checked) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  return (
    <main className="onboarding-projects-step" inert={dialogOpen}>
      <header className="onboarding-page-heading">
        <h1 id="onboarding-title" tabIndex={-1}>
          {t(
            phase === 'import'
              ? 'onboarding.importTitle'
              : 'onboarding.projectsTitle'
          )}
        </h1>
        <p>
          {t(
            phase === 'import'
              ? 'onboarding.importDescription'
              : 'onboarding.projectsDescription'
          )}
        </p>
      </header>
      <div className="onboarding-page-content">
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        {phase === 'scanning' ? (
          <div className="onboarding-scan-state" role="status">
            <Loader2 className="h-6 w-6 motion-safe:animate-spin" />
            <strong>{t('onboarding.scanningHistory')}</strong>
            <span>{scanAgent}</span>
            {scanProgress ? (
              <span className="tabular-nums">
                {t('onboarding.scanCount', {
                  count: scanProgress.session_count,
                })}
              </span>
            ) : null}
          </div>
        ) : null}
        {phase === 'import' ? (
          <>
            {scanErrors.length ? (
              <div role="alert" className="space-y-2 text-sm text-destructive">
                <p>{t('onboarding.scanIncomplete')}</p>
                {scanErrors.map((message) => (
                  <p key={message}>{message}</p>
                ))}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={running}
                  onClick={() => void scan()}
                >
                  <RefreshCw className="mr-2 h-4 w-4" />
                  {t('onboarding.retry')}
                </Button>
              </div>
            ) : null}
            <fieldset disabled={running} className="onboarding-history-list">
              {folders.map((folder, index) => {
                const keys = folderImportableKeys(folder);
                const checkedCount = keys.filter((key) =>
                  selectedSessions.has(key)
                ).length;
                return (
                  <article
                    key={`${folder.path}:${index}`}
                    className="onboarding-history-folder"
                  >
                    <div className="flex items-start gap-3">
                      <Checkbox
                        aria-label={folder.name}
                        checked={checkedCount === keys.length}
                        aria-checked={
                          checkedCount > 0 && checkedCount < keys.length
                            ? 'mixed'
                            : checkedCount === keys.length
                        }
                        onCheckedChange={(value) =>
                          toggleSession(keys, value === true)
                        }
                      />
                      <div className="min-w-0 flex-1">
                        <strong>{folder.name}</strong>
                        <p
                          className="truncate text-xs text-muted-foreground"
                          title={folder.path}
                        >
                          {folder.path || t('onboarding.noSourceDirectory')}
                        </p>
                      </div>
                      <span className="tabular-nums text-xs text-muted-foreground">
                        {t('onboarding.sessionCount', { count: keys.length })}
                      </span>
                    </div>
                    <details>
                      <summary>{t('onboarding.reviewSessions')}</summary>
                      <div className="space-y-2 py-2">
                        {folder.sessions
                          .filter((session) => session.status === 'new')
                          .map((session) => (
                            <label
                              key={localHistorySessionKey(session)}
                              className="flex items-center gap-2 text-sm"
                            >
                              <Checkbox
                                aria-label={
                                  session.title ||
                                  t('onboarding.untitledSession')
                                }
                                checked={selectedSessions.has(
                                  localHistorySessionKey(session)
                                )}
                                onCheckedChange={(value) =>
                                  toggleSession(
                                    [localHistorySessionKey(session)],
                                    value === true
                                  )
                                }
                              />
                              <span className="min-w-0 flex-1 truncate">
                                {session.title ||
                                  t('onboarding.untitledSession')}
                              </span>
                              <span className="text-xs text-muted-foreground">
                                {session.agent_id}
                              </span>
                            </label>
                          ))}
                      </div>
                    </details>
                    <label className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {t('onboarding.importDestination')}
                      <select
                        className="onboarding-destination-select"
                        value={
                          destinations[onboardingHistoryPath(folder.path)] ?? ''
                        }
                        onChange={(event) =>
                          setDestinations((current) => ({
                            ...current,
                            [onboardingHistoryPath(folder.path)]:
                              event.target.value,
                          }))
                        }
                      >
                        <option value="">
                          {folder.project_name ||
                            (folder.path
                              ? t('onboarding.createFromDirectory')
                              : t('onboarding.chooseDestination'))}
                        </option>
                        {projects.map((project) => (
                          <option key={project.id} value={project.id}>
                            {project.is_home
                              ? t('app:welcomePage.globalProject')
                              : project.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </article>
                );
              })}
            </fieldset>
            <p className="text-xs text-muted-foreground">
              {t('onboarding.importContinuity')}
            </p>
            {job &&
            (importRequested || job.status === 'running' || job.result) ? (
              <div className="space-y-2 text-sm" aria-live="polite">
                <p className="tabular-nums">
                  {job.status === 'running'
                    ? t('onboarding.importProgress', {
                        current: job.progress?.current ?? 0,
                        total: job.progress?.total ?? 0,
                      })
                    : job.result
                      ? t('onboarding.importResult', job.result)
                      : null}
                </p>
                {job.result?.errors.map((message, index) => (
                  <p className="text-destructive" key={index}>
                    {message}
                  </p>
                ))}
                {job.status === 'running' && job.progress?.title ? (
                  <p>{job.progress.title}</p>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}
        {phase === 'projects' ? (
          <>
            {hasHistory ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={running}
                onClick={() => setPhase('import')}
              >
                {t('onboarding.reviewImport')}
              </Button>
            ) : null}
            <div className="onboarding-project-list">
              {projects.map((project) => (
                <label key={project.id} className="onboarding-project-row">
                  <Checkbox
                    aria-label={
                      project.is_home
                        ? t('app:welcomePage.globalProject')
                        : project.name
                    }
                    checked={selectedProjects.has(project.id)}
                    onCheckedChange={(value) =>
                      setSelectedProjects((current) => {
                        const next = new Set(current);
                        if (value === true) next.add(project.id);
                        else next.delete(project.id);
                        return next;
                      })
                    }
                  />
                  <span className="onboarding-project-icon">
                    {project.is_home ? <Globe /> : <FolderOpen />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <strong>
                      {project.is_home
                        ? t('app:welcomePage.globalProject')
                        : project.name}
                    </strong>
                    <span className="block truncate text-xs text-muted-foreground">
                      {project.is_home
                        ? t('onboarding.globalDescription')
                        : project.root_path}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            {!projects.length ? (
              <Button
                variant="outline"
                onClick={() =>
                  void loadProjects().catch((cause) => setError(String(cause)))
                }
              >
                {t('onboarding.retry')}
              </Button>
            ) : null}
            <div className="onboarding-project-actions">
              {(['open', 'new', 'clone'] as const).map((action) => (
                <Button
                  variant="outline"
                  key={action}
                  disabled={running}
                  onClick={() => void projectAction(action)}
                >
                  {action === 'open' ? (
                    <FolderOpen className="mr-2 h-4 w-4" />
                  ) : action === 'new' ? (
                    <Plus className="mr-2 h-4 w-4" />
                  ) : (
                    <GitBranch className="mr-2 h-4 w-4" />
                  )}
                  {t(`onboarding.projectAction.${action}`)}
                </Button>
              ))}
            </div>
          </>
        ) : null}
      </div>
      <footer className="onboarding-page-footer">
        <Button variant="ghost" disabled={running} onClick={onBack}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t('onboarding.back')}
        </Button>
        <div className="flex flex-wrap justify-end gap-2">
          {phase !== 'projects' ? (
            <Button variant="ghost" disabled={running} onClick={goToProjects}>
              {t(
                phase === 'scanning'
                  ? 'onboarding.skipScan'
                  : 'onboarding.skipImport'
              )}
            </Button>
          ) : null}
          {phase === 'import' ? (
            <Button
              disabled={running}
              onClick={() =>
                selectedSessions.size ? void importHistory() : goToProjects()
              }
            >
              {running ? (
                <Loader2 className="mr-2 h-4 w-4 motion-safe:animate-spin" />
              ) : null}
              {t(
                selectedSessions.size
                  ? 'onboarding.importAndContinue'
                  : 'onboarding.next'
              )}
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          ) : phase === 'projects' ? (
            <Button
              disabled={running || selectedProjects.size === 0}
              onClick={() => void finish()}
            >
              {busy ? (
                <Loader2 className="mr-2 h-4 w-4 motion-safe:animate-spin" />
              ) : null}
              {t('onboarding.enterWorkspace')}
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          ) : null}
        </div>
      </footer>
    </main>
  );
}
