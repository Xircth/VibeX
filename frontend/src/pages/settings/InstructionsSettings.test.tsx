import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InstructionsSettings } from './InstructionsSettings';

const instructionsApiMock = vi.hoisted(() => ({
  listLocal: vi.fn(),
  listOfficial: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  instructionsApi: instructionsApiMock,
}));

vi.mock('@/features/agent-management', () => ({
  useManagedAgentOptions: () => [
    { value: 'codex', label: 'Codex' },
    { value: 'claude', label: 'Claude' },
  ],
}));

const localInstructions = [
  {
    id: 'instruction-1',
    name: 'add_unit_tests',
    content: 'Write unit tests to improve code coverage and ensure stability.',
    agent_types: ['codex'],
    source: 'local',
    description: null,
    created_at: null,
    updated_at: null,
  },
  {
    id: 'instruction-2',
    name: 'bug_analysis',
    content: 'Perform a comprehensive analysis of the project codebase.',
    agent_types: ['codex', 'claude'],
    source: 'local',
    description: null,
    created_at: null,
    updated_at: null,
  },
  {
    id: 'instruction-3',
    name: 'code_refactoring',
    content: 'Improve code structure without changing its behavior.',
    agent_types: ['claude'],
    source: 'local',
    description: null,
    created_at: null,
    updated_at: null,
  },
] as const;

describe('InstructionsSettings list', () => {
  beforeEach(() => {
    for (const mock of Object.values(instructionsApiMock)) {
      mock.mockReset();
    }
    instructionsApiMock.listLocal.mockResolvedValue(localInstructions);
    instructionsApiMock.listOfficial.mockResolvedValue([]);
  });

  it('keeps every multi-line row clickable and exposes the selected row', async () => {
    const user = userEvent.setup();
    render(<InstructionsSettings />);

    const list = await screen.findByRole('group', { name: '本地指令列表' });
    const rows = within(list).getAllByRole('button');

    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row).toHaveClass('!h-auto', '!min-h-0');
      expect(row).toHaveAttribute('aria-pressed', 'false');
    }

    await user.click(
      within(rows[1]).getByText(
        'Perform a comprehensive analysis of the project codebase.'
      )
    );

    await waitFor(() => {
      expect(rows[1]).toHaveAttribute('aria-pressed', 'true');
    });
    expect(rows[0]).toHaveAttribute('aria-pressed', 'false');
    expect(rows[2]).toHaveAttribute('aria-pressed', 'false');
    expect(
      rows[1].querySelector('[data-selection-indicator]')
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: '#bug_analysis' })
    ).toBeInTheDocument();
  });
});
