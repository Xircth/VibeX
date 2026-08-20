import { useEffect, useMemo, useState } from 'react';
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
  TriangleAlert,
} from 'lucide-react';
import type {
  LocalHistoryDestination,
  LocalHistoryImportSelection,
  LocalHistoryScanFolder,
  LocalHistoryScanPage,
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
import { Input } from '@/components/ui/input';
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
import {
  folderImportableKeys,
  isImportableLocalHistorySession,
  localHistorySessionKey,
  resolveFolderWorkspaceId,
} from '@/features/history-import/importLocalSessions';

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
  const [phase, setPhase] = useState<ImportPhase>('idle');
  const [selectedAgentId, setSelectedAgentId] = useState<string>('');
  const [scan, setScan] = useState<LocalHistoryScanPage | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
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

  const runScan = async (agentId: string) => {
    if (!agentId) {
      setPhase('idle');
      setScan(null);
      return;
    }
    setPhase('scanning');
    setScanError(null);
    setScan(null);
    setSelected(new Set());
    setFolderDestinations({});
    setImportResult(null);
    try {
      const page = await agentsApi.scanLocalHistory(agentId);
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
      return;
    }
    setPhase('idle');
    setSelectedAgentId('');
    setScan(null);
    setScanError(null);
    setSearch('');
    setSelected(new Set());
    setImportResult(null);
  }, [open]);

  useEffect(() => {
    if (!open || selectableAgents.length !== 1 || selectedAgentId) {
      return;
    }
    const onlyAgent = selectableAgents[0]?.agentId;
    if (!onlyAgent) {
      return;
    }
    setSelectedAgentId(onlyAgent);
    void runScan(onlyAgent);
  }, [open, selectableAgents, selectedAgentId]);

  const filteredFolders = useMemo(() => {
    if (!scan) return [];
    const query = search.trim().toLowerCase();
    return scan.folders.flatMap((folder) => {
      let sessions = folder.sessions;
      if (onlyImportable) {
        sessions = sessions.filter(isImportableLocalHistorySession);
      }
      if (query) {
        const folderMatches =
          folder.path.toLowerCase().includes(query) ||
          folder.name.toLowerCase().includes(query);
        if (!folderMatches) {
          sessions = sessions.filter((session) =>
            (session.title ?? '').toLowerCase().includes(query)
          );
        }
      }
      return sessions.length > 0 ? [{ ...folder, sessions }] : [];
    });
  }, [scan, search, onlyImportable]);

  const destinations = scan?.destinations ?? [];

  const workspaceForFolder = (folder: LocalHistoryScanFolder) =>
    resolveFolderWorkspaceId(folder, folderDestinations[folder.path]);

  const handleImport = async () => {
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
      const result = await agentsApi.importLocalHistoryBatch(selections);
      setImportResult(result);
      setPhase('done');
      if (result.imported > 0) {
        onImported?.(result.conversation_ids);
      }
    } catch (error) {
      setScanError(error instanceof Error ? error.message : String(error));
      setPhase('error');
    }
  };

  const busy = phase === 'importing';
  const allImportableKeys = filteredFolders.flatMap((folder) =>
    workspaceForFolder(folder) ? folderImportableKeys(folder) : []
  );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      uncloseable={busy}
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
            <div className="flex flex-wrap items-center gap-2 px-5 pb-3">
              <Select
                value={selectedAgentId}
                onValueChange={(agentId) => {
                  setSelectedAgentId(agentId);
                  void runScan(agentId);
                }}
                disabled={busy}
              >
                <SelectTrigger
                  className="h-8 w-44 text-xs"
                  aria-label={t('importSessions.chooseAgent')}
                >
                  <SelectValue placeholder={t('importSessions.chooseAgent')} />
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
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t('importSessions.searchPlaceholder')}
                className="h-8 w-52 text-xs"
                disabled={busy || phase !== 'ready'}
              />
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Switch
                  checked={onlyImportable}
                  onCheckedChange={setOnlyImportable}
                  disabled={busy}
                />
                {t('importSessions.onlyImportable')}
              </label>
              <div className="flex-1" />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-8 text-xs"
                disabled={busy || allImportableKeys.length === 0}
                onClick={() => setSelected(new Set(allImportableKeys))}
              >
                {t('importSessions.selectAll')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-8 text-xs"
                disabled={busy || !selectedAgentId}
                onClick={() => void runScan(selectedAgentId)}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                {t('importSessions.rescan')}
              </Button>
            </div>

            <div className="min-h-0 flex-1">
              {phase === 'idle' ? (
                <EmptyState title={t('importSessions.chooseAgent')} />
              ) : phase === 'scanning' ? (
                <div className="flex h-full flex-col items-center justify-center gap-3">
                  <LoaderCircle className="h-5 w-5 animate-spin text-muted-foreground motion-reduce:animate-none" />
                  <p className="text-sm font-medium">
                    {t('importSessions.scanning')}
                  </p>
                </div>
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
        {phase === 'ready' || phase === 'importing' ? (
          <span className="text-xs text-muted-foreground">
            {scan
              ? t('importSessions.summaryCounts', {
                  total: scan.total_sessions,
                  importable: scan.importable_count,
                })
              : null}
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
                disabled={busy}
                onClick={() => onOpenChange(false)}
              >
                {t('importSessions.close')}
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

function ResultStat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}

function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8">
      <FolderPlus className="h-6 w-6 text-muted-foreground" />
      <p className="text-sm font-medium">{title}</p>
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
