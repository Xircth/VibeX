import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEnvironmentDiagnosticsView } from 'shared/types';
import { HotkeysProvider } from 'react-hotkeys-hook';

import { agentManagementApi } from '@/features/agent-management';
import { Scope } from '@/keyboard';

import { AgentEnvironmentDiagnosticsDialog } from './AgentEnvironmentDiagnosticsDialog';

const report: AgentEnvironmentDiagnosticsView = {
  agent_id: 'codex',
  verdict_code: 'terminal_path_gap',
  verdict_level: 'warning',
  generated_at: '2026-08-05T00:00:00Z',
  plain_text: 'safe diagnostic report',
  sections: [
    {
      id: 'dependencies',
      title_key: 'agents.environmentDiagnosticDependencies',
      checks: [
        {
          id: 'dependency.node',
          label_key: 'agents.environmentDiagnosticDependency.node',
          value: 'v22.20.0 (/usr/local/bin/node)',
          level: 'ok',
          detail_key: null,
        },
      ],
    },
  ],
};

describe('AgentEnvironmentDiagnosticsDialog', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows the structured verdict and copies only the backend report', async () => {
    vi.spyOn(agentManagementApi, 'environmentDiagnostics').mockResolvedValue(
      report
    );
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(
      <HotkeysProvider initiallyActiveScopes={[Scope.DIALOG]}>
        <AgentEnvironmentDiagnosticsDialog
          agentId="codex"
          open
          onOpenChange={vi.fn()}
        />
      </HotkeysProvider>
    );

    expect(
      await screen.findByText('终端能解析 Agent，但应用进程无法解析。')
    ).toBeInTheDocument();
    expect(screen.getByText('必需工具链')).toBeInTheDocument();
    expect(
      screen.getByText('v22.20.0 (/usr/local/bin/node)')
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '复制报告' }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith('safe diagnostic report')
    );
  });
});
