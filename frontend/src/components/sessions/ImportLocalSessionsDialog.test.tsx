import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalHistoryScanPage } from 'shared/types';
import { ImportLocalSessionsDialog } from './ImportLocalSessionsDialog';

const scanLocalHistory = vi.fn();
const importLocalHistoryBatch = vi.fn();

vi.mock('@/features/agents/api', () => ({
  agentsApi: {
    scanLocalHistory: (...args: unknown[]) => scanLocalHistory(...args),
    importLocalHistoryBatch: (...args: unknown[]) =>
      importLocalHistoryBatch(...args),
  },
}));

vi.mock('@/features/agents/useSelectableAgents', () => ({
  useSelectableAgents: () => [
    {
      agentId: 'codex',
      displayName: 'Codex',
      enabled: true,
      lifecycle: 'ready',
      runnable: true,
      settingsFeatures: [],
      iconLight: null,
      iconDark: null,
      iconSvg: null,
    },
    {
      agentId: 'claude_code',
      displayName: 'Claude Code',
      enabled: true,
      lifecycle: 'ready',
      runnable: false,
      settingsFeatures: [],
      iconLight: null,
      iconDark: null,
      iconSvg: null,
    },
  ],
}));

vi.mock('@/components/agents/AgentIcon', () => ({
  AgentIcon: ({ agent }: { agent: string }) => <span>{agent}</span>,
  getAgentName: (agent: string) => agent,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));

const page: LocalHistoryScanPage = {
  folders: [
    {
      path: '/Users/mac/Projects/VibeX',
      name: 'VibeX',
      project_id: 'project-1',
      project_name: 'VibeX',
      workspace_id: 'workspace-1',
      sessions: [
        {
          agent_id: 'codex',
          external_session_id: 'codex-1',
          title: 'Continue the importer',
          workspace_path: '/Users/mac/Projects/VibeX',
          message_count: 6,
          updated_at: '2026-08-17T00:00:00Z',
          status: 'new',
        },
      ],
    },
  ],
  destinations: [
    {
      project_id: 'project-1',
      project_name: 'VibeX',
      workspace_id: 'workspace-1',
      workspace_name: 'main',
    },
  ],
  total_sessions: 1,
  importable_count: 1,
};

describe('ImportLocalSessionsDialog', () => {
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, 'hasPointerCapture', {
      configurable: true,
      value: () => false,
    });
    Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
  });

  beforeEach(() => {
    scanLocalHistory.mockReset();
    importLocalHistoryBatch.mockReset();
    scanLocalHistory.mockResolvedValue(page);
    importLocalHistoryBatch.mockResolvedValue({
      imported: 1,
      skipped: 0,
      failed: 0,
      conversation_ids: ['conversation-1'],
      errors: [],
    });
  });

  it('scans the selected enabled Agent, then imports into the matched workspace', async () => {
    const onImported = vi.fn();
    const user = userEvent.setup();
    render(
      <ImportLocalSessionsDialog
        open
        onOpenChange={vi.fn()}
        onImported={onImported}
      />
    );

    expect(scanLocalHistory).not.toHaveBeenCalled();
    expect(screen.queryByText('Claude Code')).not.toBeInTheDocument();

    await user.click(
      screen.getByRole('combobox', { name: /importSessions.chooseAgent/i })
    );
    await user.click(await screen.findByRole('option', { name: 'Codex' }));

    await waitFor(() => expect(scanLocalHistory).toHaveBeenCalledWith('codex'));
    await user.click(
      await screen.findByRole('button', { name: 'importSessions.expand' })
    );
    expect(
      await screen.findByText('Continue the importer')
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole('checkbox', { name: 'Continue the importer' })
    );
    await user.click(
      screen.getByRole('button', {
        name: 'importSessions.importSelected:{"count":1}',
      })
    );

    await waitFor(() =>
      expect(importLocalHistoryBatch).toHaveBeenCalledWith([
        {
          agent_id: 'codex',
          external_session_id: 'codex-1',
          workspace_id: 'workspace-1',
        },
      ])
    );
    expect(onImported).toHaveBeenCalledWith(['conversation-1']);
    expect(
      await screen.findByText('importSessions.doneTitle')
    ).toBeInTheDocument();
  });
});
