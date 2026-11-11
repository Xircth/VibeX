import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EditorType,
  SoundFile,
  ThemeMode,
  type AgentManagementView,
  type Config,
  type Environment,
} from 'shared/types';

import { agentManagementApi } from '@/features/agent-management';
import { configApi, webServiceApi } from '@/lib/api';
import { getBackendTransport } from '@/lib/transport';

import { AccountError, accountApi } from './account';
import {
  ACCOUNT_HOST_CONFIGS_STORAGE_KEY,
  extractPortableUserConfig,
  importHostConfigToCurrentHost,
  mergePortableUserConfigOntoTarget,
  removeSavedAccountHostConfig,
  resetAccountHostConfigsForTests,
  syncAccountHostConfigs,
  type AccountHostConfigSnapshot,
} from './accountHostConfigs';

vi.mock('@/lib/transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/transport')>();
  return {
    ...actual,
    getBackendTransport: vi.fn(() => ({
      environment: 'desktop' as const,
      call: vi.fn(),
      listen: vi.fn(async () => () => {}),
    })),
  };
});

function makeEnvironment(overrides: Partial<Environment> = {}): Environment {
  return {
    os_type: 'Windows',
    os_version: '11',
    os_architecture: 'x86_64',
    bitness: '64-bit',
    ...overrides,
  };
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    config_version: 'v8',
    theme: ThemeMode.DARK,
    executor_profile: {
      executor: 'CLAUDE_CODE',
      variant: null,
      model: null,
      fast_mode: null,
    },
    disclaimer_acknowledged: true,
    onboarding_acknowledged: true,
    notifications: {
      sound_enabled: true,
      push_enabled: true,
      sound_file: SoundFile.ABSTRACT_SOUND1,
      notify_when: 'unfocused',
    },
    editor: {
      editor_type: EditorType.VS_CODE,
      custom_command: 'C:\\Tools\\editor.exe',
      remote_ssh_host: null,
      remote_ssh_user: null,
    },
    github: {
      pat: 'ghp_secret_local_token',
      oauth_token: 'gho_secret_oauth',
      username: 'local-gh-user',
      primary_email: 'local@example.com',
      default_pr_base: 'main',
    },
    workspace_dir: 'C:\\Users\\local\\workspaces',
    last_app_version: '0.4.4',
    show_release_notes: true,
    language: 'ZH_HANS',
    git_branch_prefix: 'feat/',
    pr_auto_description_enabled: false,
    pr_auto_description_prompt: null,
    pr_auto_description_agent_id: '',
    pr_auto_description_mode: null,
    pr_auto_description_session_config: {},
    commit_reminder_enabled: false,
    commit_reminder_mode: 'smart',
    commit_reminder_line_threshold: 200,
    send_message_shortcut: 'Enter',
    prompt_enhancement_enabled: false,
    prompt_enhancement_model: '',
    prompt_enhancement_agent_id: '',
    prompt_enhancement_mode: null,
    prompt_enhancement_session_config: {},
    prompt_enhancement_prompt: null,
    compact_context_enabled: false,
    default_terminal_shell: 'pwsh.exe',
    files_changed_default_collapsed: false,
    ai_message_default_collapsed: false,
    hide_model_thinking: false,
    previous_session_continuation_enabled: false,
    auto_update_enabled: true,
    crash_reports_enabled: false,
    link_open_behavior: 'ExternalBrowser',
    multi_agent_enabled: true,
    multi_agent_depth_limit: 3,
    multi_agent_completed_cache_max_mb: 128,
    multi_agent_conversation_list_default_days: 7,
    multi_agent_delay_max_hours: 24,
    multi_agent_agent_defaults: {},
    ...overrides,
  };
}

function makeAgent(
  agentId: string,
  displayName: string,
  enabled: boolean,
  position: number,
  builtIn = true
): AgentManagementView {
  return {
    agent_id: agentId,
    display_name: displayName,
    description: `${displayName} agent`,
    icon_light: null,
    icon_dark: null,
    icon_svg: null,
    source: builtIn ? 'built_in_profile' : 'official_registry',
    built_in: builtIn,
    retired: false,
    enabled,
    position,
    lifecycle: 'ready',
    authentication: 'not_required',
    runtime_version: '1.0.0',
    acp_version: '1.0.0',
    active_operation: null,
    rollback_available: false,
  };
}

