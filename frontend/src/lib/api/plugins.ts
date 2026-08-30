import {
  configuredBackendTransport,
  type BackendTransport,
} from '@/lib/backendTransport';

export interface PluginControlSkill {
  id: string;
  path: string;
}

export interface PluginControlSkillContent extends PluginControlSkill {
  content: string;
}

export interface PluginControlMcpServer {
  id: string;
  config: unknown;
}

export interface PluginControlContributions {
  skills: PluginControlSkillContent[];
  mcpServers: PluginControlMcpServer[];
}

export interface PluginControlRuntimeContribution {
  id: string;
  command: string;
  version: string | null;
  /** Exact lock evidence. Older hosts omit these fields; the UI stays not-ready. */
  target?: string | null;
  contentDigest?: string | null;
  installer: string;
  installCommand?: string | null;
}

export interface PluginControlWarning {
  code: string;
  message: string;
  contribution: string | null;
}

export interface PluginControlInvocation {
  id: string;
  label: string;
  prompt: string;
  kind: 'action' | 'command' | 'workflow';
}

export interface PluginNativeResource {
  id: string;
  path: string;
}

export interface PluginAppContribution {
  id: string;
  kind: 'file_opener' | 'preview_provider' | 'app_surface';
  label: string;
  metadata: unknown;
}

export interface PluginActionPromptBlock {
  type: string;
  text: string;
}

export interface PluginAction {
  pluginId: string;
  actionId: string;
  workflowId?: string;
  label: string;
  requiredSkills: string[];
  requiredTools: string[];
  promptBlocks: PluginActionPromptBlock[];
  artifactIntent: unknown | null;
}

export interface PluginActionCatalog {
  actions: PluginAction[];
}

export interface PluginControlItem {
  id: string;
  name: string;
  version: string;
  description: string | null;
  enabled: boolean;
  builtin: boolean;
  /** Publisher and digest are optional only for compatibility with pre-v4 hosts. */
  publisher?: string | null;
  packageDigest?: string | null;
  updatePackageDigest?: string | null;
  sourceKind: string;
  sourcePath: string;
  formats: string[];
  skills: PluginControlSkill[];
  runtimes: PluginControlRuntimeContribution[];
  warnings: PluginControlWarning[];
  permissions?: PluginPermission[];
  permissionDelta?: PluginPermission[];
  mcpCount?: number;
  mcpServers?: string[];
  hooks?: PluginNativeResource[];
  workflows?: PluginNativeResource[];
  invocationCount?: number;
  invocations?: PluginControlInvocation[];
  appContributions?: PluginAppContribution[];
  nativeManaged?: boolean;
  enableSupported?: boolean;
  updateSupported?: boolean;
  rollbackSupported?: boolean;
  uninstallSupported?: boolean;
  sourceOrigin?: string | null;
  sourceRef?: string | null;
  sourceSha?: string | null;
  sourceLocked?: boolean;
  sourceShowTree?: boolean | null;
  updateAvailable?: boolean;
  availableTag?: string | null;
}

export interface PluginPermission {
  id: string;
  capability: string;
  scope: unknown;
  reason: string;
  optional: boolean;
  trustTier?: 'sandboxed_worker' | 'trusted_native';
}

export interface PluginRuntimeInventoryItem {
  id: string;
  version: string;
  target: string | null;
  contentDigest: string | null;
  executablePath: string;
  ownership: string | null;
  installer: string;
  probe: string[];
  referencedPlugins: string[];
}

export interface PluginControlCatalog {
  plugins: PluginControlItem[];
  runtimes: PluginRuntimeInventoryItem[];
}

export interface PluginContentDocument {
  path: string;
  kind: string;
  title: string;
  content: string;
}

export interface PluginProductDetail {
  summary: string;
  readme: string;
  contents: PluginContentDocument[];
  config: Record<string, unknown>;
  configSchema: Record<string, unknown>;
}

function normalizePluginControlCatalog(
  catalog: PluginControlCatalog
): PluginControlCatalog {
  return {
    ...catalog,
    runtimes: catalog.runtimes.map((runtime) => ({
      ...runtime,
      target: runtime.target ?? null,
      contentDigest: runtime.contentDigest ?? null,
      ownership: runtime.ownership ?? null,
    })),
  };
}

