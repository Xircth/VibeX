import {
  configuredBackendTransport,
  type BackendTransport,
} from '@/lib/backendTransport';
import type {
  OfficeComponentReadiness,
  OfficePluginAction,
} from 'shared/types';
import type { LocalSkill } from './misc';

export type PluginComponentStatus = OfficeComponentReadiness['status'];
export type PluginActionCatalog = { actions: OfficePluginAction[] };

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
  kind: 'action' | 'command';
}

export interface PluginControlItem {
  id: string;
  name: string;
  version: string;
  description: string | null;
  enabled: boolean;
  builtin: boolean;
  shellTrusted: boolean;
  sourceKind: string;
  sourcePath: string;
  formats: string[];
  skills: PluginControlSkill[];
  runtimes: PluginControlRuntimeContribution[];
  warnings: PluginControlWarning[];
  mcpCount?: number;
  mcpServers?: string[];
  invocationCount?: number;
  invocations?: PluginControlInvocation[];
  nativeManaged?: boolean;
  enableSupported?: boolean;
  updateSupported?: boolean;
  uninstallSupported?: boolean;
}

export interface PluginRuntimeInventoryItem {
  id: string;
  version: string;
  executablePath: string;
  installer: string;
  probe: string[];
  referencedPlugins: string[];
}

export interface PluginRuntimeConflict {
  runtimeId: string;
  currentVersion: string;
  targetVersion: string;
  affectedPlugins: string[];
  affectedAutomations: string[];
}

export interface PluginControlCatalog {
  plugins: PluginControlItem[];
  runtimes: PluginRuntimeInventoryItem[];
}

export interface PluginImportPreview {
  plugin: PluginControlItem;
  conflict: null | {
    pluginId: string;
    installedSource: string;
    incomingSource: string;
  };
}

export type PluginImportPackageKind = 'codex' | 'vibex';

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

export function createPluginApi(transport: BackendTransport) {
  return {
    catalog: () =>
      transport.call('plugin_action_catalog') as Promise<PluginActionCatalog>,
    installOffice: (taskId: string) =>
      transport.call('officecli_install', { taskId }),
    cancelOfficeInstall: (taskId: string) =>
      transport.call('officecli_cancel_install', { taskId }),
    setOfficeEnabled: (enabled: boolean, taskId: string) =>
      transport.call('office_plugin_set_enabled', { enabled, taskId }),
    configureSkills: (params: {
      pluginId: string;
      apps: string[];
      allAgents: boolean;
      link: boolean;
    }) =>
      transport.call('plugin_skills_configure', params) as Promise<
        LocalSkill[]
      >,
  };
}

export function createPluginControlApi(transport: BackendTransport) {
  return {
    catalog: () =>
      transport.call('plugin_control_catalog') as Promise<PluginControlCatalog>,
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
      packageKind?: PluginImportPackageKind
    ) =>
      transport.call('plugin_control_import', {
        path,
        developerLink,
        conflictDecision,
        packageKind,
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
    update: (pluginId: string) =>
      transport.call('plugin_control_update', {
        pluginId,
      }) as Promise<PluginControlItem>,
    setShellTrust: (pluginId: string, trusted: boolean) =>
      transport.call('plugin_control_set_shell_trust', {
        pluginId,
        trusted,
      }),
    previewRuntimeInstall: (pluginId: string, runtimeId: string) =>
      transport.call('plugin_control_preview_runtime_install', {
        pluginId,
        runtimeId,
      }) as Promise<PluginRuntimeConflict | null>,
    installRuntime: (
      pluginId: string,
      runtimeId: string,
      confirmConflict: boolean
    ) =>
      transport.call('plugin_control_install_runtime', {
        pluginId,
        runtimeId,
        confirmConflict,
      }) as Promise<PluginRuntimeInventoryItem>,
    uninstall: (pluginId: string) =>
      transport.call('plugin_control_uninstall', { pluginId }),
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
  };
}

export const pluginV2Api = createPluginApi(configuredBackendTransport);
export const pluginControlApi = createPluginControlApi(
  configuredBackendTransport
);