describe('accountHostConfigs', () => {
  const testUser = {
    displayName: '谢麟阁',
    username: 'xielinge',
    email: 'xielinge@vibex.dev',
  };

  beforeEach(() => {
    window.localStorage.clear();
    resetAccountHostConfigsForTests();
    vi.restoreAllMocks();
    vi.mocked(getBackendTransport).mockReturnValue({
      environment: 'desktop',
      call: vi.fn(),
      listen: vi.fn(async () => () => {}),
    });
  });

  it('strips non-portable credentials/paths and protects OS-specific shell/editor paths across OSes', () => {
    const macConfig = makeConfig({
      theme: ThemeMode.LIGHT,
      send_message_shortcut: 'ModifierEnter',
      compact_context_enabled: true,
      default_terminal_shell: '/bin/zsh',
      editor: {
        editor_type: EditorType.CUSTOM,
        custom_command: '/Applications/Zed.app/Contents/MacOS/cli',
        remote_ssh_host: null,
        remote_ssh_user: null,
      },
      workspace_dir: '/Users/alice/projects',
    });

    const portable = extractPortableUserConfig(macConfig);
    expect('workspace_dir' in portable).toBe(false);
    expect('github' in portable).toBe(false);
    expect('config_version' in portable).toBe(false);
    expect(portable.send_message_shortcut).toBe('ModifierEnter');
    expect(portable.compact_context_enabled).toBe(true);

    const windowsTarget = makeConfig({
      theme: ThemeMode.DARK,
      default_terminal_shell: 'pwsh.exe',
      workspace_dir: 'D:\\VibeXWorktrees',
    });
    const mergedCrossOs = mergePortableUserConfigOntoTarget({
      targetConfig: windowsTarget,
      targetEnvironment: makeEnvironment({ os_type: 'Windows' }),
      sourceUserConfig: portable,
      sourceOsType: 'macOS',
    });

    expect(mergedCrossOs.theme).toBe(ThemeMode.LIGHT);
    expect(mergedCrossOs.send_message_shortcut).toBe('ModifierEnter');
    expect(mergedCrossOs.compact_context_enabled).toBe(true);
    // Preserves target Host's local workspace_dir, github credentials, and Windows shell/custom binary path
    expect(mergedCrossOs.workspace_dir).toBe('D:\\VibeXWorktrees');
    expect(mergedCrossOs.github.pat).toBe('ghp_secret_local_token');
    expect(mergedCrossOs.default_terminal_shell).toBe('pwsh.exe');
    expect(mergedCrossOs.editor.editor_type).toBe(EditorType.CUSTOM);
    expect(mergedCrossOs.editor.custom_command).toBe('C:\\Tools\\editor.exe');

    // Same-OS migration applies default_terminal_shell and custom_command directly
    const mergedSameOs = mergePortableUserConfigOntoTarget({
      targetConfig: windowsTarget,
      targetEnvironment: makeEnvironment({ os_type: 'macOS' }),
      sourceUserConfig: portable,
      sourceOsType: 'macOS',
    });
    expect(mergedSameOs.default_terminal_shell).toBe('/bin/zsh');
    expect(mergedSameOs.editor.custom_command).toBe(
      '/Applications/Zed.app/Contents/MacOS/cli'
    );
  });

  it('automatically associates current Host settings and Agent enablement on login and merges remote snapshots', async () => {
    window.localStorage.setItem('vibex:ui-zoom', '1.15');
    window.localStorage.setItem('vibex:accent-color', 'indigo');
    window.localStorage.setItem(
      'vibex:kanban-canvas',
      JSON.stringify({ viewport: { x: 40, y: 80 } })
    );

    vi.spyOn(webServiceApi, 'getStatus').mockResolvedValue({
      running: false,
      port: 17891,
      address: null,
      token_configured: false,
      started_at: null,
      message: null,
      host_id: 'win-workstation-01',
    });

    vi.spyOn(configApi, 'getConfig').mockResolvedValue({
      config: makeConfig({ hide_model_thinking: true }),
      environment: makeEnvironment({
        os_type: 'Windows',
        os_architecture: 'x86_64',
      }),
      capabilities: {},
      executors: {},
    });

    vi.spyOn(agentManagementApi, 'bar').mockResolvedValue([
      makeAgent('CLAUDE_CODE', 'Claude Code', true, 0),
      makeAgent('CODEX', 'Codex', true, 1),
      makeAgent('GEMINI', 'Gemini CLI', false, 2),
    ]);

    const macBookSnapshot: AccountHostConfigSnapshot = {
      schemaVersion: 1,
      accountKey: 'xielinge',
      hostId: 'host:macbook-pro-m4',
      hostName: 'MacBook Pro M4',
      kind: 'ssh',
      osType: 'macOS',
      osArch: 'aarch64',
      updatedAt: '2026-11-10T10:00:00.000Z',
      fingerprint: 'v1_macbook',
      vibeXSettings: {
        userConfig: { send_message_shortcut: 'ModifierEnter' },
        frontendPreferences: { ui_zoom: 1.25 },
      },
      agents: [
        {
          agentId: 'CLAUDE_CODE',
          displayName: 'Claude Code',
          enabled: true,
          position: 0,
          builtIn: true,
        },
      ],
    };

    const listCloudSpy = vi
      .spyOn(accountApi, 'listHostConfigs')
      .mockResolvedValue({ hosts: [macBookSnapshot] });
    const saveCloudSpy = vi
      .spyOn(accountApi, 'saveHostConfig')
      .mockRejectedValue(new AccountError('unsupported'));

    const synced = await syncAccountHostConfigs(testUser);

    expect(listCloudSpy).toHaveBeenCalledTimes(1);
    expect(saveCloudSpy).toHaveBeenCalledTimes(1);
    expect(synced).toHaveLength(2);
    expect(synced[0]?.hostId).toBe('host:win-workstation-01');
    expect(synced[0]?.vibeXSettings.userConfig.hide_model_thinking).toBe(true);
    expect('github' in (synced[0]?.vibeXSettings.userConfig ?? {})).toBe(false);
    expect(synced[0]?.vibeXSettings.frontendPreferences.ui_zoom).toBe(1.15);
    expect(synced[0]?.vibeXSettings.frontendPreferences.accent_color).toBe(
      'indigo'
    );
    // Project-transient kanban_canvas is excluded
    expect(
      'kanban_canvas' in (synced[0]?.vibeXSettings.frontendPreferences ?? {})
    ).toBe(false);
    expect(synced[0]?.agents).toEqual([
      expect.objectContaining({ agentId: 'CLAUDE_CODE', enabled: true }),
      expect.objectContaining({ agentId: 'CODEX', enabled: true }),
      expect.objectContaining({ agentId: 'GEMINI', enabled: false }),
    ]);
    expect(synced[1]?.hostId).toBe('host:macbook-pro-m4');

    // Second sync with identical state skips redundant cloud push via fingerprint deduplication
    saveCloudSpy.mockClear();
    await syncAccountHostConfigs(testUser);
    expect(saveCloudSpy).not.toHaveBeenCalled();

    // Removing the other Host records a tombstone so stale cloud snapshots do not resurrect it
    vi.spyOn(accountApi, 'deleteHostConfig').mockResolvedValue({ ok: true });
    await removeSavedAccountHostConfig({
      user: testUser,
      hostId: 'host:macbook-pro-m4',
    });
    const afterRemove = await syncAccountHostConfigs(testUser);
    expect(afterRemove.map((h) => h.hostId)).toEqual([
      'host:win-workstation-01',
    ]);
    expect(
      window.localStorage.getItem(ACCOUNT_HOST_CONFIGS_STORAGE_KEY)
    ).toBeTruthy();
  });

  it('imports VibeX settings and Agent enablement/order onto the current Host without failing fast on missing Agents', async () => {
    vi.spyOn(webServiceApi, 'getStatus').mockResolvedValue({
      running: false,
      port: 17891,
      address: null,
      token_configured: false,
      started_at: null,
      message: null,
      host_id: 'target-linux-devbox',
    });

    const currentConfig = makeConfig({
      theme: ThemeMode.DARK,
      send_message_shortcut: 'Enter',
      compact_context_enabled: false,
      workspace_dir: '/home/dev/workspaces',
      default_terminal_shell: '/bin/bash',
    });

    vi.spyOn(configApi, 'getConfig').mockResolvedValue({
      config: currentConfig,
      environment: makeEnvironment({
        os_type: 'Linux',
        os_architecture: 'x86_64',
      }),
      capabilities: {},
      executors: {},
    });
    const saveConfigSpy = vi
      .spyOn(configApi, 'saveConfig')
      .mockImplementation(async (next) => next);

    vi.spyOn(agentManagementApi, 'bar').mockResolvedValue([
      makeAgent('CLAUDE_CODE', 'Claude Code', true, 0),
      makeAgent('CODEX', 'Codex', false, 1),
      makeAgent('GEMINI', 'Gemini CLI', true, 2),
    ]);
    const setEnabledSpy = vi
      .spyOn(agentManagementApi, 'setEnabled')
      .mockImplementation(async (agentId, enabled) =>
        makeAgent(agentId, agentId, enabled, 0)
      );
    const reorderSpy = vi
      .spyOn(agentManagementApi, 'reorder')
      .mockResolvedValue([]);

    vi.spyOn(accountApi, 'listHostConfigs').mockRejectedValue(
      new AccountError('unsupported')
    );
    vi.spyOn(accountApi, 'saveHostConfig').mockRejectedValue(
      new AccountError('unsupported')
    );

    const sourceSnapshot: AccountHostConfigSnapshot = {
      schemaVersion: 1,
      accountKey: 'xielinge',
      hostId: 'host:studio-mac',
      hostName: 'Studio Mac Ultra',
      kind: 'remote',
      osType: 'macOS',
      osArch: 'aarch64',
      updatedAt: '2026-11-11T08:00:00.000Z',
      fingerprint: 'v1_studio_mac',
      vibeXSettings: {
        userConfig: {
          theme: ThemeMode.LIGHT,
          send_message_shortcut: 'ModifierEnter',
          compact_context_enabled: true,
          default_terminal_shell: '/opt/homebrew/bin/fish',
        },
        frontendPreferences: {
          ui_zoom: 1.2,
          mono_font: 'jetbrains-mono',
        },
      },
      agents: [
        {
          agentId: 'CODEX',
          displayName: 'Codex',
          enabled: true,
          position: 0,
          builtIn: true,
        },
        {
          agentId: 'CLAUDE_CODE',
          displayName: 'Claude Code',
          enabled: true,
          position: 1,
          builtIn: true,
        },
        {
          agentId: 'GEMINI',
          displayName: 'Gemini CLI',
          enabled: false,
          position: 2,
          builtIn: true,
        },
        {
          agentId: 'vendor.custom-acp',
          displayName: 'Custom ACP',
          enabled: true,
          position: 3,
          builtIn: false,
        },
      ],
    };

    const result = await importHostConfigToCurrentHost({
      user: testUser,
      source: sourceSnapshot,
      options: {
        includeSettings: true,
        includeAgents: true,
      },
    });

    expect(result).toEqual({
      appliedSettings: true,
      updatedAgentsCount: 2,
      skippedMissingAgentIds: ['vendor.custom-acp'],
      failedAgentIds: [],
    });

    expect(saveConfigSpy).toHaveBeenCalledTimes(1);
    const savedArg = saveConfigSpy.mock.calls[0]?.[0];
    expect(savedArg?.theme).toBe(ThemeMode.LIGHT);
    expect(savedArg?.send_message_shortcut).toBe('ModifierEnter');
    expect(savedArg?.compact_context_enabled).toBe(true);
    expect(savedArg?.workspace_dir).toBe('/home/dev/workspaces');
    expect(savedArg?.default_terminal_shell).toBe('/bin/bash');

    expect(window.localStorage.getItem('vibex:ui-zoom')).toBe('1.2');
    expect(window.localStorage.getItem('vibex:mono-font')).toBe(
      'jetbrains-mono'
    );

    // Only CODEX (false -> true) and GEMINI (true -> false) needed setEnabled calls
    expect(setEnabledSpy).toHaveBeenCalledTimes(2);
    expect(setEnabledSpy).toHaveBeenCalledWith('CODEX', true);
    expect(setEnabledSpy).toHaveBeenCalledWith('GEMINI', false);

    // Bar order updated to match source Host order for installed Agents
    expect(reorderSpy).toHaveBeenCalledWith(['CODEX', 'CLAUDE_CODE', 'GEMINI']);
  });
});