export type PluginContributionKind =
  | 'skill'
  | 'action'
  | 'command'
  | 'runtime'
  | 'mcp'
  | 'hook'
  | 'file_opener'
  | 'preview_provider'
  | 'app_surface'
  | 'toolbar'
  | 'status'
  | 'composer_slash'
  | 'timeline_card'
  | 'settings_section'
  | 'host_service'
  | 'workflow_binding';

export interface PluginContributionCatalogItem {
  pluginId: string;
  id: string;
  kind: PluginContributionKind;
  label: string;
  generation: number;
  metadata: unknown;
}

export interface PluginContributionCatalog {
  generation: number;
  items: PluginContributionCatalogItem[];
}

export interface PluginDevConnection {
  endpoint: string;
  token: string;
  protocolVersion: '1.0';
}

export interface ResolvedPluginFileOpener {
  pluginId: string;
  contributionId: string;
  label: string;
  handler: string;
  target: 'preview_provider' | 'app_surface';
  priority: number;
  generation: number;
  nativeRenderer?: 'workflow.studio' | 'host.renderer.workflow.studio' | null;
}

export interface PluginFilePreviewStart {
  pluginId: string;
  providerId: string;
  generation: number;
  leaseId: string | null;
  capabilityToken: string | null;
  expiresAtUnixMs: number | null;
  port: number | null;
  previewUrl?: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface PluginImportPreview {
  plugin: PluginControlItem;
  conflict: null | {
    pluginId: string;
    installedSource: string;
    incomingSource: string;
    installedEnabled: boolean;
  };
}

export type PluginImportPackageKind = 'codex' | 'vibex';

export interface CatalogListing {
  owner: string;
  pluginName: string;
  tag: string;
  version: string;
  displayName: string;
  summary: string;
  category: string;
  sourceKind: string;
  homepage?: string | null;
  repo?: string | null;
  packageDigest?: string | null;
  downloadUrl?: string | null;
  sha256?: string | null;
  offlinePluginId?: string | null;
  hasWorker?: boolean;
  hasApp?: boolean;
  hasMcp?: boolean;
  opens?: string[];
  readme?: string | null;
  showTree?: boolean | null;
}

export interface CatalogPluginDetail {
  listing: CatalogListing;
  summary: string;
  readme: string;
  contents: PluginContentDocument[];
}

export interface CatalogPage {
  official: CatalogListing[];
  community: CatalogListing[];
  communityLimit: number;
  query: string;
  remote: boolean;
}

export interface PluginUpdateStatus {
  pluginId: string;
  updateAvailable: boolean;
  availableTag?: string | null;
  availableVersion?: string | null;
}

export type PluginCliImportEcosystem = 'codex' | 'claude_code';

export type PluginCliImportEvent =
  | { event: 'started'; command: string }
  | { event: 'log'; stream: 'stdout' | 'stderr'; line: string }
  | {
      event: 'command_finished';
      command: string;
      success: boolean;
      exitCode: number | null;
    };

export interface PluginCliImportResult {
  success: boolean;
  commandsRun: number;
  importedPluginIds: string[];
}

function pluginFilePath(plugin: PluginControlItem, relativePath: string) {
  const root = plugin.sourcePath.replace(/[\\/]+$/, '');
  const relative = relativePath.replace(/^[\\/]+/, '');
  return `${root}/${relative}`;
}

function isMissingContributionsCommand(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause);
  return /command\s+plugin_control_contributions\s+not found/i.test(message);
}

