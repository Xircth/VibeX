import { open } from '@tauri-apps/plugin-dialog';
import {
  AlertTriangle,
  Archive,
  ArrowLeft,
  Bot,
  CheckCircle2,
  ChevronRight,
  Command,
  Link2,
  Loader2,
  PackagePlus,
  RefreshCw,
  Puzzle,
  Search,
  ShieldAlert,
  TerminalSquare,
  Trash2,
} from 'lucide-react';
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { AstryxMarkdown } from '@/components/NormalizedConversation/AstryxMarkdown';
import { AgentTypeIcon } from '@/components/agents/AgentTypeIcon';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import type { BackendTransport } from '@/lib/backendTransport';
import {
  createPluginControlApi,
  type PluginCliImportEvent,
  type PluginCliImportResult,
  type PluginControlCatalog,
  type PluginControlContributions,
  type PluginControlItem,
  type PluginImportPackageKind,
  type PluginImportPreview,
  type PluginRuntimeConflict,
  type PluginRuntimeInventoryItem,
} from '@/lib/api/plugins';
import { cn } from '@/lib/utils';
import { useBackendTransport } from '@/lib/transport';
import { SettingsPageHeader, SettingsSection } from './SettingsUi';

const FORMAT_LABELS: Record<string, string> = {
  vibex: 'VibeX',
  codex: 'Codex',
  claude_code: 'Claude Code',
};

type PluginEcosystem = 'codex' | 'claude_code' | 'vibex';
type ImportEcosystem = 'codex' | 'claude_code' | 'vibex';

const PLUGIN_TABS: Array<{ id: PluginEcosystem; label: string }> = [
  { id: 'codex', label: 'Codex' },
  { id: 'claude_code', label: 'Claude Code' },
  { id: 'vibex', label: 'VibeX' },
];

const IMPORT_ECOSYSTEMS: Array<{ id: ImportEcosystem; label: string }> = [
  { id: 'codex', label: 'Codex' },
  { id: 'claude_code', label: 'Claude Code' },
  { id: 'vibex', label: 'VibeX' },
];

const PLUGIN_LIST_PANE_STORAGE_KEY = 'vibex.pluginHub.listPanePercent';
const PLUGIN_LIST_PANE_DEFAULT = 31;
const PLUGIN_LIST_PANE_MIN = 22;
const PLUGIN_LIST_PANE_MAX = 52;

function clampPluginListPane(value: number) {
  return Math.min(PLUGIN_LIST_PANE_MAX, Math.max(PLUGIN_LIST_PANE_MIN, value));
}

function initialPluginListPanePercent() {
  if (typeof window === 'undefined') return PLUGIN_LIST_PANE_DEFAULT;
  try {
    const stored = Number(
      window.localStorage.getItem(PLUGIN_LIST_PANE_STORAGE_KEY)
    );
    return Number.isFinite(stored) && stored > 0
      ? clampPluginListPane(stored)
      : PLUGIN_LIST_PANE_DEFAULT;
  } catch {
    return PLUGIN_LIST_PANE_DEFAULT;
  }
}

function pluginEcosystem(plugin: PluginControlItem): PluginEcosystem {
  if (plugin.sourceKind === 'codex_native') return 'codex';
  if (plugin.sourceKind === 'claude_code_native') return 'claude_code';
  return 'vibex';
}

function capabilityLabel(
  count: number,
  key: string,
  t: (key: string, params?: Record<string, unknown>) => string
) {
  return t(`plugins.capability.${key}`, { count });
}

type PluginDetailMode = 'overview' | 'skills' | 'mcp';

function CapabilityRail({
  plugin,
  mode,
  onSkillsClick,
  onMcpClick,
}: {
  plugin: PluginControlItem;
  mode: PluginDetailMode;
  onSkillsClick: () => void;
  onMcpClick: () => void;
}) {
  const { t } = useTranslation('settings');
  return (
    <div
      className="plugin-capability-rail"
      aria-label={t('plugins.capabilityAria')}
    >
      <button
        type="button"
        className={cn(mode === 'skills' && 'is-active')}
        aria-pressed={mode === 'skills'}
        disabled={plugin.skills.length === 0}
        onClick={onSkillsClick}
      >
        {capabilityLabel(plugin.skills.length, 'skills', t)}
      </button>
      <span>{capabilityLabel(plugin.runtimes.length, 'runtimes', t)}</span>
      <button
        type="button"
        className={cn(mode === 'mcp' && 'is-active')}
        aria-pressed={mode === 'mcp'}
        disabled={(plugin.mcpCount ?? 0) === 0}
        onClick={onMcpClick}
      >
        {capabilityLabel(plugin.mcpCount ?? 0, 'mcp', t)}
      </button>
      <span>
        {capabilityLabel(plugin.invocationCount ?? 0, 'invocations', t)}
      </span>
    </div>
  );
}

