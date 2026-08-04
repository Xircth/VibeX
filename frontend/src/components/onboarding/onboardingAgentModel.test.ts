import { describe, expect, it } from 'vitest';
import type { AgentManagementView, AgentRegistryViewRow } from 'shared/types';

import {
  buildOnboardingAgentOptions,
  classifyOnboardingInstallResult,
  normalizeOnboardingAgentSelection,
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
  it('puts the four recommended Agents first in product order', () => {
    const options = buildOnboardingAgentOptions(
      [
        managed({
          agent_id: 'claude_code',
          display_name: 'Claude Code',
        }),
        managed({
          agent_id: 'codex',
          display_name: 'Codex',
          runtime_version: '0.146.0',
          lifecycle: 'needs_repair',
        }),
        managed({ agent_id: 'opencode', display_name: 'OpenCode' }),
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
      'claude_code',
      'codex',
      'opencode',
      'pi',
      'kimi',
      'cursor',
    ]);
    expect(options[0]).toMatchObject({
      recommended: true,
      runtimeInstalled: false,
      needsInstallation: true,
      builtIn: true,
    });
    expect(options.slice(0, 4).every((option) => option.recommended)).toBe(
      true
    );
    expect(options.slice(4).every((option) => !option.recommended)).toBe(true);
  });

  it('keeps the default Agent enabled and chooses a new default when it is disabled', () => {
    expect(
      normalizeOnboardingAgentSelection({
        enabledAgentIds: new Set(['claude_code']),
        defaultAgentId: 'codex',
        changedAgentId: 'codex',
        enabled: true,
      })
    ).toEqual({
      enabledAgentIds: new Set(['claude_code', 'codex']),
      defaultAgentId: 'codex',
    });

    expect(
      normalizeOnboardingAgentSelection({
        enabledAgentIds: new Set(['claude_code', 'codex']),
        defaultAgentId: 'codex',
        changedAgentId: 'codex',
        enabled: false,
      })
    ).toEqual({
      enabledAgentIds: new Set(['claude_code']),
      defaultAgentId: 'claude_code',
    });
  });

  it('separates install success from post-install verification', () => {
    expect(classifyOnboardingInstallResult('succeeded', ['pass', 'pass'])).toBe(
      'verified'
    );
    expect(classifyOnboardingInstallResult('succeeded', ['pass', 'fail'])).toBe(
      'needs_attention'
    );
    expect(classifyOnboardingInstallResult('failed', [])).toBe('failed');
  });
});