function mcpServersFrom(value: unknown): PluginControlMcpServer[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  const servers =
    record.mcpServers &&
    typeof record.mcpServers === 'object' &&
    !Array.isArray(record.mcpServers)
      ? (record.mcpServers as Record<string, unknown>)
      : record;
  return Object.entries(servers)
    .map(([id, config]) => ({ id, config }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

async function loadContributionsWithFileApi(
  transport: BackendTransport,
  plugin: PluginControlItem
): Promise<PluginControlContributions> {
  const skills = await Promise.all(
    plugin.skills.map(async (skill) => ({
      ...skill,
      content: (await transport.call('read_file_content', {
        path: pluginFilePath(plugin, skill.path),
      })) as string,
    }))
  );
  if (!plugin.mcpCount) return { skills, mcpServers: [] };

  const native =
    plugin.sourceKind === 'codex_native' ||
    plugin.sourceKind === 'claude_code_native';
  const mcpDocument = JSON.parse(
    (await transport.call('read_file_content', {
      path: pluginFilePath(
        plugin,
        native ? '.mcp.json' : '.vibex-plugin/plugin.json'
      ),
    })) as string
  ) as unknown;
  const mcpValue = native
    ? mcpDocument
    : mcpDocument && typeof mcpDocument === 'object'
      ? (mcpDocument as Record<string, unknown>).mcp
      : undefined;
  return { skills, mcpServers: mcpServersFrom(mcpValue) };
}

export function createPluginControlApi(transport: BackendTransport) {
  return {
    catalog: async () =>
      normalizePluginControlCatalog(
        (await transport.call('plugin_control_catalog')) as PluginControlCatalog
      ),
    contributionCatalog: () =>
      transport.call(
        'plugin_contribution_catalog'
      ) as Promise<PluginContributionCatalog>,
    invokeContribution: (pluginId: string, handler: string, input?: unknown) =>
      transport.call('plugin_invoke_contribution', {
        pluginId,
        handler,
        input: input ?? null,
      }),
    productDetail: (pluginId: string) =>
      transport.call('plugin_product_detail', {
        pluginId,
      }) as Promise<PluginProductDetail>,
    saveConfig: (pluginId: string, config: Record<string, unknown>) =>
      transport.call('plugin_save_config', {
        pluginId,
        config,
      }) as Promise<PluginProductDetail>,
    devConnection: () =>
      transport.call('plugin_dev_connection') as Promise<PluginDevConnection>,
    resolveFileOpener: (extension?: string, mediaType?: string) =>
      transport.call('plugin_resolve_file_opener', {
        extension: extension ?? null,
        mediaType: mediaType ?? null,
      }) as Promise<ResolvedPluginFileOpener | null>,
    openFilePreview: (filePath: string) =>
      transport.call('plugin_open_file_preview', {
        filePath,
      }) as Promise<PluginFilePreviewStart | null>,
    closeFilePreview: (filePath: string, leaseId?: string | null) =>
      transport.call('plugin_close_file_preview', {
        filePath,
        leaseId: leaseId ?? null,
      }),
    contributions: async (plugin: PluginControlItem) => {
      try {
        return (await transport.call('plugin_control_contributions', {
          pluginId: plugin.id,
        })) as PluginControlContributions;
      } catch (cause) {
        if (!isMissingContributionsCommand(cause)) throw cause;
        return loadContributionsWithFileApi(transport, plugin);
      }
    },
    previewImport: (
      path: string,
      developerLink: boolean,
      packageKind?: PluginImportPackageKind
    ) =>
      transport.call('plugin_control_preview_import', {
        path,
        developerLink,
        packageKind,
      }) as Promise<PluginImportPreview>,
    import: (
      path: string,
      developerLink: boolean,
      conflictDecision: 'reject' | 'keep' | 'replace',
      packageKind?: PluginImportPackageKind,
      permissionIds: string[] = []
    ) =>
      transport.call('plugin_control_import', {
        path,
        developerLink,
        conflictDecision,
        packageKind,
        permissionIds,
      }) as Promise<PluginControlItem>,
    importCli: (
      ecosystem: PluginCliImportEcosystem,
      command: string,
      onEvent: (event: PluginCliImportEvent) => void
    ) => {
      if (!transport.stream) {
        return Promise.reject(
          new Error(
            'Streaming plugin import is unavailable in this environment'
          )
        );
      }
      return transport.stream<PluginCliImportResult>(
        'plugin_control_import_cli',
        { ecosystem, command },
        (message) => onEvent(message as PluginCliImportEvent)
      );
    },
    setEnabled: (pluginId: string, enabled: boolean) =>
      transport.call('plugin_control_set_enabled', {
        pluginId,
        enabled,
      }) as Promise<PluginControlItem>,
    rollback: (pluginId: string, permissionIds: string[] = []) =>
      transport.call('plugin_control_rollback', {
        pluginId,
        permissionIds,
      }) as Promise<PluginControlItem>,
    grantPermissions: (pluginId: string, permissionIds: string[]) =>
      transport.call('plugin_control_grant_permissions', {
        pluginId,
        permissionIds,
      }),
    installRuntime: (pluginId: string, runtimeId: string) =>
      transport.call('plugin_control_install_runtime', {
        pluginId,
        runtimeId,
      }) as Promise<PluginRuntimeInventoryItem>,
    configureAgents: (pluginId: string, allAgents: boolean, agents: string[]) =>
      transport.call('plugin_control_configure_agents', {
        pluginId,
        allAgents,
        agents,
      }),
    configureMcp: (pluginId: string, allAgents: boolean, agents: string[]) =>
      transport.call('plugin_control_configure_mcp', {
        pluginId,
        allAgents,
        agents,
      }) as Promise<{ mcpErrors: string[] }>,
    marketplaceIndex: () =>
      transport.call('plugin_marketplace_index') as Promise<{
        listings: Array<{
          publisher: string;
          pluginId: string;
          version: string;
          summary: string;
          packageDigest: string;
          archive: string;
        }>;
      }>,
    marketplaceCatalog: (query?: string) =>
      transport.call('plugin_marketplace_catalog', {
        query: query || null,
      }) as Promise<CatalogPage>,
    marketplaceListing: (owner: string, pluginName: string) =>
      transport.call('plugin_marketplace_listing', {
        owner,
        pluginName,
      }) as Promise<CatalogPluginDetail>,
    marketplaceInstall: (
      owner: string,
      pluginName: string,
      tag?: string,
      conflict: 'reject' | 'keep' | 'replace' = 'reject'
    ) =>
      transport.call('plugin_marketplace_install', {
        owner,
        pluginName,
        tag: tag ?? null,
        conflict,
      }) as Promise<PluginControlItem>,
    checkUpdates: () =>
      transport.call('plugin_check_updates') as Promise<PluginUpdateStatus[]>,
    install: (
      source:
        | { artifactId: string }
        | {
            marketplace: {
              publisher: string;
              id: string;
              version: string;
              digest: string;
            };
          },
      conflict?: 'reject' | 'keep' | 'replace'
    ) =>
      transport.call('plugin_install', {
        source,
        conflict,
      }) as Promise<PluginControlItem>,
    update: (pluginId: string, version?: string, digest?: string) =>
      version || digest
        ? (transport.call('plugin_update', {
            pluginId,
            version: version ?? null,
            digest: digest ?? null,
          }) as Promise<PluginControlItem>)
        : (transport.call('plugin_control_update', {
            pluginId,
          }) as Promise<PluginControlItem>),
    uninstall: (pluginId: string, retainData?: boolean) =>
      retainData === undefined
        ? transport.call('plugin_control_uninstall', { pluginId })
        : transport.call('plugin_uninstall', { pluginId, retainData }),
    gcRuntimes: () =>
      transport.call('plugin_control_gc_runtimes') as Promise<{
        reclaimed: string[];
      }>,
  };
}

/** Public action catalog consumed by composer surfaces. */
export function createPluginApi(transport: BackendTransport) {
  return {
    catalog: async () => {
      try {
        const catalog = (await transport.call('plugin_workflow_catalog')) as {
          workflows?: Array<PluginAction & { workflowId?: string }>;
        };
        if (catalog.workflows) {
          return {
            actions: catalog.workflows.map((workflow) => ({
              ...workflow,
              actionId: workflow.workflowId ?? workflow.actionId,
            })),
          };
        }
      } catch {
        // Hosts that have not registered the workflow catalog still expose
        // the same identities through plugin_action_catalog.
      }
      return transport.call(
        'plugin_action_catalog'
      ) as Promise<PluginActionCatalog>;
    },
  };
}

export const pluginControlApi = createPluginControlApi(
  configuredBackendTransport
);