function PluginDetail({
  plugin,
  busy,
  onEnabledChange,
  onUpdate,
  onTrustChange,
  onInstallRuntime,
  onUninstall,
  loadContributions,
  runtimeInventory,
}: {
  plugin: PluginControlItem;
  busy: boolean;
  onEnabledChange: (enabled: boolean) => void;
  onUpdate: () => void;
  onTrustChange: (trusted: boolean) => void;
  onInstallRuntime: (runtimeId: string) => void;
  onUninstall: () => void;
  loadContributions: () => Promise<PluginControlContributions>;
  runtimeInventory: PluginRuntimeInventoryItem[];
}) {
  const { t } = useTranslation('settings');
  const [mode, setMode] = useState<PluginDetailMode>('overview');
  const [contributions, setContributions] =
    useState<PluginControlContributions | null>(null);
  const [contributionsLoading, setContributionsLoading] = useState(false);
  const [contributionsError, setContributionsError] = useState<string | null>(
    null
  );
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [selectedMcpId, setSelectedMcpId] = useState<string | null>(null);
  const hasShell = plugin.runtimes.some(
    (runtime) => runtime.installer === 'shell'
  );
  const openContributions = async (nextMode: PluginDetailMode) => {
    setMode(nextMode);
    if (contributions || contributionsLoading) return;
    setContributionsLoading(true);
    setContributionsError(null);
    try {
      const loaded = await loadContributions();
      setContributions(loaded);
      setSelectedSkillId(loaded.skills[0]?.id ?? null);
      setSelectedMcpId(loaded.mcpServers[0]?.id ?? null);
    } catch (cause) {
      setContributionsError(
        cause instanceof Error ? cause.message : String(cause)
      );
    } finally {
      setContributionsLoading(false);
    }
  };
  const selectedSkill =
    contributions?.skills.find((skill) => skill.id === selectedSkillId) ??
    contributions?.skills[0];
  const selectedMcp =
    contributions?.mcpServers.find((server) => server.id === selectedMcpId) ??
    contributions?.mcpServers[0];
  return (
    <section
      className="plugin-hub-detail"
      role="region"
      aria-label={plugin.name}
    >
      <header className="plugin-detail-header">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-base font-semibold text-foreground">
              {plugin.name}
            </h3>
            {plugin.formats.map((format) => (
              <span className="plugin-format-badge" key={format}>
                {FORMAT_LABELS[format] ?? format}
              </span>
            ))}
            <span className="plugin-version">v{plugin.version}</span>
            {plugin.builtin ? (
              <span className="plugin-format-badge">
                {t('plugins.builtinBadge')}
              </span>
            ) : null}
          </div>
          {plugin.description ? (
            <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
              {plugin.description}
            </p>
          ) : null}
        </div>
        {plugin.nativeManaged ? (
          <div className="flex shrink-0 items-center gap-2">
            {plugin.enableSupported ? (
              <>
                <span className="text-xs text-muted-foreground">
                  {plugin.enabled
                    ? t('plugins.enabled')
                    : t('plugins.disabled')}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => onEnabledChange(!plugin.enabled)}
                  aria-label={t(
                    plugin.enabled
                      ? 'plugins.disableNativeAria'
                      : 'plugins.enableNativeAria',
                    { name: plugin.name }
                  )}
                >
                  {plugin.enabled
                    ? t('plugins.disableNative')
                    : t('plugins.enableNative')}
                </Button>
              </>
            ) : null}
            {plugin.updateSupported ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={onUpdate}
                aria-label={t('plugins.updateNativeAria', {
                  name: plugin.name,
                })}
              >
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                {t('plugins.updateNative')}
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {plugin.enabled ? t('plugins.enabled') : t('plugins.disabled')}
            </span>
            <Switch
              checked={plugin.enabled}
              disabled={busy}
              onCheckedChange={onEnabledChange}
              aria-label={t('plugins.enabledAria', { name: plugin.name })}
            />
          </div>
        )}
      </header>

      <CapabilityRail
        plugin={plugin}
        mode={mode}
        onSkillsClick={() => void openContributions('skills')}
        onMcpClick={() => void openContributions('mcp')}
      />

      {mode === 'skills' ? (
        <section
          className="plugin-contribution-browser"
          role="region"
          aria-label={t('plugins.skillsRegionAria', { name: plugin.name })}
        >
          <header className="plugin-contribution-browser-header">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setMode('overview')}
            >
              <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
              {t('plugins.backToOverview')}
            </Button>
            <h4>{t('plugins.skillsViewTitle')}</h4>
          </header>
          {contributionsLoading ? (
            <div className="plugin-contribution-loading" role="status">
              <Loader2 className="animate-spin" aria-hidden="true" />
              {t('plugins.contributionsLoading')}
            </div>
          ) : contributionsError ? (
            <div className="plugin-hub-error" role="alert">
              <AlertTriangle aria-hidden="true" />
              <span>{contributionsError}</span>
            </div>
          ) : (
            <div className="plugin-contribution-browser-grid">
              <nav aria-label={t('plugins.skillListAria')}>
                {contributions?.skills.map((skill) => (
                  <button
                    key={skill.id}
                    type="button"
                    aria-label={skill.id}
                    className={cn(
                      selectedSkill?.id === skill.id && 'is-selected'
                    )}
                    onClick={() => setSelectedSkillId(skill.id)}
                  >
                    <strong>{skill.id}</strong>
                    <code>{skill.path}</code>
                  </button>
                ))}
              </nav>
              {selectedSkill ? (
                <article className="plugin-contribution-preview">
                  <div className="plugin-contribution-preview-path">
                    <code>{selectedSkill.path}</code>
                  </div>
                  <div className="plugin-skill-markdown">
                    <AstryxMarkdown value={selectedSkill.content} />
                  </div>
                </article>
              ) : null}
            </div>
          )}
        </section>
      ) : null}

      {mode === 'mcp' ? (
        <section
          className="plugin-contribution-browser"
          role="region"
          aria-label={t('plugins.mcpRegionAria', { name: plugin.name })}
        >
          <header className="plugin-contribution-browser-header">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setMode('overview')}
            >
              <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
              {t('plugins.backToOverview')}
            </Button>
            <h4>{t('plugins.mcpViewTitle')}</h4>
          </header>
          {contributionsLoading ? (
            <div className="plugin-contribution-loading" role="status">
              <Loader2 className="animate-spin" aria-hidden="true" />
              {t('plugins.contributionsLoading')}
            </div>
          ) : contributionsError ? (
            <div className="plugin-hub-error" role="alert">
              <AlertTriangle aria-hidden="true" />
              <span>{contributionsError}</span>
            </div>
          ) : (
            <div className="plugin-contribution-browser-grid">
              <nav aria-label={t('plugins.mcpListAria')}>
                {contributions?.mcpServers.map((server) => (
                  <button
                    key={server.id}
                    type="button"
                    aria-label={server.id}
                    className={cn(
                      selectedMcp?.id === server.id && 'is-selected'
                    )}
                    onClick={() => setSelectedMcpId(server.id)}
                  >
                    <strong>{server.id}</strong>
                  </button>
                ))}
              </nav>
              {selectedMcp ? (
                <article className="plugin-contribution-preview">
                  <pre className="plugin-mcp-json">
                    <code>{JSON.stringify(selectedMcp.config, null, 2)}</code>
                  </pre>
                </article>
              ) : null}
            </div>
          )}
        </section>
      ) : null}

      {mode === 'overview' ? (
        <>
          {plugin.warnings.length ? (
            <div className="plugin-warning-stack" role="status">
              {plugin.warnings.map((warning) => (
                <p key={`${warning.code}:${warning.contribution ?? ''}`}>
                  <AlertTriangle aria-hidden="true" />
                  <span>{warning.message}</span>
                </p>
              ))}
            </div>
          ) : null}

          {hasShell ? (
            <div className="plugin-trust-row">
              <ShieldAlert aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <strong>{t('plugins.shellTrustTitle')}</strong>
                <p>
                  {plugin.shellTrusted
                    ? t('plugins.shellTrusted')
                    : t('plugins.shellUntrusted')}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => onTrustChange(!plugin.shellTrusted)}
              >
                {plugin.shellTrusted
                  ? t('plugins.revokeTrust')
                  : t('plugins.reviewTrust')}
              </Button>
            </div>
          ) : null}

          <div className="plugin-overview-sections">
            <div className="plugin-detail-section">
              <h4>
                <Puzzle aria-hidden="true" />
                {t('plugins.skillsTitle')}
              </h4>
              <ul className="plugin-contribution-list">
                {plugin.skills.map((skill) => (
                  <li key={skill.id}>
                    <span>{skill.id}</span>
                    <code>{skill.path}</code>
                  </li>
                ))}
              </ul>
            </div>

            <div className="plugin-detail-section">
              <h4>
                <TerminalSquare aria-hidden="true" />
                {t('plugins.runtimeTitle')}
              </h4>
              {plugin.runtimes.length ? (
                <ul className="plugin-contribution-list">
                  {plugin.runtimes.map((runtime) => (
                    <li key={runtime.id}>
                      <span>
                        {runtime.id}
                        <small>{runtime.installer}</small>
                      </span>
                      <div className="flex min-w-0 items-center gap-2">
                        <code>{runtime.installCommand ?? runtime.command}</code>
                        {runtimeInventory.some(
                          (installed) =>
                            installed.id === runtime.id &&
                            (!runtime.version ||
                              installed.version === runtime.version)
                        ) ? (
                          <span className="plugin-runtime-ready">
                            {t('plugins.runtimeReady')}
                          </span>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() => onInstallRuntime(runtime.id)}
                            aria-label={t('plugins.installRuntimeAria', {
                              id: runtime.id,
                            })}
                          >
                            {t('plugins.installRuntime')}
                          </Button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="plugin-detail-empty-copy">
                  {t('plugins.noRuntime')}
                </p>
              )}
            </div>

            <div className="plugin-detail-section">
              <h4>
                <Bot aria-hidden="true" />
                {t('plugins.mcpTitle')}
              </h4>
              {plugin.mcpServers?.length ? (
                <ul className="plugin-contribution-list plugin-name-only-list">
                  {plugin.mcpServers.map((server) => (
                    <li key={server}>
                      <span>{server}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="plugin-detail-empty-copy">
                  {t(
                    (plugin.mcpCount ?? 0) > 0
                      ? 'plugins.mcpSummary'
                      : 'plugins.noMcp',
                    { count: plugin.mcpCount ?? 0 }
                  )}
                </p>
              )}
            </div>

            <div className="plugin-detail-section">
              <h4>
                <Command aria-hidden="true" />
                {t('plugins.invocationsTitle')}
              </h4>
              {plugin.invocations?.length ? (
                <ul className="plugin-contribution-list">
                  {plugin.invocations.map((invocation) => (
                    <li key={invocation.id}>
                      <span>{invocation.label}</span>
                      <code>{invocation.id}</code>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="plugin-detail-empty-copy">
                  {t('plugins.noInvocations')}
                </p>
              )}
            </div>

            <div className="plugin-detail-section">
              <h4>
                <Link2 aria-hidden="true" />
                {t('plugins.sourceTitle')}
              </h4>
              <ul className="plugin-contribution-list">
                <li>
                  <span>{t(`plugins.sourceKind.${plugin.sourceKind}`)}</span>
                  <code title={plugin.sourcePath}>{plugin.sourcePath}</code>
                </li>
              </ul>
            </div>
          </div>

          {!plugin.builtin && plugin.uninstallSupported !== false ? (
            <div className="flex justify-end border-t border-border/70 pt-3">
              <Button
                size="sm"
                variant="outline"
                className="text-destructive"
                disabled={busy}
                onClick={onUninstall}
              >
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                {t('plugins.uninstall')}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

export function PluginsSettings({
  transport: transportOverride,
}: {
  transport?: BackendTransport;
}) {
  const contextTransport = useBackendTransport();
  const transport = transportOverride ?? contextTransport;
  const api = useMemo(() => createPluginControlApi(transport), [transport]);
  const navigate = useNavigate();
  const { t } = useTranslation(['settings', 'common']);
  const [catalog, setCatalog] = useState<PluginControlCatalog | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<PluginEcosystem>('codex');
  const [queries, setQueries] = useState<Record<PluginEcosystem, string>>({
    codex: '',
    claude_code: '',
    vibex: '',
  });
  const [listPanePercent, setListPanePercent] = useState(
    initialPluginListPanePercent
  );
  const [isResizingPanels, setIsResizingPanels] = useState(false);
  const pluginGridRef = useRef<HTMLDivElement>(null);
  const resizingPanelsRef = useRef(false);
  const [isLoading, setIsLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importPath, setImportPath] = useState<string | null>(null);
  const [importChooserOpen, setImportChooserOpen] = useState(false);
  const [importEcosystem, setImportEcosystem] =
    useState<ImportEcosystem>('codex');
  const [cliCommand, setCliCommand] = useState('');
  const [cliLogs, setCliLogs] = useState<string[]>([]);
  const [cliImportStatus, setCliImportStatus] = useState<
    'idle' | 'running' | 'succeeded' | 'failed'
  >('idle');
  const [cliImportResult, setCliImportResult] =
    useState<PluginCliImportResult | null>(null);
  const [cliImportError, setCliImportError] = useState<string | null>(null);
  const [importPackageKind, setImportPackageKind] =
    useState<PluginImportPackageKind | null>(null);
  const [importPreview, setImportPreview] =
    useState<PluginImportPreview | null>(null);
  const [developerLink, setDeveloperLink] = useState(false);
  const [capabilitySetup, setCapabilitySetup] =
    useState<PluginControlItem | null>(null);
  const [uninstallTarget, setUninstallTarget] =
    useState<PluginControlItem | null>(null);
  const [runtimeConflict, setRuntimeConflict] = useState<{
    plugin: PluginControlItem;
    runtimeId: string;
    conflict: PluginRuntimeConflict;
  } | null>(null);
  const [trustTarget, setTrustTarget] = useState<PluginControlItem | null>(
    null
  );

  const reload = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const next = await api.catalog();
      setCatalog(next);
      setSelectedId((current) =>
        current && next.plugins.some((plugin) => plugin.id === current)
          ? current
          : (next.plugins[0]?.id ?? null)
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        PLUGIN_LIST_PANE_STORAGE_KEY,
        String(listPanePercent)
      );
    } catch {
      // The setting is optional when persistent storage is unavailable.
    }
  }, [listPanePercent]);

  const resizePanelsFromClientX = (clientX: number) => {
    const bounds = pluginGridRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0) return;
    setListPanePercent(
      clampPluginListPane(
        Math.round(((clientX - bounds.left) / bounds.width) * 100)
      )
    );
  };

  const beginPanelResize = (event: PointerEvent<HTMLDivElement>) => {
    resizingPanelsRef.current = true;
    setIsResizingPanels(true);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    resizePanelsFromClientX(event.clientX);
  };

  const continuePanelResize = (event: PointerEvent<HTMLDivElement>) => {
    if (!resizingPanelsRef.current) return;
    resizePanelsFromClientX(event.clientX);
  };

  const finishPanelResize = (event: PointerEvent<HTMLDivElement>) => {
    resizingPanelsRef.current = false;
    setIsResizingPanels(false);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const resizePanelsFromKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    let next = listPanePercent;
    if (event.key === 'ArrowLeft') next -= 2;
    else if (event.key === 'ArrowRight') next += 2;
    else if (event.key === 'Home') next = PLUGIN_LIST_PANE_MIN;
    else if (event.key === 'End') next = PLUGIN_LIST_PANE_MAX;
    else return;
    event.preventDefault();
    setListPanePercent(clampPluginListPane(next));
  };

  const visiblePlugins = useMemo(() => {
    const normalized = queries[activeTab].trim().toLocaleLowerCase();
    return (catalog?.plugins ?? []).filter((plugin) => {
      const matchesEcosystem = pluginEcosystem(plugin) === activeTab;
      const matchesQuery =
        !normalized ||
        plugin.name.toLocaleLowerCase().includes(normalized) ||
        plugin.id.toLocaleLowerCase().includes(normalized) ||
        plugin.skills.some((skill) =>
          skill.id.toLocaleLowerCase().includes(normalized)
        );
      return matchesEcosystem && matchesQuery;
    });
  }, [activeTab, catalog, queries]);
  const selected =
    visiblePlugins.find((plugin) => plugin.id === selectedId) ??
    visiblePlugins[0] ??
    null;

  const chooseZipImport = async (packageKind: PluginImportPackageKind) => {
    const picked = await open({
      directory: false,
      multiple: false,
      filters: [{ name: 'ZIP', extensions: ['zip'] }],
    });
    if (typeof picked !== 'string') return;
    setBusy(true);
    setError(null);
    try {
      const preview = await api.previewImport(picked, false, packageKind);
      setImportPath(picked);
      setImportPackageKind(packageKind);
      setDeveloperLink(false);
      setImportPreview(preview);
      setImportChooserOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const selectImportEcosystem = (ecosystem: ImportEcosystem) => {
    setImportEcosystem(ecosystem);
    setCliCommand('');
    setCliLogs([]);
    setCliImportStatus('idle');
    setCliImportResult(null);
    setCliImportError(null);
  };

  const appendCliEvent = (event: PluginCliImportEvent) => {
    setCliLogs((current) => {
      switch (event.event) {
        case 'started':
          return [...current, `$ ${event.command}`];
        case 'log':
          return [
            ...current,
            `${event.stream === 'stderr' ? '! ' : ''}${event.line}`,
          ];
        case 'command_finished':
          return [
            ...current,
            event.success
              ? t('plugins.cliCommandSucceeded')
              : t('plugins.cliCommandFailed', {
                  code: event.exitCode ?? '—',
                }),
          ];
      }
    });
  };

  const runCliImport = async () => {
    if (importEcosystem === 'vibex' || !cliCommand.trim()) return;
    setCliImportStatus('running');
    setCliLogs([]);
    setCliImportResult(null);
    setCliImportError(null);
    try {
      const result = await api.importCli(
        importEcosystem,
        cliCommand,
        appendCliEvent
      );
      setCliImportResult(result);
      setCliImportStatus('succeeded');
      await reload();
    } catch (cause) {
      setCliImportError(cause instanceof Error ? cause.message : String(cause));
      setCliImportStatus('failed');
    }
  };

  const applyImport = async (decision: 'reject' | 'keep' | 'replace') => {
    if (!importPath) return;
    setBusy(true);
    try {
      const imported = await api.import(
        importPath,
        developerLink,
        decision,
        importPackageKind ?? undefined
      );
      setImportPreview(null);
      setImportPath(null);
      setImportPackageKind(null);
      await reload();
      setSelectedId(imported.id);
      setActiveTab(pluginEcosystem(imported));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const setEnabled = async (plugin: PluginControlItem, enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.setEnabled(plugin.id, enabled);
      if (enabled && !plugin.nativeManaged) {
        await api.configureAgents(plugin.id, true, []);
      }
      setCatalog((current) =>
        current
          ? {
              ...current,
              plugins: current.plugins.map((item) =>
                item.id === plugin.id ? { ...item, ...updated, enabled } : item
              ),
            }
          : current
      );
      if (
        enabled &&
        !plugin.nativeManaged &&
        (updated.mcpCount ?? plugin.mcpCount ?? 0) > 0
      ) {
        setCapabilitySetup({ ...plugin, ...updated, enabled: true });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const updatePlugin = async (plugin: PluginControlItem) => {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.update(plugin.id);
      setCatalog((current) =>
        current
          ? {
              ...current,
              plugins: current.plugins.map((item) =>
                item.id === plugin.id ? { ...item, ...updated } : item
              ),
            }
          : current
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const configureAllAgents = async () => {
    if (!capabilitySetup) return;
    setBusy(true);
    try {
      if ((capabilitySetup.mcpCount ?? 0) > 0) {
        await api.configureMcp(capabilitySetup.id, true, []);
      }
      setCapabilitySetup(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const setTrust = async (plugin: PluginControlItem, trusted: boolean) => {
    setBusy(true);
    try {
      await api.setShellTrust(plugin.id, trusted);
      setTrustTarget(null);
      await reload();
      setSelectedId(plugin.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const uninstall = async () => {
    if (!uninstallTarget) return;
    setBusy(true);
    try {
      await api.uninstall(uninstallTarget.id);
      setUninstallTarget(null);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const installRuntime = async (
    plugin: PluginControlItem,
    runtimeId: string,
    confirmConflict = false
  ) => {
    setBusy(true);
    setError(null);
    try {
      if (!confirmConflict) {
        const conflict = await api.previewRuntimeInstall(plugin.id, runtimeId);
        if (conflict) {
          setRuntimeConflict({ plugin, runtimeId, conflict });
          return;
        }
      }
      await api.installRuntime(plugin.id, runtimeId, confirmConflict);
      setRuntimeConflict(null);
      await reload();
      setSelectedId(plugin.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <SettingsPageHeader
        title={t('plugins.pageTitle')}
        description={t('plugins.pageDescription')}
      />
      <SettingsSection
        icon={Puzzle}
        title={t('plugins.pageTitle')}
        description={t('plugins.pageDescription')}
        className="plugin-hub-shell"
        bare
        action={
          <div className="plugin-hub-header-actions">
            <div
              className="plugin-ecosystem-tabs"
              role="tablist"
              aria-label={t('plugins.ecosystemTabsAria')}
            >
              {PLUGIN_TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-label={tab.label}
                  aria-selected={activeTab === tab.id}
                  className={cn(activeTab === tab.id && 'is-active')}
                  onClick={() => {
                    setActiveTab(tab.id);
                    setSelectedId(null);
                  }}
                >
                  {tab.id !== 'vibex' ? (
                    <AgentTypeIcon
                      agentType={tab.id}
                      className="plugin-ecosystem-tab-icon"
                    />
                  ) : null}
                  <span>{tab.label}</span>
                  <small aria-hidden="true">
                    {
                      (catalog?.plugins ?? []).filter(
                        (plugin) => pluginEcosystem(plugin) === tab.id
                      ).length
                    }
                  </small>
                </button>
              ))}
            </div>
            <Button
              size="sm"
              onClick={() => {
                selectImportEcosystem('codex');
                setImportChooserOpen(true);
              }}
              disabled={busy}
            >
              <PackagePlus className="mr-1.5 h-3.5 w-3.5" />
              {t('plugins.import')}
            </Button>
          </div>
        }
      >
        <div className="plugin-hub-toolbar">
          <label className="plugin-search-control">
            <Search aria-hidden="true" />
            <span className="sr-only">
              {t('plugins.searchInTab', {
                tab: PLUGIN_TABS.find((tab) => tab.id === activeTab)?.label,
              })}
            </span>
            <input
              type="search"
              value={queries[activeTab]}
              onChange={(event) =>
                setQueries((current) => ({
                  ...current,
                  [activeTab]: event.target.value,
                }))
              }
              placeholder={t('plugins.searchPlaceholderInTab', {
                tab: PLUGIN_TABS.find((tab) => tab.id === activeTab)?.label,
              })}
              aria-label={t('plugins.searchInTab', {
                tab: PLUGIN_TABS.find((tab) => tab.id === activeTab)?.label,
              })}
            />
          </label>
        </div>

        {error ? (
          <div role="alert" className="plugin-hub-error">
            <AlertTriangle aria-hidden="true" />
            <span>{t('plugins.loadFailed', { error })}</span>
            <Button size="sm" variant="ghost" onClick={() => void reload()}>
              {t('common:retry')}
            </Button>
          </div>
        ) : null}

        <div className="plugin-hub-frame">
          {isLoading ? (
            <div role="status" className="plugin-hub-loading">
              <Loader2 className="animate-spin" />
              {t('plugins.loading')}
            </div>
          ) : visiblePlugins.length ? (
            <div
              ref={pluginGridRef}
              className={cn(
                'plugin-hub-grid',
                isResizingPanels && 'is-resizing'
              )}
              style={
                {
                  '--plugin-list-width': `${listPanePercent}%`,
                } as CSSProperties
              }
            >
              <nav
                className="plugin-hub-list"
                aria-label={t('plugins.catalogAria')}
              >
                {visiblePlugins.map((plugin) => (
                  <button
                    key={plugin.id}
                    type="button"
                    className={cn(
                      'plugin-hub-row',
                      selected?.id === plugin.id && 'is-selected'
                    )}
                    onClick={() => setSelectedId(plugin.id)}
                    aria-current={
                      selected?.id === plugin.id ? 'true' : undefined
                    }
                    aria-label={`${plugin.name} · ${plugin.enabled ? t('plugins.enabled') : t('plugins.disabled')}`}
                  >
                    <span className="min-w-0 flex-1 text-left">
                      <strong>{plugin.name}</strong>
                    </span>
                    <span
                      className={cn(
                        'plugin-state-dot',
                        plugin.enabled && 'is-enabled'
                      )}
                      aria-hidden="true"
                    />
                    <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
                  </button>
                ))}
              </nav>
              <div
                className="plugin-hub-resizer"
                role="separator"
                tabIndex={0}
                aria-label={t('plugins.resizePanelsAria')}
                aria-orientation="vertical"
                aria-valuemin={PLUGIN_LIST_PANE_MIN}
                aria-valuemax={PLUGIN_LIST_PANE_MAX}
                aria-valuenow={listPanePercent}
                aria-valuetext={t('plugins.resizePanelsValue', {
                  percent: listPanePercent,
                })}
                onPointerDown={beginPanelResize}
                onPointerMove={continuePanelResize}
                onPointerUp={finishPanelResize}
                onPointerCancel={finishPanelResize}
                onLostPointerCapture={() => {
                  resizingPanelsRef.current = false;
                  setIsResizingPanels(false);
                }}
                onKeyDown={resizePanelsFromKeyboard}
              />
              {selected ? (
                <PluginDetail
                  key={selected.id}
                  plugin={selected}
                  busy={busy}
                  onEnabledChange={(enabled) =>
                    void setEnabled(selected, enabled)
                  }
                  onUpdate={() => void updatePlugin(selected)}
                  onTrustChange={(trusted) => {
                    if (trusted) setTrustTarget(selected);
                    else void setTrust(selected, false);
                  }}
                  onInstallRuntime={(runtimeId) =>
                    void installRuntime(selected, runtimeId)
                  }
                  onUninstall={() => setUninstallTarget(selected)}
                  loadContributions={() => api.contributions(selected)}
                  runtimeInventory={catalog?.runtimes ?? []}
                />
              ) : null}
            </div>
          ) : (
            <div className="plugin-hub-empty">
              <Puzzle aria-hidden="true" />
              <strong>{t('plugins.emptyTitle')}</strong>
              <p>
                {t('plugins.emptyDescriptionInTab', {
                  tab: PLUGIN_TABS.find((tab) => tab.id === activeTab)?.label,
                })}
              </p>
            </div>
          )}
        </div>
      </SettingsSection>

      {catalog?.runtimes.length ? (
        <SettingsSection
          icon={TerminalSquare}
          title={t('plugins.runtimeInventoryTitle')}
          description={t('plugins.runtimeInventoryDescription')}
        >
          <div className="plugin-runtime-inventory">
            {catalog.runtimes.map((runtime) => (
              <article key={runtime.id}>
                <div>
                  <strong>{runtime.id}</strong>
                  <span>{runtime.version}</span>
                  <span>{runtime.installer}</span>
                </div>
                <code title={runtime.executablePath}>
                  {runtime.executablePath}
                </code>
                <small>
                  {t('plugins.runtimeProbe', {
                    probe: runtime.probe.join(' '),
                  })}
                </small>
                <small>
                  {t('plugins.runtimeReferences', {
                    plugins: runtime.referencedPlugins.join(', ') || '—',
                  })}
                </small>
              </article>
            ))}
          </div>
        </SettingsSection>
      ) : null}

      <Dialog
        open={importChooserOpen}
        onOpenChange={(open) => {
          if (!open && cliImportStatus === 'running') return;
          setImportChooserOpen(open);
        }}
        aria-labelledby="plugin-import-ecosystem-title"
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle id="plugin-import-ecosystem-title">
              {t('plugins.importEcosystemTitle')}
            </DialogTitle>
            <DialogDescription>
              {t('plugins.importEcosystemDescription')}
            </DialogDescription>
          </DialogHeader>
          <div
            className="plugin-import-ecosystem-tabs"
            aria-label={t('plugins.importEcosystemAria')}
          >
            {IMPORT_ECOSYSTEMS.map((ecosystem) => (
              <button
                key={ecosystem.id}
                type="button"
                aria-pressed={importEcosystem === ecosystem.id}
                className={cn(importEcosystem === ecosystem.id && 'is-active')}
                onClick={() => selectImportEcosystem(ecosystem.id)}
              >
                {ecosystem.label}
              </button>
            ))}
          </div>

          <div className="plugin-import-methods">
            {importEcosystem === 'codex' ? (
              <div className="plugin-import-method-row">
                <Archive aria-hidden="true" />
                <div>
                  <strong>Skills-only ZIP</strong>
                  <p>{t('plugins.codexZipDescription')}</p>
                </div>
                <Button
                  size="sm"
                  onClick={() => void chooseZipImport('codex')}
                  disabled={busy}
                >
                  {t('plugins.chooseZip')}
                </Button>
              </div>
            ) : null}

            {importEcosystem !== 'vibex' ? (
              <div className="plugin-cli-import">
                <div className="plugin-cli-import-heading">
                  <Command aria-hidden="true" />
                  <div>
                    <strong>{t('plugins.marketplaceMethod')}</strong>
                    <p>
                      {t(
                        importEcosystem === 'codex'
                          ? 'plugins.codexCliDescription'
                          : 'plugins.claudeCliDescription'
                      )}
                    </p>
                  </div>
                </div>
                <label className="plugin-cli-command-field">
                  <span>
                    {t('plugins.cliCommandLabel', {
                      ecosystem:
                        importEcosystem === 'codex' ? 'Codex' : 'Claude Code',
                    })}
                  </span>
                  <textarea
                    value={cliCommand}
                    disabled={cliImportStatus === 'running'}
                    onChange={(event) => setCliCommand(event.target.value)}
                    placeholder={t(
                      importEcosystem === 'codex'
                        ? 'plugins.codexCliPlaceholder'
                        : 'plugins.claudeCliPlaceholder'
                    )}
                    aria-label={t('plugins.cliCommandLabel', {
                      ecosystem:
                        importEcosystem === 'codex' ? 'Codex' : 'Claude Code',
                    })}
                  />
                </label>
                <div className="plugin-cli-import-actions">
                  <Button
                    size="sm"
                    disabled={
                      cliImportStatus === 'running' || !cliCommand.trim()
                    }
                    onClick={() => void runCliImport()}
                  >
                    {cliImportStatus === 'running' ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : null}
                    {cliImportStatus === 'running'
                      ? t('plugins.cliImportRunning')
                      : t('plugins.runCliImport')}
                  </Button>
                </div>

                {cliImportStatus !== 'idle' ? (
                  <div className="plugin-cli-output">
                    <strong>{t('plugins.cliLogTitle')}</strong>
                    <pre role="log" aria-live="polite">
                      {cliLogs.join('\n')}
                    </pre>
                  </div>
                ) : null}

                {cliImportStatus === 'succeeded' && cliImportResult ? (
                  <div className="plugin-cli-result is-success" role="status">
                    <CheckCircle2 aria-hidden="true" />
                    <div>
                      <strong>{t('plugins.cliImportSuccess')}</strong>
                      {cliImportResult.importedPluginIds.length ? (
                        <ul>
                          {cliImportResult.importedPluginIds.map((pluginId) => (
                            <li key={pluginId}>{pluginId}</li>
                          ))}
                        </ul>
                      ) : (
                        <p>{t('plugins.cliImportNoNewPlugins')}</p>
                      )}
                    </div>
                  </div>
                ) : null}

                {cliImportStatus === 'failed' && cliImportError ? (
                  <div className="plugin-cli-result is-error" role="alert">
                    <AlertTriangle aria-hidden="true" />
                    <div>
                      <strong>{t('plugins.cliImportFailed')}</strong>
                      <p>{cliImportError}</p>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            {importEcosystem === 'vibex' ? (
              <div className="plugin-import-method-row">
                <Archive aria-hidden="true" />
                <div>
                  <strong>{t('plugins.vibexZipTitle')}</strong>
                  <p>{t('plugins.vibexZipDescription')}</p>
                </div>
                <Button
                  size="sm"
                  onClick={() => void chooseZipImport('vibex')}
                  disabled={busy}
                >
                  {t('plugins.chooseZip')}
                </Button>
              </div>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(importPreview)}
        onOpenChange={(open) => !open && setImportPreview(null)}
        aria-labelledby="plugin-import-title"
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle id="plugin-import-title">
              {t('plugins.importTitle', {
                name: importPreview?.plugin.name ?? '',
              })}
            </DialogTitle>
            <DialogDescription>
              {t('plugins.importDescription')}
            </DialogDescription>
          </DialogHeader>
          {importPreview ? (
            <div className="space-y-3 text-xs">
              <div className="plugin-import-summary">
                <strong>{importPreview.plugin.id}</strong>
                <span>v{importPreview.plugin.version}</span>
                <span>{importPreview.plugin.skills.length} Skills</span>
              </div>
              {importPreview.conflict ? (
                <div className="plugin-import-conflict" role="alert">
                  <AlertTriangle aria-hidden="true" />
                  <div>
                    <strong>{t('plugins.sameIdConflict')}</strong>
                    <p>{t('plugins.sameIdConflictDescription')}</p>
                    <code>{importPreview.conflict.installedSource}</code>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setImportPreview(null)}
              disabled={busy}
            >
              {t('common:cancel')}
            </Button>
            {importPreview?.conflict ? (
              <>
                <Button
                  variant="outline"
                  onClick={() => void applyImport('keep')}
                  disabled={busy}
                >
                  {t('plugins.keepInstalled')}
                </Button>
                <Button
                  onClick={() => void applyImport('replace')}
                  disabled={busy}
                >
                  {t('plugins.replaceInstall')}
                </Button>
              </>
            ) : (
              <Button
                onClick={() => void applyImport('reject')}
                disabled={busy}
              >
                {t('plugins.import')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(capabilitySetup)}
        onOpenChange={(open) => !open && setCapabilitySetup(null)}
        aria-labelledby="plugin-capability-setup-title"
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle id="plugin-capability-setup-title">
              {t('plugins.capabilitySetupTitle')}
            </DialogTitle>
            <DialogDescription>
              {t('plugins.capabilitySetupDescription', {
                name: capabilitySetup?.name ?? '',
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="plugin-capability-setup">
            <Bot aria-hidden="true" />
            <div>
              <strong>{t('plugins.allAgentSkills')}</strong>
              <p>{t('plugins.allAgentSkillsDescription')}</p>
              {(capabilitySetup?.mcpCount ?? 0) > 0 ? (
                <p className="mt-2 text-amber-600 dark:text-amber-400">
                  {t('plugins.builtinMcpNotice')}
                </p>
              ) : null}
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                const pluginId = capabilitySetup?.id;
                setCapabilitySetup(null);
                if (pluginId) {
                  navigate(
                    `/settings/mcp?plugin=${encodeURIComponent(pluginId)}`
                  );
                }
              }}
            >
              {t('plugins.chooseAgentsAndMcp')}
            </Button>
            <Button onClick={() => void configureAllAgents()} disabled={busy}>
              {t('plugins.enableAllAgents')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(trustTarget)}
        onOpenChange={(open) => !open && setTrustTarget(null)}
        aria-labelledby="plugin-shell-trust-title"
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle id="plugin-shell-trust-title">
              {t('plugins.shellTrustDialogTitle', {
                name: trustTarget?.name ?? '',
              })}
            </DialogTitle>
            <DialogDescription>{t('plugins.shellTrustRisk')}</DialogDescription>
          </DialogHeader>
          {trustTarget ? (
            <div className="space-y-3 text-xs">
              <div className="plugin-source-row">
                <Link2 aria-hidden="true" />
                <div className="min-w-0">
                  <strong>{t('plugins.sourceTitle')}</strong>
                  <code className="block">{trustTarget.sourcePath}</code>
                </div>
              </div>
              <div className="plugin-import-conflict">
                <TerminalSquare aria-hidden="true" />
                <div className="min-w-0">
                  <strong>{t('plugins.shellCommands')}</strong>
                  {trustTarget.runtimes
                    .filter((runtime) => runtime.installer === 'shell')
                    .map((runtime) => (
                      <code className="block" key={runtime.id}>
                        {runtime.installCommand}
                      </code>
                    ))}
                </div>
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setTrustTarget(null)}>
              {t('common:cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => trustTarget && void setTrust(trustTarget, true)}
            >
              {t('plugins.confirmShellTrust')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(runtimeConflict)}
        onOpenChange={(open) => !open && setRuntimeConflict(null)}
        aria-labelledby="plugin-runtime-conflict-title"
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle id="plugin-runtime-conflict-title">
              {t('plugins.runtimeConflictTitle', {
                id: runtimeConflict?.runtimeId ?? '',
              })}
            </DialogTitle>
            <DialogDescription>
              {t('plugins.runtimeConflictDescription')}
            </DialogDescription>
          </DialogHeader>
          {runtimeConflict ? (
            <div className="plugin-import-conflict" role="alert">
              <AlertTriangle aria-hidden="true" />
              <div className="min-w-0 space-y-2">
                <strong>
                  {runtimeConflict.conflict.currentVersion} →{' '}
                  {runtimeConflict.conflict.targetVersion}
                </strong>
                {runtimeConflict.conflict.affectedPlugins.length ? (
                  <div>
                    <p>{t('plugins.affectedPlugins')}</p>
                    {runtimeConflict.conflict.affectedPlugins.map((id) => (
                      <code className="block" key={id}>
                        {id}
                      </code>
                    ))}
                  </div>
                ) : null}
                {runtimeConflict.conflict.affectedAutomations.length ? (
                  <div>
                    <p>{t('plugins.affectedAutomations')}</p>
                    {runtimeConflict.conflict.affectedAutomations.map((id) => (
                      <code className="block" key={id}>
                        {id}
                      </code>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRuntimeConflict(null)}>
              {t('common:cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                if (runtimeConflict) {
                  void installRuntime(
                    runtimeConflict.plugin,
                    runtimeConflict.runtimeId,
                    true
                  );
                }
              }}
            >
              {t('plugins.confirmRuntimeReplace')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(uninstallTarget)}
        onOpenChange={(open) => !open && setUninstallTarget(null)}
        aria-labelledby="plugin-uninstall-title"
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle id="plugin-uninstall-title">
              {t('plugins.uninstallTitle', {
                name: uninstallTarget?.name ?? '',
              })}
            </DialogTitle>
            <DialogDescription>
              {t(
                uninstallTarget?.nativeManaged
                  ? 'plugins.nativeUninstallDescription'
                  : 'plugins.uninstallDescription',
                { name: uninstallTarget?.name ?? '' }
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUninstallTarget(null)}>
              {t('common:cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => void uninstall()}
              disabled={busy}
            >
              {t('plugins.confirmUninstall')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
