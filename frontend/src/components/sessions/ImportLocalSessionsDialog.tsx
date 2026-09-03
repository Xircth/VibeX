import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  FolderPlus,
  History,
  LoaderCircle,
  RefreshCw,
  Search,
  TriangleAlert,
  X,
} from 'lucide-react';
import type {
  LocalHistoryDestination,
  LocalHistoryImportProgress,
  LocalHistoryImportSelection,
  LocalHistoryScanFolder,
  LocalHistoryScanPage,
  LocalHistoryScanProgress,
} from 'shared/types';
import { AgentIcon, getAgentName } from '@/components/agents/AgentIcon';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { agentsApi } from '@/features/agents/api';
import { useSelectableAgents } from '@/features/agents/useSelectableAgents';
import { Progress } from '@/components/ui/progress';
import { useLocalHistoryImportJob } from '@/features/history-import/useLocalHistoryImportJob';
import {
  filterAndSortLocalHistoryFolders,
  folderImportableKeys,
  formatScanBytes,
  isImportableLocalHistorySession,
  localHistoryImportPercent,
  localHistoryImportTitle,
  localHistorySessionKey,
  parseTimeRangeDays,
  resolveFolderWorkspaceId,
  type LocalHistoryScanScope,
} from '@/features/history-import/importLocalSessions';
import { GLOBAL_PROJECT_SCOPE } from '@/lib/projectScope';
import { useLayoutStore } from '@/stores/useLayoutStore';

type ImportPhase =
  | 'idle'
  | 'scanning'
  | 'ready'
  | 'importing'
  | 'done'
  | 'error';

