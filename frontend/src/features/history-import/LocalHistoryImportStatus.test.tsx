import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LocalHistoryImportStatus } from './LocalHistoryImportStatus';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));

describe('LocalHistoryImportStatus', () => {
  it('renders nothing while idle', () => {
    const { container } = render(
      <LocalHistoryImportStatus
        job={{ status: 'idle', progress: null, result: null, log: [] }}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows progress and log while a background import is running', () => {
    render(
      <LocalHistoryImportStatus
        job={{
          status: 'running',
          progress: {
            current: 1,
            total: 2,
            agent_id: 'codex',
            external_session_id: 'codex-1',
            title: 'Continue the importer',
            phase: 'imported',
            imported: 1,
            skipped: 0,
            failed: 0,
            conversation_id: 'c1',
            workspace_id: 'w1',
          },
          result: null,
          log: [
            {
              phase: 'imported',
              agent_id: 'codex',
              external_session_id: 'codex-1',
              title: 'Continue the importer',
              conversation_id: 'c1',
            },
          ],
        }}
      />
    );

    expect(
      screen.getByRole('progressbar', { name: 'importSessions.importingTitle' })
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'importSessions.logImported:{"title":"Continue the importer"}'
      )
    ).toBeInTheDocument();
  });
});
