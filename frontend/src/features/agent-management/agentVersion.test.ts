import { describe, expect, it } from 'vitest';
import type { AgentUpdateCheckView } from 'shared/types';

import {
  agentHasAcpUpdate,
  isAgentAcpUpdateCheckable,
  versionIsNewer,
} from './agentVersion';

function check(
  overrides: Partial<AgentUpdateCheckView> = {}
): AgentUpdateCheckView {
  return {
    agent_id: 'codex',
    current_version: '1.1.0',
    available_version: '1.7.0',
    update_available: false,
    snapshot_id: null,
    fetched_at: null,
    fresh: true,
    ...overrides,
  };
}

describe('versionIsNewer', () => {
  it('compares dotted versions even when wrapped in a package spec', () => {
    expect(
      versionIsNewer('1.10.0', '@agentclientprotocol/codex-acp 1.8.0')
    ).toBe(true);
    expect(versionIsNewer('1.8.0', '1.10.0')).toBe(false);
    expect(versionIsNewer('1.8.0', '1.8.0')).toBe(false);
    expect(versionIsNewer(null, '1.8.0')).toBe(false);
  });
});

describe('agentHasAcpUpdate', () => {
  it('requires an available ACP version', () => {
    expect(
      agentHasAcpUpdate(
        check({
          update_available: true,
          acp_available: undefined,
          acp_current: '1.1.0',
        })
      )
    ).toBe(false);
  });

  it('treats a newer ACP version as an update', () => {
    expect(
      agentHasAcpUpdate(
        check({
          acp_current: '@agentclientprotocol/codex-acp 1.8.0',
          acp_available: '1.10.0',
        })
      )
    ).toBe(true);
  });

  it('compares against a probed ACP version from preflight', () => {
    expect(
      agentHasAcpUpdate(
        check({
          update_available: false,
          acp_current: '1.8.0',
          acp_available: '1.8.0',
        }),
        '1.1.0'
      )
    ).toBe(true);
  });

  it('uses the update flag when ACP latest is known', () => {
    expect(
      agentHasAcpUpdate(
        check({
          update_available: true,
          acp_current: '1.7.0',
          acp_available: '1.7.0',
        })
      )
    ).toBe(true);
  });
});

describe('isAgentAcpUpdateCheckable', () => {
  it('only checks enabled, installed Agents', () => {
    expect(
      isAgentAcpUpdateCheckable({
        enabled: true,
        retired: false,
        lifecycle: 'ready',
      })
    ).toBe(true);
    expect(
      isAgentAcpUpdateCheckable({
        enabled: true,
        retired: false,
        lifecycle: 'needs_auth',
      })
    ).toBe(true);
    expect(
      isAgentAcpUpdateCheckable({
        enabled: false,
        retired: false,
        lifecycle: 'ready',
      })
    ).toBe(false);
    expect(
      isAgentAcpUpdateCheckable({
        enabled: true,
        retired: false,
        lifecycle: 'uninstalled',
      })
    ).toBe(false);
  });
});
