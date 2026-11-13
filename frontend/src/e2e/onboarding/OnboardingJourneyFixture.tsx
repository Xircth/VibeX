import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HotkeysProvider } from 'react-hotkeys-hook';
import { BrowserRouter } from 'react-router-dom';
import { bindExternalStoreHook } from '@vibex/plugin-sdk';
import {
  EditorType,
  ThemeMode,
  type AgentManagementView,
  type Project,
} from 'shared/types';
import { ThemeProvider } from '@/components/ThemeProvider';
import { LegacyDesignScope } from '@/components/legacy-design/LegacyDesignScope';
import { FirstRunExperience } from '@/components/onboarding/FirstRunExperience';
import {
  configureBackendTransport,
  type BackendTransport,
} from '@/lib/backendTransport';
import '@/i18n';

// Production components over an isolated Host boundary. All records are fixtures.
bindExternalStoreHook(React.useSyncExternalStore);
const names = {
  claude_code: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  antigravity: 'Antigravity',
  openclaw: 'OpenClaw',
  cline: 'Cline',
  hermes: 'Hermes',
  codebuddy: 'CodeBuddy',
  kimi_code: 'Kimi Code',
  pi: 'Pi',
  grok: 'Grok',
  cursor: 'Cursor',
  deepseek_harness: 'DeepSeek',
  qoder: 'Qoder',
  kiro: 'Kiro CLI',
  auggie: 'Auggie',
  trae: 'TRAE CLI',
  command_code: 'Command Code',
  zcode: 'ZCode',
  omp: 'OMP',
  mimo_code: 'MiMo Code',
};
const agents: AgentManagementView[] = Object.entries(names).map(
  ([id, name], position) => ({
    agent_id: id,
    display_name: name,
    description: `${name} · Agent fixture`,
    source: 'built_in_profile',
    built_in: true,
    retired: false,
    enabled: id === 'codex',
    position,
    lifecycle:
      id === 'codex'
        ? 'ready'
        : id === 'claude_code'
          ? 'needs_auth'
          : id === 'kiro'
            ? 'platform_unsupported'
            : 'uninstalled',
    authentication: id === 'codex' ? 'account' : 'not_logged_in',
    runtime_version: id === 'codex' ? '0.56.0' : null,
    acp_version: id === 'codex' || id === 'claude_code' ? '1.0.0' : null,
    icon_light: null,
    icon_dark: null,
    icon_svg: null,
    active_operation: null,
    rollback_available: false,
    settings_features: ['authentication_mode'],
  })
);
function project(id: string, name: string, home = false): Project {
  return {
    id,
    name,
    root_path: home ? 'C:/Users/Test' : `C:/Projects/${name}`,
    parent_project_id: null,
    hidden: false,
    is_home: home,
    is_git: !home,
    default_agent_working_dir: null,
    default_main_branch: null,
    created_at: new Date(0),
    updated_at: new Date(0),
  };
}
const projects = [
  project('home', 'Global', true),
  project('website', 'Website'),
];
const listeners = new Map<string, Set<(value: unknown) => void>>();
function emit(event: string, value: unknown) {
  listeners.get(event)?.forEach((handler) => handler(value));
}
let imported = false;
let sequence = 0;
let job: unknown = { status: 'idle', progress: null, result: null, log: [] };
const transport: BackendTransport = {
  environment: 'web',
  async listen<T>(event: string, handler: (value: T) => void) {
    const adapted = (value: unknown) => handler(value as T);
    const set = listeners.get(event) ?? new Set();
    set.add(adapted);
    listeners.set(event, set);
    return () => {
      set.delete(adapted);
    };
  },
  async call(command, args = {}) {
    const id = String(args.agentId ?? 'codex');
    if (
      command === 'agent_management_bar' ||
      command === 'agent_management_refresh'
    )
      return [...agents];
    if (command === 'agent_management_discovery_progress')
      return {
        phase: 'complete',
        completed: 21,
        total: 21,
        found: 2,
        checked_agent_ids: Object.keys(names),
        timed_out: false,
      };
    if (
      command === 'agent_registry_view' ||
      command === 'agent_registry_refresh'
    )
      return {
        snapshot_id: 'fixture',
        fetched_at: new Date().toISOString(),
        fresh: true,
        refresh_error: null,
        installed: [],
        uninstalled: [
          {
            agent_id: 'fixture_extra',
            registry_id: 'fixture-extra',
            display_name: 'Example ACP Agent',
            description: 'Registry test entry',
            authors: ['Fixture'],
            version: '1.0.0',
            icon_light: null,
            icon_dark: null,
            icon_svg: null,
            built_in: false,
            added: false,
            installed: false,
            platform_supported: true,
          },
        ],
      };
    if (command === 'agent_management_config_read')
      return {
        agent_id: id,
        available: true,
        fields: [],
        files: [],
        settings_features: ['authentication_mode'],
      };
    if (command === 'agent_management_actions')
      return { agent_id: id, actions: [] };
    if (command === 'agent_management_environment')
      return { agent_id: id, revision: '0', entries: [] };
    if (command === 'agent_management_account_flow')
      return {
        agent_id: id,
        action_id: null,
        status: 'idle',
        exit_code: null,
        authentication: null,
      };
    if (command === 'agent_auth_mode')
      return {
        agent_id: id,
        mode: 'chatgpt_subscription',
        modes: ['chatgpt_subscription', 'api_key'],
        options: [
          {
            value: 'chatgpt_subscription',
            kind: 'subscription',
            label_key: 'agents.authModeChatGpt',
            description_key: 'agents.authDescCodexSubscription',
            credential_env: null,
            native_config_field_id: null,
            credential_required: false,
          },
          {
            value: 'api_key',
            kind: 'official_api',
            label_key: 'agents.authModeOpenAiKey',
            description_key: 'agents.authDescCodexKey',
            credential_env: 'OPENAI_API_KEY',
            native_config_field_id: 'openai_api_key',
            credential_required: true,
          },
        ],
        credential_env: 'OPENAI_API_KEY',
        credential_present: false,
        account_label: id === 'codex' ? 'demo@example.com' : undefined,
      };
    if (command === 'agent_management_preflight')
      return {
        agent_id: id,
        checked_at: new Date().toISOString(),
        items: [
          {
            id: 'acp',
            label: 'ACP',
            status: 'pass',
            detail: 'Fixture handshake passed',
            version: '1.0.0',
            path: null,
            source: null,
            repairable: false,
            update_available: false,
            available_version: null,
            update_group: null,
          },
        ],
      };
    if (command === 'agent_management_set_enabled') {
      const agent = agents.find((item) => item.agent_id === id);
      if (agent) agent.enabled = Boolean(args.enabled);
      return agent;
    }
    if (command === 'agent_management_reorder') return agents;
    if (
      command === 'agent_registry_add_and_install' ||
      command === 'agent_management_repair'
    ) {
      const operationId = `fixture-install-${id}`;
      const agent = agents.find((item) => item.agent_id === id);
      if (agent) agent.lifecycle = 'installing';
      window.setTimeout(() => {
        if (agent) {
          agent.lifecycle = 'needs_auth';
          agent.acp_version = '1.0.0';
        }
        emit('agent-management-event', {
          operation_id: operationId,
          agent_id: id,
          kind: 'install',
          status: 'succeeded',
          stage: 'complete',
          progress_percent: 100,
          message: 'Fixture install completed',
          sequence: ++sequence,
        });
        emit('agent-management-snapshot-invalidated', null);
      }, 100);
      return {
        operation_id: operationId,
        agent_id: id,
        kind: 'install',
        status: 'queued',
      };
    }
    if (command === 'get_projects') return [...projects];
    if (command === 'create_project') {
      const payload = args.payload as { name: string };
      const created = project('imported', payload.name);
      if (!projects.some((item) => item.id === created.id))
        projects.push(created);
      return created;
    }
    if (command === 'agent_scan_local_history')
      return {
        folders:
          id === 'codex'
            ? [
                {
                  path: 'C:/Projects/VibeX',
                  name: 'VibeX',
                  project_id: projects.some((item) => item.id === 'imported')
                    ? 'imported'
                    : null,
                  project_name: null,
                  workspace_id: projects.some((item) => item.id === 'imported')
                    ? 'workspace-imported'
                    : null,
                  sessions: [
                    {
                      agent_id: 'codex',
                      external_session_id: 'fixture-session',
                      title: 'Build the new onboarding',
                      workspace_path: 'C:/Projects/VibeX',
                      message_count: 12,
                      updated_at: new Date().toISOString(),
                      status: imported ? 'imported' : 'new',
                    },
                  ],
                },
              ]
            : [],
        destinations: projects.map((item) => ({
          project_id: item.id,
          project_name: item.name,
          workspace_id:
            item.id === 'imported'
              ? 'workspace-imported'
              : `workspace-${item.id}`,
          workspace_name: item.name,
        })),
        total_sessions: id === 'codex' ? 1 : 0,
        importable_count: imported || id !== 'codex' ? 0 : 1,
      };
    if (command === 'agent_local_history_import_snapshot') return job;
    if (command === 'agent_import_local_history_batch') {
      job = { status: 'running', progress: null, result: null, log: [] };
      window.setTimeout(() => {
        imported = true;
        job = {
          status: 'completed',
          progress: null,
          result: {
            imported: 1,
            skipped: 0,
            failed: 0,
            conversation_ids: ['fixture-conversation'],
            errors: [],
          },
          log: [],
        };
        emit('local-history-import-progress', job);
      }, 200);
      return job;
    }
    if (command === 'read_desktop_shared_preferences') return {};
    throw new Error(`Unsupported onboarding fixture command: ${command}`);
  },
};
configureBackendTransport(transport);
const dark = new URLSearchParams(location.search).get('theme') === 'dark';
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={new QueryClient()}>
      <BrowserRouter>
        <HotkeysProvider>
          <ThemeProvider initialTheme={dark ? ThemeMode.DARK : ThemeMode.LIGHT}>
            <LegacyDesignScope>
              <FirstRunExperience
                open
                initialDefaultAgentId="codex"
                initialEditor={{
                  editor_type: EditorType.FILE_MANAGER,
                  custom_command: null,
                  remote_ssh_host: null,
                  remote_ssh_user: null,
                }}
                onPersist={async () => undefined}
                onFinish={async (ids) => {
                  document.title = `Onboarding finished: ${ids?.join(',')}`;
                }}
              />
            </LegacyDesignScope>
          </ThemeProvider>
        </HotkeysProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
);
