import { describe, expect, it } from 'vitest';
import type { AgentManagementView, AgentRegistryViewRow } from 'shared/types';

import {
  buildOnboardingAgentOptions,
  onboardingAgentStatus,
} from './onboardingAgentModel';

function managed(
  overrides: Partial<AgentManagementView> &
    Pick<AgentManagementView, 'agent_id' | 'display_name'>
): AgentManagementView {
  return {
    description: '',
    icon_light: null,
    icon_dark: null,
    icon_svg: null,
    source: 'built_in_profile',
    built_in: true,
    retired: false,
    enabled: true,
    position: 0,
    lifecycle: 'uninstalled',
    authentication: 'not_logged_in',
    runtime_version: null,
    acp_version: null,
    active_operation: null,
    rollback_available: false,
    ...overrides,
  };
}

function registry(
  overrides: Partial<AgentRegistryViewRow> &
    Pick<AgentRegistryViewRow, 'agent_id' | 'display_name'>
): AgentRegistryViewRow {
  return {
    registry_id: overrides.agent_id,
    description: '',
    authors: [],
    version: '1.0.0',
    icon_light: null,
    icon_dark: null,
    icon_svg: null,
    built_in: false,
    added: false,
    installed: false,
    platform_supported: true,
    ...overrides,
  };
}

