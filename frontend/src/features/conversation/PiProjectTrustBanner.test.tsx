import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PiProjectTrustStateView } from 'shared/types';

import { agentManagementApi } from '@/features/agent-management';

import { PiProjectTrustBanner } from './PiProjectTrustBanner';

vi.mock('@/features/agent-management', () => ({
  agentManagementApi: {
    piProjectTrustState: vi.fn(),
    setPiProjectTrust: vi.fn(),
    acknowledgePiProjectTrust: vi.fn(),
  },
  agentManagementErrorMessage: (cause: unknown, fallback: string) =>
    cause instanceof Error ? cause.message : fallback,
}));

const undecided: PiProjectTrustStateView = {
  workspace: '/repo',
  resources: [
    {
      path: '/repo/.pi/extensions',
      kind: '.pi/extensions',
      executes_code: true,
    },
  ],
  decision: null,
  decided_at: null,
  trust_file: '/home/.pi/agent/trust.json',
  acknowledged: false,
};

describe('PiProjectTrustBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(agentManagementApi.piProjectTrustState).mockResolvedValue(
      undecided
    );
    vi.mocked(agentManagementApi.setPiProjectTrust).mockResolvedValue({
      ...undecided,
      decision: true,
      acknowledged: true,
    });
  });

  it('does not render for other agents', async () => {
    const { container } = render(
      <PiProjectTrustBanner
        agentId="codex"
        workingDir="/repo"
        turnInFlight={false}
      />
    );
    expect(container).toBeEmptyDOMElement();
    expect(agentManagementApi.piProjectTrustState).not.toHaveBeenCalled();
  });

  it('asks to trust repo-shipped Pi extensions', async () => {
    render(
      <PiProjectTrustBanner
        agentId="pi"
        workingDir="/repo"
        turnInFlight={false}
      />
    );
    expect(await screen.findByRole('status')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '信任' }));
    expect(agentManagementApi.setPiProjectTrust).toHaveBeenCalledWith(
      '/repo',
      true
    );
  });
});
