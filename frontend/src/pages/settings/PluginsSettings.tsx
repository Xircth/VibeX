import { open } from '@tauri-apps/plugin-dialog';
import {
  Button as AstryxButton,
  CheckboxInput,
  Dialog as AstryxDialog,
  DialogHeader as AstryxDialogHeader,
  Layout as AstryxLayout,
  LayoutContent as AstryxLayoutContent,
  LayoutFooter as AstryxLayoutFooter,
} from '@astryxdesign/core';
import {
  AlertTriangle,
  Archive,
  ArrowLeft,
  Bot,
  CheckCircle2,
  ChevronRight,
  Command,
  FileSearch,
  Link2,
  Loader2,
  PackagePlus,
  RefreshCw,
  RotateCcw,
  Puzzle,
  Search,
  TerminalSquare,
  Trash2,
  Workflow,
} from 'lucide-react';
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
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
import { AppSurfaceHost } from '@/components/plugins/AppSurfaceHost';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import {
  appSurfaceDescriptors,
  createBackendAppSurfaceTransport,
} from '@/lib/api/appSurfaceTransport';
import type { BackendTransport } from '@/lib/backendTransport';
import {
  createPluginControlApi,
  type PluginCliImportEvent,
  type PluginCliImportResult,
  type PluginContributionCatalog,
  type PluginContributionCatalogItem,
  type PluginControlCatalog,
  type PluginControlContributions,
  type PluginControlItem,
  type PluginDevConnection,
  type PluginImportPackageKind,
  type PluginImportPreview,
  type PluginPermission,
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

export type PluginEcosystem = 'codex' | 'claude_code' | 'vibex';
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

function runtimeIdentity(runtime: PluginRuntimeInventoryItem) {
  return [
    runtime.id,
    runtime.version,
    runtime.target ?? 'target-unavailable',
    runtime.contentDigest ?? 'digest-unavailable',
  ].join(':');
}

function runtimeLockIsReady(
  contribution: PluginControlItem['runtimes'][number],
  installed: PluginRuntimeInventoryItem
) {
  return Boolean(
    contribution.target &&
      contribution.contentDigest &&
      installed.id === contribution.id &&
      installed.version === contribution.version &&
      installed.target === contribution.target &&
      installed.contentDigest === contribution.contentDigest
  );
}

interface PermissionReview {
  plugin: PluginControlItem;
  intent: 'enable' | 'update' | 'replace' | 'install-runtime';
  permissions: PluginPermission[];
  runtimeId?: string;
}

type PluginDetailMode = 'overview' | 'skills' | 'mcp';

function contributionMetadata(item: { metadata: unknown }) {
  return item.metadata && typeof item.metadata === 'object'
    ? (item.metadata as Record<string, unknown>)
    : {};
}

function fileExtensions(items: Array<{ metadata: unknown }>) {
  return [
    ...new Set(
      items.flatMap((item) => {
        const extensions = contributionMetadata(item).extensions;
        return Array.isArray(extensions)
          ? extensions.filter(
              (extension): extension is string => typeof extension === 'string'
            )
          : [];
      })
    ),
  ];
}

function runtimeDisplayName(runtimeId: string) {
  return runtimeId.toLowerCase() === 'officecli' ? 'OfficeCLI' : runtimeId;
}

function AgentNativeResourceSection({
  icon,
  title,
  items,
  empty,
}: {
  icon: ReactNode;
  title: string;
  items: Array<{ id: string; detail?: string | null }>;
  empty: string;
}) {
  return (
    <div className="plugin-detail-section">
      <h4>
        {icon}
        {title}
      </h4>
      {items.length ? (
        <ul className="plugin-contribution-list">
          {items.map((item) => (
            <li key={`${item.id}:${item.detail ?? ''}`}>
              <span>{item.id}</span>
              {item.detail ? <code>{item.detail}</code> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="plugin-detail-empty-copy">{empty}</p>
      )}
    </div>
  );
}

function AgentNativePluginDetail({
  plugin,
  busy,
  onEnabledChange,
  onUpdate,
  onUninstall,
  canWrite,
  canManagePackage,
}: {
  plugin: PluginControlItem;
  busy: boolean;
  onEnabledChange: (enabled: boolean) => void;
  onUpdate: () => void;
  onUninstall: () => void;
  canWrite: boolean;
  canManagePackage: boolean;
}) {
  const { t } = useTranslation('settings');
  const skillItems = plugin.skills.map((skill) => ({
    id: skill.id,
    detail: skill.path,
  }));
  const mcpItems = (plugin.mcpServers ?? []).map((id) => ({ id }));
  const runtimeItems = plugin.runtimes.map((runtime) => ({
    id: runtime.id,
    detail: runtime.version
      ? `${runtime.command} · v${runtime.version}`
      : runtime.command,
  }));

  return (
    <section
      className="plugin-hub-detail plugin-agent-native-detail"
      role="region"
      aria-label={plugin.name}
    >
      <header className="plugin-detail-header">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-base font-semibold text-foreground">
              {plugin.name}
            </h3>
            <span className="plugin-version">v{plugin.version}</span>
          </div>
          {plugin.description ? (
            <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
              {plugin.description}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {plugin.enableSupported ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !canWrite}
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
          ) : null}
          {plugin.updateSupported && canManagePackage ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !canWrite}
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
      </header>

      <div className="plugin-overview-sections">
        <AgentNativeResourceSection
          icon={<Puzzle aria-hidden="true" />}
          title={t('plugins.skillsTitle')}
          items={skillItems}
          empty={t('plugins.noSkills')}
        />
        <AgentNativeResourceSection
          icon={<Bot aria-hidden="true" />}
          title={t('plugins.mcpTitle')}
          items={mcpItems}
          empty={t('plugins.noMcp')}
        />
        <AgentNativeResourceSection
          icon={<TerminalSquare aria-hidden="true" />}
          title={t('plugins.runtimeTitle')}
          items={runtimeItems}
          empty={t('plugins.noRuntime')}
        />
        <AgentNativeResourceSection
          icon={<Link2 aria-hidden="true" />}
          title={t('plugins.hooksTitle')}
          items={(plugin.hooks ?? []).map((hook) => ({
            id: hook.id,
            detail: hook.path,
          }))}
          empty={t('plugins.noHooks')}
        />
        <AgentNativeResourceSection
          icon={<Workflow aria-hidden="true" />}
          title={t('plugins.workflowsTitle')}
          items={(plugin.workflows ?? []).map((workflow) => ({
            id: workflow.id,
            detail: workflow.path,
          }))}
          empty={t('plugins.noWorkflows')}
        />
      </div>

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

      {plugin.uninstallSupported !== false && canManagePackage ? (
        <div className="flex justify-end border-t border-border/70 pt-3">
          <Button
            size="sm"
            variant="outline"
            className="text-destructive"
            disabled={busy || !canWrite}
            onClick={onUninstall}
          >
            <Trash2 className="mr-1.5 h-3.5 w-3.5" />
            {t('plugins.uninstall')}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function PluginDetail({
  plugin,
  busy,
  onEnabledChange,
  onUpdate,
  onRollback,
  onInstallRuntime,
  onUninstall,
  loadContributions,
  runtimeInventory,
  registryGeneration,
  registryContributions,
  appSurfaceTransport,
  canWrite,
  canSurface,
  canManagePackage,
}: {
  plugin: PluginControlItem;
  busy: boolean;
  onEnabledChange: (enabled: boolean) => void;
  onUpdate: () => void;
  onRollback: () => void;
  onInstallRuntime: (runtimeId: string) => void;
  onUninstall: () => void;
  loadContributions: () => Promise<PluginControlContributions>;
  runtimeInventory: PluginRuntimeInventoryItem[];
  registryGeneration?: number;
  registryContributions?: PluginContributionCatalogItem[];
  appSurfaceTransport: ReturnType<typeof createBackendAppSurfaceTransport>;
  canWrite: boolean;
  canSurface: boolean;
  canManagePackage: boolean;
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
  const [showDeveloperDetails, setShowDeveloperDetails] = useState(false);
  const registryItems = registryContributions ?? [];
  const platformExtensions =
    plugin.appContributions ??
    registryItems.filter((item) =>
      ['file_opener', 'preview_provider', 'app_surface'].includes(item.kind)
    );
  const extensions = fileExtensions(
    platformExtensions.filter((item) => item.kind === 'file_opener')
  );
  const hasFilePreview = platformExtensions.some(
    (item) => item.kind === 'file_opener' || item.kind === 'preview_provider'
  );
  const uniqueInvocations = [
    ...new Map(
      (plugin.invocations ?? []).map((invocation) => [
        invocation.id,
        invocation,
      ])
    ).values(),
  ];
  const appSurfaces = useMemo(
    () => appSurfaceDescriptors(plugin, registryContributions ?? []),
    [plugin, registryContributions]
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
                  disabled={busy || !canWrite}
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
            {plugin.updateSupported && canManagePackage ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !canWrite}
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
              disabled={busy || !canWrite}
              onCheckedChange={onEnabledChange}
              aria-label={t('plugins.enabledAria', { name: plugin.name })}
            />
            {plugin.updateSupported && canManagePackage ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !canWrite}
                onClick={onUpdate}
                aria-label={t('plugins.updateNativeAria', {
                  name: plugin.name,
                })}
              >
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                {t('plugins.updateNative')}
              </Button>
            ) : null}
            {plugin.rollbackSupported && canManagePackage ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !canWrite}
                onClick={onRollback}
                aria-label={t('plugins.rollbackAria', { name: plugin.name })}
              >
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                {t('plugins.rollback')}
              </Button>
            ) : null}
          </div>
        )}
      </header>

      {mode === 'overview' ? (
        <div className="plugin-product-capabilities">
          <section>
            <header>
              <FileSearch aria-hidden="true" />
              <div>
                <h4>{t('plugins.extendsVibexTitle')}</h4>
                <p>{t('plugins.extendsVibexDescription')}</p>
              </div>
            </header>
            {hasFilePreview ? (
              <div className="plugin-product-capability-row">
                <span>
                  <strong>{t('plugins.filePreviewTitle')}</strong>
                  <small>{t('plugins.filePreviewDescription')}</small>
                </span>
                {extensions.length ? (
                  <code>
                    {extensions.map((item) => item.toUpperCase()).join(' · ')}
                  </code>
                ) : null}
              </div>
            ) : (
              <p className="plugin-detail-empty-copy">
                {t('plugins.noAppExtensions')}
              </p>
            )}
          </section>
          <section>
            <header>
              <Workflow aria-hidden="true" />
              <div>
                <h4>{t('plugins.extendsAgentsTitle')}</h4>
                <p>{t('plugins.extendsAgentsDescription')}</p>
              </div>
            </header>
            <div className="plugin-product-capability-actions">
              {plugin.skills.length ? (
                <button
                  type="button"
                  onClick={() => void openContributions('skills')}
                >
                  {t('plugins.skillsCount', { count: plugin.skills.length })}
                </button>
              ) : null}
              {uniqueInvocations.length ? (
                <span>
                  {t('plugins.workflowsCount', {
                    count: uniqueInvocations.length,
                  })}
                </span>
              ) : null}
              {(plugin.mcpCount ?? 0) > 0 ? (
                <button
                  type="button"
                  onClick={() => void openContributions('mcp')}
                >
                  {t('plugins.mcpCount', { count: plugin.mcpCount })}
                </button>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}

      {mode === 'overview' && registryContributions ? (
        <div className="plugin-developer-disclosure">
          <button
            type="button"
            aria-expanded={showDeveloperDetails}
            onClick={() => setShowDeveloperDetails((current) => !current)}
          >
            {t('plugins.developerDetails')}
            <ChevronRight aria-hidden="true" />
          </button>
          {showDeveloperDetails ? (
            <div
              className="plugin-registry-snapshot"
              role="status"
              aria-label={t('plugins.registrySnapshotAria', {
                name: plugin.name,
              })}
            >
              <span>
                {t('plugins.registryGeneration', {
                  generation: registryGeneration ?? 0,
                })}
              </span>
              <span>
                {t('plugins.registryContributionCount', {
                  count: registryContributions.length,
                })}
              </span>
              <p>{t('plugins.registryExplanation')}</p>
            </div>
          ) : null}
        </div>
      ) : null}

      {mode !== 'overview' ? (
        <nav
          className="plugin-contribution-mode-nav"
          aria-label={t('plugins.contributionNavigation')}
        >
          {plugin.skills.length ? (
            <button
              type="button"
              aria-current={mode === 'skills' ? 'page' : undefined}
              onClick={() => void openContributions('skills')}
            >
              {t('plugins.skillsCount', { count: plugin.skills.length })}
            </button>
          ) : null}
          {(plugin.mcpCount ?? 0) > 0 ? (
            <button
              type="button"
              aria-current={mode === 'mcp' ? 'page' : undefined}
              onClick={() => void openContributions('mcp')}
            >
              {t('plugins.mcpCount', { count: plugin.mcpCount })}
            </button>
          ) : null}
        </nav>
      ) : null}

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
          {canSurface
            ? appSurfaces.map((surface) => (
                <AppSurfaceHost
                  key={`${surface.surfaceId}:${surface.generation}`}
                  descriptor={surface}
                  enabled={plugin.enabled}
                  transport={appSurfaceTransport}
                />
              ))
            : appSurfaces.length > 0 && (
                <p className="plugin-surface-unavailable" role="status">
                  {t('plugins.surfaceCapabilityUnavailable')}
                </p>
              )}
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

          <div className="plugin-overview-sections">
            {plugin.skills.length ? (
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
            ) : null}

            {plugin.runtimes.length ? (
              <div className="plugin-detail-section">
                <h4>
                  <TerminalSquare aria-hidden="true" />
                  {t('plugins.runtimeTitle')}
                </h4>
                {plugin.runtimes.length ? (
                  <ul className="plugin-contribution-list">
                    {plugin.runtimes.map((runtime) => (
                      <li
                        key={`${runtime.id}:${runtime.version}:${runtime.target ?? 'unknown'}:${runtime.contentDigest ?? 'unknown'}`}
                      >
                        <span>
                          {runtime.id}
                          <small>{runtime.installer}</small>
                        </span>
                        <div className="flex min-w-0 items-center gap-2">
                          <code>
                            {runtime.installCommand ?? runtime.command}
                          </code>
                          {runtimeInventory.some((installed) =>
                            runtimeLockIsReady(runtime, installed)
                          ) ? (
                            <span className="plugin-runtime-ready">
                              {t('plugins.runtimeReady')}
                            </span>
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy || !canWrite}
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
            ) : null}

            {(plugin.mcpCount ?? 0) > 0 ? (
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
            ) : null}

            {uniqueInvocations.length ? (
              <div className="plugin-detail-section">
                <h4>
                  <Command aria-hidden="true" />
                  {t('plugins.invocationsTitle')}
                </h4>
                {plugin.invocations?.length ? (
                  <ul className="plugin-contribution-list">
                    {uniqueInvocations.map((invocation) => (
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
            ) : null}

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

          {!plugin.builtin &&
          plugin.uninstallSupported !== false &&
          canManagePackage ? (
            <div className="flex justify-end border-t border-border/70 pt-3">
              <Button
                size="sm"
                variant="outline"
                className="text-destructive"
                disabled={busy || !canWrite}
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
  ecosystem,
  embedded = false,
}: {
  transport?: BackendTransport;
  /** Fix the control plane to one product surface instead of showing a mixed hub. */
  ecosystem?: PluginEcosystem;
  /** Render inside a parent settings disclosure without repeating its label. */
  embedded?: boolean;
}) {
  const contextTransport = useBackendTransport();
  const transport = transportOverride ?? contextTransport;
  const api = useMemo(() => createPluginControlApi(transport), [transport]);
  const appSurfaceTransport = useMemo(
    () => createBackendAppSurfaceTransport(transport),
    [transport]
  );
  const navigate = useNavigate();
  const { t } = useTranslation(['settings', 'common']);
  const [catalog, setCatalog] = useState<PluginControlCatalog | null>(null);
  const [contributionCatalog, setContributionCatalog] =
    useState<PluginContributionCatalog | null>(null);
  const [devConnection, setDevConnection] =
    useState<PluginDevConnection | null>(null);
  const [devConnectionCopied, setDevConnectionCopied] = useState(false);
  const [devToolsOpen, setDevToolsOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<PluginEcosystem>(
    ecosystem ?? 'codex'
  );
  const effectiveTab = ecosystem ?? activeTab;
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
  const [permissionReview, setPermissionReview] =
    useState<PermissionReview | null>(null);
  const [selectedPermissionIds, setSelectedPermissionIds] = useState<
    Set<string>
  >(new Set());
  const [trustedNativeAcknowledged, setTrustedNativeAcknowledged] =
    useState(false);
  const [backendCapabilities, setBackendCapabilities] = useState<Set<string>>(
    new Set()
  );
  const canWrite = backendCapabilities.has('plugin.write');
  const canSurface = backendCapabilities.has('plugin.surface');
  const canManagePackage = transport.environment === 'desktop';
  const canUseLocalPluginFiles =
    canWrite && transport.environment === 'desktop';

  useEffect(() => {
    let active = true;
    setBackendCapabilities(new Set());
    if (!transport.capabilities) return;
    void transport
      .capabilities()
      .then((result) => {
        if (active) setBackendCapabilities(new Set(result.capabilities));
      })
      .catch(() => {
        if (active) setBackendCapabilities(new Set());
      });
    return () => {
      active = false;
    };
  }, [transport]);

  const openPermissionReview = (
    plugin: PluginControlItem,
    intent: PermissionReview['intent'],
    permissions: PluginPermission[],
    runtimeId?: string
  ) => {
    setTrustedNativeAcknowledged(false);
    setSelectedPermissionIds(
      new Set(
        permissions
          .filter((permission) => !permission.optional)
          .map((permission) => permission.id)
      )
    );
    setPermissionReview({ plugin, intent, permissions, runtimeId });
  };

  const reload = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [next, nextContributions, nextDevConnection] = await Promise.all([
        api.catalog(),
        ecosystem === 'vibex'
          ? api.contributionCatalog().catch(() => null)
          : Promise.resolve(null),
        ecosystem === 'vibex' && transport.environment === 'desktop'
          ? api.devConnection().catch(() => null)
          : Promise.resolve(null),
      ]);
      setCatalog(next);
      setContributionCatalog(nextContributions);
      setDevConnection(nextDevConnection);
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
  }, [api, ecosystem, transport.environment]);

  const copyDevConnection = async () => {
    if (!devConnection) return;
    const shellEnvironment = [
      `export VIBEX_PLUGIN_DEV_HOST='${devConnection.endpoint}'`,
      `export VIBEX_PLUGIN_DEV_TOKEN='${devConnection.token}'`,
    ].join('\n');
    await navigator.clipboard.writeText(shellEnvironment);
    setDevConnectionCopied(true);
    window.setTimeout(() => setDevConnectionCopied(false), 1600);
  };

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
    const normalized = queries[effectiveTab].trim().toLocaleLowerCase();
    return (catalog?.plugins ?? []).filter((plugin) => {
      const matchesEcosystem = pluginEcosystem(plugin) === effectiveTab;
      const matchesQuery =
        !normalized ||
        plugin.name.toLocaleLowerCase().includes(normalized) ||
        plugin.id.toLocaleLowerCase().includes(normalized) ||
        plugin.skills.some((skill) =>
          skill.id.toLocaleLowerCase().includes(normalized)
        );
      return matchesEcosystem && matchesQuery;
    });
  }, [catalog, effectiveTab, queries]);
  const selected =
    visiblePlugins.find((plugin) => plugin.id === selectedId) ??
    visiblePlugins[0] ??
    null;
  const selectedRegistryContributions = useMemo(
    () =>
      ecosystem === 'vibex' && contributionCatalog && selected
        ? contributionCatalog.items.filter(
            (item) => item.pluginId === selected.id
          )
        : undefined,
    [contributionCatalog, ecosystem, selected]
  );

  const chooseZipImport = async (packageKind: PluginImportPackageKind) => {
    if (!canUseLocalPluginFiles) return;
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
    if (
      !canUseLocalPluginFiles ||
      importEcosystem === 'vibex' ||
      !cliCommand.trim()
    ) {
      return;
    }
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

  const applyImport = async (
    decision: 'reject' | 'keep' | 'replace',
    permissionIds: string[] = [],
    permissionsConfirmed = false
  ) => {
    if (!importPath || !canUseLocalPluginFiles) return;
    if (
      decision === 'replace' &&
      !permissionsConfirmed &&
      importPreview &&
      importPreview.conflict?.installedEnabled === true &&
      (importPreview.plugin.permissionDelta?.length ?? 0) > 0
    ) {
      openPermissionReview(
        importPreview.plugin,
        'replace',
        importPreview.plugin.permissionDelta ?? []
      );
      setImportPreview(null);
      return;
    }
    setBusy(true);
    try {
      const imported = await api.import(
        importPath,
        developerLink,
        decision,
        importPackageKind ?? undefined,
        permissionIds
      );
      setImportPreview(null);
      setImportPath(null);
      setImportPackageKind(null);
      await reload();
      setSelectedId(imported.id);
      if (!ecosystem) setActiveTab(pluginEcosystem(imported));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const setEnabled = async (
    plugin: PluginControlItem,
    enabled: boolean,
    permissionsConfirmed = false
  ) => {
    if (!canWrite) return;
    if (
      enabled &&
      !permissionsConfirmed &&
      !plugin.nativeManaged &&
      (plugin.permissions?.length ?? 0) > 0
    ) {
      openPermissionReview(plugin, 'enable', plugin.permissions ?? []);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (
        enabled &&
        !plugin.nativeManaged &&
        plugin.permissions?.some(
          (permission) => permission.trustTier === 'trusted_native'
        )
      ) {
        for (const runtime of plugin.runtimes) {
          const ready = (catalog?.runtimes ?? []).some((installed) =>
            runtimeLockIsReady(runtime, installed)
          );
          if (!ready) await api.installRuntime(plugin.id, runtime.id);
        }
      }
      const updated = await api.setEnabled(plugin.id, enabled);
      if (
        enabled &&
        !plugin.nativeManaged &&
        transport.environment === 'desktop'
      ) {
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
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      toast.error(
        t(enabled ? 'plugins.enableFailed' : 'plugins.disableFailed', {
          name: plugin.name,
        }),
        { description: message }
      );
    } finally {
      setBusy(false);
    }
  };

  const performUpdate = async (plugin: PluginControlItem) => {
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

  const updatePlugin = async (
    plugin: PluginControlItem,
    permissionsConfirmed = false
  ) => {
    if (!canWrite) return;
    if (
      !permissionsConfirmed &&
      !plugin.nativeManaged &&
      (plugin.permissionDelta?.length ?? 0) > 0
    ) {
      openPermissionReview(plugin, 'update', plugin.permissionDelta ?? []);
      return;
    }
    await performUpdate(plugin);
  };

  const rollbackPlugin = async (plugin: PluginControlItem) => {
    if (!canWrite || transport.environment !== 'desktop') return;
    setBusy(true);
    setError(null);
    try {
      const restored = await api.rollback(plugin.id);
      const refreshed = await api.catalog();
      setCatalog(refreshed);
      setSelectedId(restored.id);
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

  const confirmPermissionReview = async () => {
    if (!permissionReview || !canWrite) return;
    const { plugin, intent } = permissionReview;
    const grantedPermissionIds = permissionReview.permissions
      .filter(
        (permission) =>
          !permission.optional || selectedPermissionIds.has(permission.id)
      )
      .map((permission) => permission.id);
    setBusy(true);
    setError(null);
    try {
      if (intent === 'replace') {
        setPermissionReview(null);
        await applyImport('replace', grantedPermissionIds, true);
        return;
      }
      await api.grantPermissions(plugin.id, grantedPermissionIds);
      setPermissionReview(null);
      if (intent === 'enable') await setEnabled(plugin, true, true);
      else if (intent === 'install-runtime' && permissionReview.runtimeId) {
        await installRuntime(plugin, permissionReview.runtimeId, true);
      } else await updatePlugin(plugin, true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const uninstall = async () => {
    if (!uninstallTarget || !canWrite) return;
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
    permissionsConfirmed = false
  ) => {
    if (!canWrite) return;
    const trustedPermissions = (plugin.permissions ?? []).filter(
      (permission) => permission.trustTier === 'trusted_native'
    );
    if (!permissionsConfirmed && trustedPermissions.length > 0) {
      openPermissionReview(
        plugin,
        'install-runtime',
        trustedPermissions,
        runtimeId
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.installRuntime(plugin.id, runtimeId);
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
        description={t(
          ecosystem === 'vibex'
            ? 'plugins.productDescription'
            : ecosystem
              ? 'plugins.nativeDescription'
              : 'plugins.pageDescription'
        )}
      />
      <SettingsSection
        icon={Puzzle}
        title={t('plugins.pageTitle')}
        description={t(
          ecosystem === 'vibex'
            ? 'plugins.productDescription'
            : ecosystem
              ? 'plugins.nativeDescription'
              : 'plugins.pageDescription'
        )}
        className={cn('plugin-hub-shell', embedded && 'is-embedded')}
        bare
        headerless={embedded}
        action={
          <div className="plugin-hub-header-actions">
            {!ecosystem ? (
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
            ) : null}
            {canUseLocalPluginFiles ? (
              <Button
                size="sm"
                onClick={() => {
                  selectImportEcosystem(ecosystem ?? 'codex');
                  setImportChooserOpen(true);
                }}
                disabled={busy}
              >
                <PackagePlus className="mr-1.5 h-3.5 w-3.5" />
                {t('plugins.import')}
              </Button>
            ) : null}
            {ecosystem === 'vibex' && devConnection ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setDevToolsOpen(true)}
              >
                <TerminalSquare className="mr-1.5 h-3.5 w-3.5" />
                {t('plugins.developerTools')}
              </Button>
            ) : null}
          </div>
        }
      >
        {transport.environment !== 'desktop' && !canWrite ? (
          <p className="plugin-detail-empty-copy" role="status">
            {t('plugins.remoteReadOnly')}
          </p>
        ) : null}
        <div className="plugin-hub-toolbar">
          <label className="plugin-search-control">
            <Search aria-hidden="true" />
            <span className="sr-only">
              {t('plugins.searchInTab', {
                tab: PLUGIN_TABS.find((tab) => tab.id === effectiveTab)?.label,
              })}
            </span>
            <input
              type="search"
              value={queries[effectiveTab]}
              onChange={(event) =>
                setQueries((current) => ({
                  ...current,
                  [effectiveTab]: event.target.value,
                }))
              }
              placeholder={t('plugins.searchPlaceholderInTab', {
                tab: PLUGIN_TABS.find((tab) => tab.id === effectiveTab)?.label,
              })}
              aria-label={t('plugins.searchInTab', {
                tab: PLUGIN_TABS.find((tab) => tab.id === effectiveTab)?.label,
              })}
            />
          </label>
        </div>

        {error ? (
          <div role="alert" className="plugin-hub-error">
            <AlertTriangle aria-hidden="true" />
            <span>{t('plugins.operationFailed', { error })}</span>
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
                effectiveTab === 'vibex' ? (
                  <PluginDetail
                    key={selected.id}
                    plugin={selected}
                    busy={busy}
                    onEnabledChange={(enabled) =>
                      void setEnabled(selected, enabled)
                    }
                    onUpdate={() => void updatePlugin(selected)}
                    onRollback={() => void rollbackPlugin(selected)}
                    onInstallRuntime={(runtimeId) =>
                      void installRuntime(selected, runtimeId)
                    }
                    onUninstall={() => setUninstallTarget(selected)}
                    loadContributions={() => api.contributions(selected)}
                    runtimeInventory={catalog?.runtimes ?? []}
                    registryGeneration={contributionCatalog?.generation}
                    registryContributions={selectedRegistryContributions}
                    appSurfaceTransport={appSurfaceTransport}
                    canWrite={canWrite}
                    canSurface={canSurface}
                    canManagePackage={canManagePackage}
                  />
                ) : (
                  <AgentNativePluginDetail
                    key={selected.id}
                    plugin={selected}
                    busy={busy}
                    onEnabledChange={(enabled) =>
                      void setEnabled(selected, enabled)
                    }
                    onUpdate={() => void updatePlugin(selected)}
                    onUninstall={() => setUninstallTarget(selected)}
                    canWrite={canWrite}
                    canManagePackage={canManagePackage}
                  />
                )
              ) : null}
            </div>
          ) : (
            <div className="plugin-hub-empty">
              <Puzzle aria-hidden="true" />
              <strong>{t('plugins.emptyTitle')}</strong>
              <p>
                {t('plugins.emptyDescriptionInTab', {
                  tab: PLUGIN_TABS.find((tab) => tab.id === effectiveTab)
                    ?.label,
                })}
              </p>
            </div>
          )}
        </div>
      </SettingsSection>

      {effectiveTab === 'vibex' && catalog?.runtimes.length ? (
        <SettingsSection
          icon={TerminalSquare}
          title={t('plugins.runtimeInventoryTitle')}
          description={t('plugins.runtimeInventoryDescription')}
        >
          <div className="plugin-runtime-inventory">
            {catalog.runtimes.map((runtime) => (
              <article key={runtimeIdentity(runtime)}>
                <div>
                  <strong>{runtime.id}</strong>
                  <span>{runtime.version}</span>
                  <span>{runtime.installer}</span>
                </div>
                <small>
                  {t('plugins.runtimeTarget', {
                    target:
                      runtime.target ?? t('plugins.runtimeEvidenceUnavailable'),
                  })}
                </small>
                <code>
                  {runtime.contentDigest ??
                    t('plugins.runtimeEvidenceUnavailable')}
                </code>
                <small>
                  {t('plugins.runtimeOwnership', {
                    ownership:
                      runtime.ownership ??
                      t('plugins.runtimeEvidenceUnavailable'),
                  })}
                </small>
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
          {!ecosystem ? (
            <div
              className="plugin-import-ecosystem-tabs"
              aria-label={t('plugins.importEcosystemAria')}
            >
              {IMPORT_ECOSYSTEMS.map((candidate) => (
                <button
                  key={candidate.id}
                  type="button"
                  aria-pressed={importEcosystem === candidate.id}
                  className={cn(
                    importEcosystem === candidate.id && 'is-active'
                  )}
                  onClick={() => selectImportEcosystem(candidate.id)}
                >
                  {candidate.label}
                </button>
              ))}
            </div>
          ) : null}

          <div className="plugin-import-methods">
            {importEcosystem === 'codex' ? (
              <div className="plugin-import-method-row">
                <Archive aria-hidden="true" />
                <div>
                  <strong>{t('plugins.codexSkillsZipTitle')}</strong>
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
        open={devToolsOpen}
        onOpenChange={setDevToolsOpen}
        aria-label={t('plugins.developerTools')}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('plugins.developerTools')}</DialogTitle>
            <DialogDescription>
              {t('plugins.devHostDescription')}
            </DialogDescription>
          </DialogHeader>
          {devConnection ? (
            <div className="plugin-dev-tool-details">
              <span>
                <i aria-hidden="true" />
                {t('plugins.devHostReady')}
              </span>
              <code>{devConnection.endpoint}</code>
              <p>{t('plugins.devHostUsage')}</p>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDevToolsOpen(false)}>
              {t('common:close')}
            </Button>
            <Button onClick={() => void copyDevConnection()}>
              <TerminalSquare className="mr-1.5 h-3.5 w-3.5" />
              {devConnectionCopied
                ? t('plugins.devConnectionCopied')
                : t('plugins.copyDevConnection')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AstryxDialog
        isOpen={Boolean(permissionReview)}
        onOpenChange={(open) => !open && setPermissionReview(null)}
        purpose="required"
        width={560}
        maxHeight="min(760px, 88vh)"
        padding={0}
        aria-label={t(
          permissionReview?.intent === 'update' ||
            permissionReview?.intent === 'replace'
            ? 'plugins.permissionUpdateDialogTitle'
            : 'plugins.permissionDialogTitle',
          { name: permissionReview?.plugin.name ?? '' }
        )}
      >
        <AstryxLayout
          height="auto"
          header={
            <AstryxDialogHeader
              title={t(
                permissionReview?.intent === 'update' ||
                  permissionReview?.intent === 'replace'
                  ? 'plugins.permissionUpdateDialogTitle'
                  : 'plugins.permissionDialogTitle',
                {
                  name: permissionReview?.plugin.name ?? '',
                }
              )}
              subtitle={t('plugins.permissionDialogDescription')}
            />
          }
          content={
            <AstryxLayoutContent padding={4}>
              {permissionReview ? (
                <div className="plugin-permission-review">
                  <div className="plugin-permission-publisher">
                    <CheckCircle2 aria-hidden="true" />
                    <span>
                      {permissionReview.plugin.publisher ??
                        t('plugins.permissionEvidenceUnavailable')}
                    </span>
                    <small>{t('plugins.permissionPublisher')}</small>
                  </div>
                  {permissionReview.intent === 'update' ||
                  permissionReview.intent === 'replace' ? (
                    <strong className="plugin-permission-delta-title">
                      {t('plugins.permissionDelta')}
                    </strong>
                  ) : null}
                  <div className="plugin-permission-list">
                    {permissionReview.permissions.map((permission) => (
                      <div
                        className="plugin-permission-item"
                        key={permission.id}
                      >
                        {permission.optional ? (
                          <CheckboxInput
                            label={permission.reason}
                            description={t(
                              'plugins.permissionOptionalDescription'
                            )}
                            value={selectedPermissionIds.has(permission.id)}
                            isOptional
                            size="sm"
                            onChange={(checked) => {
                              setSelectedPermissionIds((current) => {
                                const next = new Set(current);
                                if (checked) next.add(permission.id);
                                else next.delete(permission.id);
                                return next;
                              });
                            }}
                          />
                        ) : (
                          <>
                            <CheckCircle2 aria-hidden="true" />
                            <span>
                              <strong>
                                {t(
                                  `plugins.permissionCapability.${permission.capability}`
                                )}
                              </strong>
                              <small>{permission.reason}</small>
                            </span>
                            <em>{t('plugins.permissionRequired')}</em>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                  {permissionReview.permissions.some(
                    (permission) => permission.trustTier === 'trusted_native'
                  ) ? (
                    <div className="plugin-native-runtime-consent">
                      <strong>
                        {t('plugins.trustedNativeRuntimeTitle', {
                          runtime: runtimeDisplayName(
                            permissionReview.plugin.runtimes[0]?.id ?? 'Runtime'
                          ),
                        })}
                      </strong>
                      <p>{t('plugins.trustedNativeDescription')}</p>
                      <CheckboxInput
                        label={t('plugins.trustedNativeAcknowledgement', {
                          runtime: runtimeDisplayName(
                            permissionReview.plugin.runtimes[0]?.id ?? 'Runtime'
                          ),
                        })}
                        value={trustedNativeAcknowledged}
                        size="sm"
                        onChange={setTrustedNativeAcknowledged}
                      />
                    </div>
                  ) : null}
                  <details className="plugin-permission-evidence">
                    <summary>
                      {t('plugins.permissionTechnicalEvidence')}
                    </summary>
                    <dl>
                      <div>
                        <dt>{t('plugins.permissionPublisher')}</dt>
                        <dd>
                          {permissionReview.plugin.publisher ??
                            t('plugins.permissionEvidenceUnavailable')}
                        </dd>
                      </div>
                      <div>
                        <dt>{t('plugins.permissionPackageDigest')}</dt>
                        <dd>
                          <code>
                            {(permissionReview.intent === 'update' ||
                            permissionReview.intent === 'replace'
                              ? permissionReview.plugin.updatePackageDigest
                              : permissionReview.plugin.packageDigest) ??
                              t('plugins.permissionEvidenceUnavailable')}
                          </code>
                        </dd>
                      </div>
                    </dl>
                  </details>
                </div>
              ) : null}
            </AstryxLayoutContent>
          }
          footer={
            <AstryxLayoutFooter hasDivider padding={3}>
              <div className="plugin-permission-actions">
                <AstryxButton
                  label={t('common:cancel')}
                  variant="secondary"
                  onClick={() => setPermissionReview(null)}
                />
                <AstryxButton
                  label={t(
                    permissionReview?.intent === 'update' ||
                      permissionReview?.intent === 'replace'
                      ? 'plugins.reviewAndUpdate'
                      : permissionReview?.intent === 'enable' &&
                          permissionReview.permissions.some(
                            (permission) =>
                              permission.trustTier === 'trusted_native'
                          ) &&
                          (permissionReview?.plugin.runtimes.length ?? 0) > 0
                        ? 'plugins.grantInstallAndEnable'
                        : 'plugins.grantAndEnable'
                  )}
                  variant="primary"
                  isLoading={busy}
                  isDisabled={
                    !canWrite ||
                    (permissionReview?.permissions.some(
                      (permission) => permission.trustTier === 'trusted_native'
                    ) === true &&
                      !trustedNativeAcknowledged)
                  }
                  onClick={() => void confirmPermissionReview()}
                />
              </div>
            </AstryxLayoutFooter>
          }
        />
      </AstryxDialog>

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