describe('onboarding Agent model', () => {
  it('requires a complete passing preflight and separates missing auth from broken installations', () => {
    const [option] = buildOnboardingAgentOptions(
      [
        managed({
          agent_id: 'codex',
          display_name: 'Codex',
          lifecycle: 'ready',
          acp_version: '1',
        }),
      ],
      []
    );
    const report = {
      agent_id: 'codex',
      checked_at: '',
      items: [
        {
          id: 'acp',
          status: 'pass',
          label: 'ACP',
          detail: '',
          repairable: false,
          version: null,
          path: null,
          source: null,
          update_available: false,
          available_version: null,
          update_group: null,
        },
        {
          id: 'authentication',
          status: 'pass',
          label: 'Auth',
          detail: '',
          repairable: false,
          version: null,
          path: null,
          source: null,
          update_available: false,
          available_version: null,
          update_group: null,
        },
      ],
    } satisfies import('shared/types').AgentPreflightView;
    expect(onboardingAgentStatus(option)).toBe('checking');
    expect(onboardingAgentStatus(option, { report })).toBe('ready');
    expect(
      onboardingAgentStatus(option, { report: { ...report, items: [] } })
    ).toBe('check_failed');
    const noAuth = {
      ...report,
      items: report.items.map((item) =>
        item.id === 'authentication'
          ? { ...item, status: 'fail' as const }
          : item
      ),
    };
    expect(onboardingAgentStatus(option, { report: noAuth })).toBe(
      'needs_auth'
    );
    const missingAcp = {
      ...noAuth,
      items: noAuth.items.map((item) =>
        item.id === 'acp' ? { ...item, status: 'fail' as const } : item
      ),
    };
    expect(onboardingAgentStatus(option, { report: missingAcp })).toBe(
      'uninstalled'
    );
    expect(
      onboardingAgentStatus(
        { ...option, lifecycle: 'needs_repair' },
        { report: missingAcp }
      )
    ).toBe('uninstalled');
    expect(
      onboardingAgentStatus(option, { report, installationFailed: true })
    ).toBe('install_failed');
    expect(
      onboardingAgentStatus({
        ...option,
        needsInstallation: true,
        lifecycle: 'uninstalled',
      })
    ).toBe('uninstalled');
  });
  it('keeps platform-unsupported built-in Agents visible with their status', () => {
    const options = buildOnboardingAgentOptions(
      [
        managed({
          agent_id: 'cursor',
          display_name: 'Cursor',
          lifecycle: 'platform_unsupported',
        }),
      ],
      [
        registry({
          agent_id: 'cursor',
          display_name: 'Cursor',
          built_in: true,
          platform_supported: false,
        }),
      ]
    );
    expect(options).toEqual([
      expect.objectContaining({
        agentId: 'cursor',
        platformSupported: false,
        lifecycle: 'platform_unsupported',
      }),
    ]);
  });
  it('puts installed Agents first and preserves product order within each group', () => {
    const options = buildOnboardingAgentOptions(
      [
        managed({
          agent_id: 'claude_code',
          display_name: 'Claude Code',
        }),
        managed({
          agent_id: 'codex',
          display_name: 'Codex',
          acp_version: '1.7.0',
          lifecycle: 'needs_repair',
        }),
        managed({
          agent_id: 'opencode',
          display_name: 'OpenCode',
          lifecycle: 'needs_auth',
        }),
        managed({ agent_id: 'pi', display_name: 'Pi' }),
      ],
      [
        registry({
          agent_id: 'kimi',
          display_name: 'Kimi',
          installed: true,
          added: true,
        }),
        registry({ agent_id: 'cursor', display_name: 'Cursor' }),
      ]
    );

    expect(options.map((option) => option.agentId)).toEqual([
      'codex',
      'opencode',
      'kimi',
      'claude_code',
      'pi',
      'cursor',
    ]);
    expect(options[0]).toMatchObject({
      recommended: true,
      runtimeInstalled: true,
      needsInstallation: false,
      builtIn: true,
    });
    expect(options.slice(0, 3).every((option) => option.runtimeInstalled)).toBe(
      true
    );
    expect(options.slice(3).every((option) => !option.runtimeInstalled)).toBe(
      true
    );
  });

  it('treats an ACP adapter as installed even without a vendor CLI', () => {
    const options = buildOnboardingAgentOptions(
      [
        managed({
          agent_id: 'claude_code',
          display_name: 'Claude Code',
          acp_version: '0.69.0',
        }),
        managed({ agent_id: 'codex', display_name: 'Codex' }),
      ],
      []
    );

    expect(options.map((option) => option.agentId)).toEqual([
      'claude_code',
      'codex',
    ]);
    expect(options[0]).toMatchObject({
      agentId: 'claude_code',
      runtimeInstalled: true,
      needsInstallation: false,
    });
    expect(options[1]).toMatchObject({
      agentId: 'codex',
      runtimeInstalled: false,
      needsInstallation: true,
    });
  });

  it('treats a discovered vendor CLI as present and still installs the ACP adapter', () => {
    const options = buildOnboardingAgentOptions(
      [
        managed({
          agent_id: 'claude_code',
          display_name: 'Claude Code',
          local_runtime: {
            path: 'C:\\Users\\developer\\AppData\\Roaming\\npm\\claude.cmd',
            version: '2.1.173 (Claude Code)',
          },
        }),
        managed({ agent_id: 'codex', display_name: 'Codex' }),
      ],
      []
    );

    expect(options.map((option) => option.agentId)).toEqual([
      'claude_code',
      'codex',
    ]);
    expect(options[0]).toMatchObject({
      agentId: 'claude_code',
      runtimeInstalled: true,
      needsInstallation: true,
    });
    expect(options[1]).toMatchObject({
      agentId: 'codex',
      runtimeInstalled: false,
      needsInstallation: true,
    });
  });

  it('treats a desktop client as present and still installs the ACP adapter', () => {
    const options = buildOnboardingAgentOptions(
      [
        managed({
          agent_id: 'codex',
          display_name: 'Codex',
          desktop_client: {
            path: 'C:\\Users\\developer\\AppData\\Local\\Programs\\ChatGPT\\ChatGPT.exe',
            version: null,
          },
        }),
      ],
      []
    );

    expect(options[0]).toMatchObject({
      agentId: 'codex',
      runtimeInstalled: true,
      needsInstallation: true,
    });
  });

  it('skips another install when an ACP adapter is already present', () => {
    const options = buildOnboardingAgentOptions(
      [
        managed({
          agent_id: 'claude_code',
          display_name: 'Claude Code',
          acp_version: '0.69.0',
        }),
      ],
      []
    );

    expect(options[0]).toMatchObject({
      runtimeInstalled: true,
      needsInstallation: false,
    });
  });
});
