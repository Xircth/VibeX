import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalHistoryImportJobSnapshot } from 'shared/types';
import i18n from '@/i18n';
import { armQuietHistoryImport } from '@/features/history-import/quietHistoryImport';
import { HistoryImportStatusButton } from './HistoryImportStatusButton';

const job = vi.hoisted(() => ({
  value: {
    status: 'running',
    progress: {
      current: 1,
      total: 4,
      agent_id: 'codex',
      external_session_id: 'ext-1',
      title: 'Build the importer',
      phase: 'importing',
      imported: 0,
      skipped: 0,
      failed: 0,
    },
    result: null,
    log: [],
  } as LocalHistoryImportJobSnapshot,
}));

vi.mock('@/features/history-import/useLocalHistoryImportJob', () => ({
  useLocalHistoryImportJob: () => job.value,
}));

const label = (key: string, values?: Record<string, unknown>) =>
  i18n.t(`statusbar:historyImport.${key}`, values) as string;

describe('history import status button', () => {
  beforeEach(() => {
    sessionStorage.clear();
    job.value = {
      status: 'running',
      progress: {
        current: 1,
        total: 4,
        agent_id: 'codex',
        external_session_id: 'ext-1',
        title: 'Build the importer',
        phase: 'importing',
        imported: 0,
        skipped: 0,
        failed: 0,
      },
      result: null,
      log: [],
    };
  });

  it('stays hidden until a quiet import is armed', () => {
    render(<HistoryImportStatusButton />);
    expect(
      screen.queryByRole('button', { name: label('open') })
    ).not.toBeInTheDocument();
  });

  it('opens the status panel above the icon while a quiet import is running', () => {
    armQuietHistoryImport();
    render(<HistoryImportStatusButton />);
    fireEvent.click(screen.getByRole('button', { name: label('open') }));
    expect(
      screen.getByRole('region', { name: label('title') })
    ).toHaveTextContent('Build the importer');
    expect(
      screen.getByText(label('running', { current: 1, total: 4 }))
    ).toBeInTheDocument();
  });
});
