import { describe, expect, it } from 'vitest';
import type { AgentPreflightView } from 'shared/types';

import {
  acpStepperIndex,
  isAcpConnectorAvailable,
  isAgentLoggedIn,
  isAgentOperationallyAvailable,
  presentAgentStatusRow,
  preflightAllPassed,
} from './agentStatusPresentation';

const preflight = (
  statuses: string[],
  agentId = 'grok'
): AgentPreflightView => ({
  agent_id: agentId,
  checked_at: '2026-04-08T00:00:00Z',
  items: statuses.map((status, index) => ({
    id: `item.${index}`,
    label: `Item ${index}`,
    status,
    detail: '',
    version: null,
    path: null,
    source: null,
    repairable: false,
    update_available: false,
    available_version: null,
    update_group: null,
  })),
});

describe('agentStatusPresentation', () => {
  it('maps ACP progress into download / install / check', () => {
    expect(acpStepperIndex(0)).toBe(0);
    expect(acpStepperIndex(32)).toBe(0);
    expect(acpStepperIndex(33)).toBe(1);
    expect(acpStepperIndex(65)).toBe(1);
    expect(acpStepperIndex(66)).toBe(2);
    expect(acpStepperIndex(100)).toBe(2);
  });

  it('treats an ACP version or a usable lifecycle as connector-ready', () => {
    expect(
      isAcpConnectorAvailable({ acp_version: '1.0.0', lifecycle: 'installing' })
    ).toBe(true);
    expect(
      isAcpConnectorAvailable({ acp_version: null, lifecycle: 'needs_auth' })
    ).toBe(true);
    expect(
      isAcpConnectorAvailable({ acp_version: null, lifecycle: 'uninstalled' })
    ).toBe(false);
  });

  it('treats not_logged_in as the only logged-out state', () => {
    expect(isAgentLoggedIn('not_logged_in')).toBe(false);
    expect(isAgentLoggedIn('account')).toBe(true);
    expect(isAgentLoggedIn('api_key')).toBe(true);
    expect(isAgentLoggedIn('not_required')).toBe(true);
  });

  it('requires every preflight item to pass', () => {
    expect(preflightAllPassed(null)).toBe(false);
    expect(preflightAllPassed(preflight(['pass', 'pass']))).toBe(true);
    expect(preflightAllPassed(preflight(['pass', 'fail']))).toBe(false);
    expect(preflightAllPassed(preflight(['pass', 'warning']))).toBe(false);
  });

  it('uses lifecycle ready as the operational availability gate', () => {
    expect(
      isAgentOperationallyAvailable({ enabled: true, lifecycle: 'ready' })
    ).toBe(true);
    expect(
      isAgentOperationallyAvailable({
        enabled: true,
        lifecycle: 'needs_auth',
      })
    ).toBe(false);
  });

  it('shows the stepper only while an ACP install is in flight', () => {
    const installing = presentAgentStatusRow(
      {
        acp_version: null,
        lifecycle: 'installing',
        authentication: 'not_logged_in',
      },
      {
        operationId: 'op-1',
        kind: 'install',
        status: 'running',
        progressPercent: 40,
        message: null,
        sequence: 1,
      }
    );
    expect(installing.showStepper).toBe(true);
    expect(installing.stepperIndex).toBe(1);
    expect(installing.connectorAvailable).toBe(false);

    const ready = presentAgentStatusRow(
      {
        acp_version: '0.2.0',
        lifecycle: 'ready',
        authentication: 'account',
      },
      null
    );
    expect(ready.showStepper).toBe(false);
    expect(ready.connectorAvailable).toBe(true);
    expect(ready.loggedIn).toBe(true);
  });

  it('shows the stepper from lifecycle when no operation snapshot is present', () => {
    const installing = presentAgentStatusRow(
      {
        acp_version: null,
        lifecycle: 'installing',
        authentication: 'not_logged_in',
      },
      null
    );
    expect(installing.showStepper).toBe(true);
    expect(installing.stepperIndex).toBe(1);
  });
});