export function ImportLocalSessionsDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported?: (conversationIds: string[]) => void;
}) {
  const { t } = useTranslation('tasks');
  const selectableAgents = useSelectableAgents().filter(
    (agent) => agent.enabled
  );
  const currentProjectId = useLayoutStore((state) =>
    state.currentProjectKey === GLOBAL_PROJECT_SCOPE
      ? null
      : state.currentProjectKey
  );
  const [phase, setPhase] = useState<ImportPhase>('idle');
  const [selectedAgentId, setSelectedAgentId] = useState<string>('');
  const [scan, setScan] = useState<LocalHistoryScanPage | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [timeRange, setTimeRange] = useState('');
  const [scanScope, setScanScope] = useState<LocalHistoryScanScope>('existing');
  const [onlyImportable, setOnlyImportable] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [folderDestinations, setFolderDestinations] = useState<
    Record<string, string>
  >({});
  const [importResult, setImportResult] = useState<{
    imported: number;
    skipped: number;
    failed: number;
    conversation_ids: string[];
    errors: string[];
  } | null>(null);
  const importJob = useLocalHistoryImportJob();
  const notifiedImports = useState(() => new Set<string>())[0];
  const dialogWasOpen = useRef(false);
  const [scanProgress, setScanProgress] =
    useState<LocalHistoryScanProgress | null>(null);

  const runScan = async (agentId: string) => {
    if (!agentId) {
      setPhase('idle');
      setScan(null);
      return;
    }
    setPhase('scanning');
    setScanError(null);
    setScan(null);
    setScanProgress({ session_count: 0, bytes_scanned: 0n });
    setSelected(new Set());
    setFolderDestinations({});
    setImportResult(null);
    try {
      const page = await agentsApi.scanLocalHistory(agentId, setScanProgress);
      setScan(page);
      setCollapsed(new Set(page.folders.map((folder) => folder.path)));
      setPhase('ready');
    } catch (error) {
      setScanError(error instanceof Error ? error.message : String(error));
      setPhase('error');
    }
  };

  useEffect(() => {
    if (!open) {
      dialogWasOpen.current = false;
      return;
    }
    const justOpened = !dialogWasOpen.current;
    dialogWasOpen.current = true;
    if (!justOpened) {
      return;
    }
    if (importJob.status === 'running') {
      setPhase('importing');
      return;
    }
    setPhase('idle');
    setSelectedAgentId('');
    setScan(null);
    setScanError(null);
    setSearch('');
    setSearchOpen(false);
    setTimeRange('');
    setScanScope('existing');
    setSelected(new Set());
    setImportResult(null);
  }, [open, importJob.status, currentProjectId]);

  useEffect(() => {
    if (!open || selectableAgents.length !== 1 || selectedAgentId) {
      return;
    }
    const onlyAgent = selectableAgents[0]?.agentId;
    if (!onlyAgent) {
      return;
    }
    setSelectedAgentId(onlyAgent);
  }, [open, selectableAgents, selectedAgentId]);

  const filteredFolders = useMemo(() => {
    if (!scan) return [];
    return filterAndSortLocalHistoryFolders({
      folders: scan.folders,
      query: search,
      onlyImportable,
      timeRangeDays: parseTimeRangeDays(timeRange),
      scanScope,
      currentProjectId,
    });
  }, [scan, search, onlyImportable, timeRange, scanScope, currentProjectId]);

  const scannedSessions = useMemo(
    () => scan?.folders.flatMap((folder) => folder.sessions) ?? [],
    [scan]
  );

  const destinations = scan?.destinations ?? [];

  const workspaceForFolder = (folder: LocalHistoryScanFolder) =>
    resolveFolderWorkspaceId(folder, folderDestinations[folder.path]);

  const handleImport = async (background = false) => {
    if (importJob.status === 'running') {
      if (background) onOpenChange(false);
      return;
    }
    if (!scan || selected.size === 0) return;
    const selections: LocalHistoryImportSelection[] = [];
    for (const folder of scan.folders) {
      const workspaceId = workspaceForFolder(folder);
      if (!workspaceId) continue;
      for (const session of folder.sessions) {
        if (
          isImportableLocalHistorySession(session) &&
          selected.has(localHistorySessionKey(session))
        ) {
          selections.push({
            agent_id: session.agent_id,
            external_session_id: session.external_session_id,
            workspace_id: workspaceId,
          });
        }
      }
    }
    if (selections.length === 0) return;
    setPhase('importing');
    try {
      await agentsApi.startLocalHistoryImport(selections);
      if (background) onOpenChange(false);
    } catch (error) {
      setScanError(error instanceof Error ? error.message : String(error));
      setPhase('error');
    }
  };

  useEffect(() => {
    if (!open) return;
    if (importJob.status === 'running') {
      setPhase('importing');
      return;
    }
    if (phase !== 'importing') return;
    if (importJob.status === 'completed' || importJob.status === 'failed') {
      setImportResult(importJob.result);
      setPhase('done');
    }
  }, [importJob, open, phase]);

  useEffect(() => {
    for (const entry of importJob.log) {
      if (
        entry.phase === 'imported' &&
        entry.conversation_id &&
        !notifiedImports.has(entry.conversation_id)
      ) {
        notifiedImports.add(entry.conversation_id);
        onImported?.([entry.conversation_id]);
      }
    }
  }, [importJob.log, notifiedImports, onImported]);

  const busy = phase === 'importing' || importJob.status === 'running';
  const scanning = phase === 'scanning';
  const controlsDisabled = busy || scanning;
  const importProgress = importJob.progress;
  const allImportableKeys = filteredFolders.flatMap((folder) =>
    workspaceForFolder(folder) ? folderImportableKeys(folder) : []
  );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      className="max-w-3xl gap-0 overflow-hidden p-0"
    >
      <DialogHeader className="px-5 pb-2 pt-4 pr-12">
        <DialogTitle className="flex items-center gap-2">
          <History className="h-4 w-4 text-muted-foreground" />
          {t('importSessions.title')}
        </DialogTitle>
      </DialogHeader>
      <DialogContent className="min-h-0 gap-0">
        {phase === 'error' ? (
          <div className="flex h-[28rem] flex-col items-center justify-center gap-3 px-6">
            <TriangleAlert className="h-6 w-6 text-destructive" />
            <p className="text-sm font-medium">
              {t('importSessions.scanFailed')}
            </p>
            {scanError ? (
              <p className="max-w-md text-center text-xs text-muted-foreground">
                {scanError}
              </p>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              onClick={() => void runScan(selectedAgentId)}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {t('importSessions.retry')}
            </Button>
          </div>
        ) : null}

        {phase === 'done' && importResult ? (
          <div className="flex h-[28rem] flex-col items-center justify-center gap-4 px-6">
            {importResult.failed > 0 ? (
              <TriangleAlert className="h-7 w-7 text-destructive" />
            ) : (
              <CheckCircle2 className="h-7 w-7 text-[hsl(var(--success))]" />
            )}
            <p className="text-sm font-semibold">
              {t('importSessions.doneTitle')}
            </p>
            <div className="grid grid-cols-3 gap-8 text-center">
              <ResultStat
                label={t('importSessions.doneImported')}
                value={importResult.imported}
              />
              <ResultStat
                label={t('importSessions.doneSkipped')}
                value={importResult.skipped}
              />
              <ResultStat
                label={t('importSessions.doneFailed')}
                value={importResult.failed}
              />
            </div>
            {importResult.errors.length > 0 ? (
              <div className="max-h-24 w-full max-w-lg overflow-y-auto rounded-lg border border-destructive/40 bg-destructive/5 p-2">
                {importResult.errors.map((message) => (
                  <p key={message} className="text-xs text-destructive">
                    {message}
                  </p>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {phase === 'idle' ||
        phase === 'scanning' ||
        phase === 'ready' ||
        phase === 'importing' ? (
          <div className="flex h-[28rem] min-h-0 flex-col">
            {phase === 'importing' ? null : (
              <div className="flex flex-wrap items-center gap-2 px-5 pb-3">
                <Select
                  value={selectedAgentId}
                  onValueChange={(agentId) => {
                    setSelectedAgentId(agentId);
                    setScan(null);
                    setScanError(null);
                    setSelected(new Set());
                    if (phase !== 'idle') {
                      setPhase('idle');
                    }
                  }}
                  disabled={controlsDisabled}
                >
                  <SelectTrigger
                    className="h-8 w-44 text-xs"
                    aria-label={t('importSessions.chooseAgent')}
                  >
                    <SelectValue
                      placeholder={t('importSessions.chooseAgent')}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {selectableAgents.map((agent) => (
                      <SelectItem
                        key={agent.agentId}
                        value={agent.agentId}
                        className="text-xs"
                      >
                        {agent.displayName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="import-local-filters">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="import-local-filters__search-btn px-2"
                    aria-label={t('importSessions.search')}
                    aria-expanded={searchOpen}
                    disabled={controlsDisabled || phase !== 'ready'}
                    onClick={() => setSearchOpen((openSearch) => !openSearch)}
                  >
                    <Search className="h-3.5 w-3.5" />
                  </Button>
                  <div
                    className="import-local-filters__fields"
                    data-covered={searchOpen || undefined}
                    aria-hidden={searchOpen}
                  >
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          aria-label={t('importSessions.timeRange')}
                          disabled={controlsDisabled}
                          tabIndex={searchOpen ? -1 : undefined}
                        >
                          {t('importSessions.timeRange')}
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent align="start" className="w-auto p-2">
                        <label className="import-local-filters__time">
                          <Input
                            type="number"
                            min={1}
                            step={1}
                            inputMode="numeric"
                            value={timeRange}
                            onChange={(event) =>
                              setTimeRange(event.target.value)
                            }
                            placeholder={t(
                              'importSessions.timeRangePlaceholder'
                            )}
                            className="h-7 w-16 text-xs shadow-none focus-visible:ring-0"
                            aria-label={t('importSessions.timeRange')}
                            autoFocus
                          />
                          <span>{t('importSessions.timeRangeDays')}</span>
                        </label>
                      </PopoverContent>
                    </Popover>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          aria-label={t('importSessions.scanScope')}
                          disabled={controlsDisabled}
                          tabIndex={searchOpen ? -1 : undefined}
                        >
                          {t('importSessions.scanScope')}
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="start"
                        className="min-w-[16rem]"
                      >
                        <DropdownMenuRadioGroup
                          value={scanScope}
                          onValueChange={(value) =>
                            setScanScope(value as LocalHistoryScanScope)
                          }
                        >
                          <DropdownMenuRadioItem
                            value="existing"
                            className="items-start"
                          >
                            <span className="flex flex-col gap-0.5">
                              <span>
                                {t('importSessions.scanScopeExisting')}
                              </span>
                              <span className="text-[10px] leading-4 text-muted-foreground">
                                {t('importSessions.scanScopeExistingHint')}
                              </span>
                            </span>
                          </DropdownMenuRadioItem>
                          <DropdownMenuRadioItem
                            value="global"
                            className="items-start"
                          >
                            <span className="flex flex-col gap-0.5">
                              <span>{t('importSessions.scanScopeGlobal')}</span>
                              <span className="text-[10px] leading-4 text-muted-foreground">
                                {t('importSessions.scanScopeGlobalHint')}
                              </span>
                            </span>
                          </DropdownMenuRadioItem>
                        </DropdownMenuRadioGroup>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  {searchOpen ? (
                    <div className="import-local-filters__overlay">
                      <Input
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder={t('importSessions.searchPlaceholder')}
                        className="h-7 text-xs"
                        disabled={controlsDisabled || phase !== 'ready'}
                        autoFocus
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') {
                            event.preventDefault();
                            setSearchOpen(false);
                          }
                        }}
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="px-2"
                        aria-label={t('importSessions.closeSearch')}
                        onClick={() => setSearchOpen(false)}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ) : null}
                </div>
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Switch
                    checked={onlyImportable}
                    onCheckedChange={setOnlyImportable}
                    disabled={controlsDisabled}
                  />
                  {t('importSessions.onlyImportable')}
                </label>
                <div className="flex-1" />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={controlsDisabled || allImportableKeys.length === 0}
                  onClick={() => setSelected(new Set(allImportableKeys))}
                >
                  {t('importSessions.selectAll')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={controlsDisabled || !selectedAgentId}
                  onClick={() => void runScan(selectedAgentId)}
                >
                  {scanning ? (
                    <LoaderCircle className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                  ) : null}
                  {t('importSessions.startScan')}
                </Button>
              </div>
            )}

            <div className="min-h-0 flex-1">
              {phase === 'idle' ? (
                <EmptyState
                  title={
                    selectedAgentId
                      ? undefined
                      : t('importSessions.chooseAgent')
                  }
                />
              ) : phase === 'scanning' ? (
                <ScanLoadingPanel progress={scanProgress} />
              ) : phase === 'importing' ? (
                <ImportProgressPanel
                  progress={importProgress}
                  sessions={scannedSessions}
                />
              ) : !scan || scan.folders.length === 0 ? (
                <EmptyState title={t('importSessions.empty')} />
              ) : filteredFolders.length === 0 ? (
                <EmptyState title={t('importSessions.noMatches')} />
              ) : (
                <ScrollArea className="h-full">
                  <div className="space-y-2 px-5 pb-3">
                    {filteredFolders.map((folder) => {
                      const importable = folderImportableKeys(folder);
                      const selectedCount = importable.filter((key) =>
                        selected.has(key)
                      ).length;
                      const workspaceId = workspaceForFolder(folder);
                      const canSelect = Boolean(workspaceId);
                      return (
                        <div
                          key={folder.path || 'no-folder'}
                          className="overflow-hidden rounded-lg border border-border bg-[var(--surface-card-strong)]"
                        >
                          <FolderRow
                            folder={folder}
                            collapsed={collapsed.has(folder.path)}
                            selectedCount={selectedCount}
                            importableCount={importable.length}
                            disabled={busy || !canSelect}
                            destinations={destinations}
                            workspaceId={workspaceId}
                            onToggleCollapse={() => {
                              setCollapsed((current) => {
                                const next = new Set(current);
                                if (!next.delete(folder.path)) {
                                  next.add(folder.path);
                                }
                                return next;
                              });
                            }}
                            onToggleFolder={() => {
                              if (!canSelect || importable.length === 0) return;
                              setSelected((current) => {
                                const next = new Set(current);
                                const allSelected = importable.every((key) =>
                                  next.has(key)
                                );
                                if (allSelected) {
                                  importable.forEach((key) => next.delete(key));
                                } else {
                                  importable.forEach((key) => next.add(key));
                                }
                                return next;
                              });
                            }}
                            onDestinationChange={(nextWorkspaceId) => {
                              setFolderDestinations((current) => ({
                                ...current,
                                [folder.path]: nextWorkspaceId,
                              }));
                            }}
                          />
                          {!collapsed.has(folder.path)
                            ? folder.sessions.map((session) => {
                                const key = localHistorySessionKey(session);
                                const importableSession =
                                  isImportableLocalHistorySession(session);
                                return (
                                  <div
                                    key={key}
                                    className="flex min-h-10 items-center gap-2 px-3 py-1.5 pl-9"
                                  >
                                    <Checkbox
                                      checked={selected.has(key)}
                                      disabled={
                                        busy || !importableSession || !canSelect
                                      }
                                      onCheckedChange={() => {
                                        if (!importableSession || !canSelect) {
                                          return;
                                        }
                                        setSelected((current) => {
                                          const next = new Set(current);
                                          if (!next.delete(key)) next.add(key);
                                          return next;
                                        });
                                      }}
                                      aria-label={
                                        session.title?.trim() ||
                                        t('importSessions.untitled')
                                      }
                                    />
                                    <AgentIcon
                                      agent={session.agent_id}
                                      className="h-3.5 w-3.5 shrink-0"
                                    />
                                    <div className="min-w-0 flex-1">
                                      <p className="truncate text-xs font-medium text-foreground">
                                        {session.title?.trim() ||
                                          t('importSessions.untitled')}
                                      </p>
                                      <p className="text-[10px] leading-4 text-muted-foreground">
                                        {getAgentName(session.agent_id)}
                                        {importableSession
                                          ? null
                                          : ` · ${t('importSessions.alreadyImported')}`}
                                      </p>
                                    </div>
                                  </div>
                                );
                              })
                            : null}
                        </div>
                      );
                    })}
                  </div>
                </ScrollArea>
              )}
            </div>
          </div>
        ) : null}
      </DialogContent>
      <DialogFooter className="flex-row items-center justify-between gap-3 px-5 pb-4 pt-1 sm:justify-between">
        {phase === 'ready' && scan ? (
          <span className="text-xs text-muted-foreground">
            {t('importSessions.summaryCounts', {
              total: filteredFolders.reduce(
                (sum, folder) => sum + folder.sessions.length,
                0
              ),
              importable: filteredFolders.flatMap(folderImportableKeys).length,
            })}
          </span>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          {phase === 'done' ? (
            <>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void runScan(selectedAgentId)}
              >
                {t('importSessions.continueImport')}
              </Button>
              <Button size="sm" onClick={() => onOpenChange(false)}>
                {t('importSessions.close')}
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                {t('importSessions.close')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!busy && selected.size === 0}
                onClick={() => void handleImport(true)}
              >
                {t('importSessions.importInBackground')}
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={busy || selected.size === 0}
                onClick={() => void handleImport()}
              >
                {busy ? (
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
                {busy
                  ? t('importSessions.importing')
                  : t('importSessions.importSelected', {
                      count: selected.size,
                    })}
              </Button>
            </>
          )}
        </div>
      </DialogFooter>
    </Dialog>
  );
}

function ScanLoadingPanel({
  progress,
}: {
  progress: LocalHistoryScanProgress | null;
}) {
  const { t } = useTranslation('tasks');
  const sessionCount = progress?.session_count ?? 0;
  const bytes = progress?.bytes_scanned ?? 0n;
  return (
    <div className="import-local-scan" role="status" aria-live="polite">
      <LoaderCircle className="import-local-scan__spinner h-7 w-7 animate-spin text-primary motion-reduce:animate-none" />
      <p className="import-local-scan__title">{t('importSessions.scanning')}</p>
      <p className="import-local-scan__stats">
        {t('importSessions.scanningStats', {
          count: sessionCount,
          size: formatScanBytes(bytes),
        })}
      </p>
    </div>
  );
}

function ImportProgressPanel({
  progress,
  sessions = [],
}: {
  progress?: LocalHistoryImportProgress | null;
  sessions?: LocalHistoryScanPage['folders'][number]['sessions'];
}) {
  const { t } = useTranslation('tasks');
  const untitled = t('importSessions.untitled');
  const sessionTitle = progress
    ? localHistoryImportTitle(progress, sessions, untitled)
    : null;
  const percent = progress ? localHistoryImportPercent(progress) : 0;
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
    <div
      className="import-local-progress"
      aria-live="polite"
      aria-atomic="false"
    >
      <div className="import-local-progress__copy">
        <h3>{t('importSessions.importingTitle')}</h3>
        {sessionTitle ? (
          <p
            key={progress?.external_session_id}
            className="import-local-progress__session"
          >
            {sessionTitle}
          </p>
        ) : null}
      </div>
      <div className="import-local-progress__meter">
        {progress ? (
          <Progress
            className="import-local-progress__track"
            value={percent}
            aria-label={t('importSessions.importingTitle')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-valuetext={t('importSessions.importingCount', {
              current: progress.current,
              total: progress.total,
            })}
          />
        ) : (
          <div
            className="import-local-progress__track"
            role="progressbar"
            aria-label={t('importSessions.importingTitle')}
          >
            <span className="import-local-progress__indeterminate" />
          </div>
        )}
        {progress ? (
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
        ) : null}
      </div>
    </div>
  );
}

function ResultStat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}

function EmptyState({ title, hint }: { title?: string; hint?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8">
      <FolderPlus className="h-6 w-6 text-muted-foreground" />
      {title ? <p className="text-sm font-medium">{title}</p> : null}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function FolderRow({
  folder,
  collapsed,
  selectedCount,
  importableCount,
  disabled,
  destinations,
  workspaceId,
  onToggleCollapse,
  onToggleFolder,
  onDestinationChange,
}: {
  folder: LocalHistoryScanFolder;
  collapsed: boolean;
  selectedCount: number;
  importableCount: number;
  disabled: boolean;
  destinations: LocalHistoryDestination[];
  workspaceId: string | null;
  onToggleCollapse: () => void;
  onToggleFolder: () => void;
  onDestinationChange: (workspaceId: string) => void;
}) {
  const { t } = useTranslation('tasks');
  const unmatched = !folder.workspace_id;
  return (
    <div className="flex min-h-11 items-center gap-2 bg-[var(--surface-card-strong)] px-3 py-1.5">
      <button
        type="button"
        className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--surface-control-hover)] hover:text-foreground"
        onClick={onToggleCollapse}
        aria-label={
          collapsed ? t('importSessions.expand') : t('importSessions.collapse')
        }
      >
        {collapsed ? (
          <ChevronRight className="h-3.5 w-3.5" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5" />
        )}
      </button>
      <Checkbox
        checked={importableCount > 0 && selectedCount === importableCount}
        disabled={disabled || importableCount === 0}
        onCheckedChange={onToggleFolder}
        aria-label={folder.name || t('importSessions.noFolder')}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-semibold text-foreground">
          {folder.name || t('importSessions.noFolder')}
        </p>
        <p className="truncate text-[10px] leading-4 text-muted-foreground">
          {folder.path || t('importSessions.unmatched')}
        </p>
      </div>
      {unmatched ? (
        destinations.length > 0 ? (
          <label className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {t('importSessions.importInto')}
            </span>
            <Select
              value={workspaceId ?? ''}
              onValueChange={onDestinationChange}
              disabled={disabled}
            >
              <SelectTrigger
                className="h-7 w-40 text-[11px]"
                aria-label={t('importSessions.importInto')}
              >
                <SelectValue placeholder={t('importSessions.chooseProject')} />
              </SelectTrigger>
              <SelectContent>
                {destinations.map((destination) => (
                  <SelectItem
                    key={destination.workspace_id}
                    value={destination.workspace_id}
                    className="text-xs"
                  >
                    {destination.project_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        ) : (
          <span className="text-[11px] text-muted-foreground">
            {t('importSessions.noProject')}
          </span>
        )
      ) : folder.project_name ? (
        <span className="max-w-[9rem] truncate text-[11px] text-muted-foreground">
          {folder.project_name}
        </span>
      ) : null}
    </div>
  );
}
