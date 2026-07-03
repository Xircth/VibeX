import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ExecutorConfigs } from 'shared/types';
import { BaseCodingAgent } from 'shared/types';
import { TerminalProfileControls } from './TerminalProfileControls';

vi.mock('@/hooks/useClaudeSettings', () => ({
  useClaudeSettings: () => ({ settings: null }),
}));

const profiles = {
  CODEX: {
    DEFAULT: {
      CODEX: {
        append_prompt: null,
        sandbox: 'danger-full-access',
        ask_for_approval: 'never',
        model: 'gpt-5.4',
      },
    },
    APPROVALS: {
      CODEX: {
        append_prompt: null,
        sandbox: 'workspace-write',
        ask_for_approval: 'unless-trusted',
        model: 'gpt-5.4',
      },
    },
  },
} as const satisfies ExecutorConfigs['executors'];

describe('TerminalProfileControls', () => {
  it('renders one combined Codex safety control in icon-only composer mode', () => {
    render(
      <TerminalProfileControls
        profiles={profiles}
        selectedProfile={{ executor: BaseCodingAgent.CODEX, variant: null }}
        onChange={vi.fn()}
        lockExecutor={true}
        iconOnly={true}
      />
    );

    expect(screen.getByTitle('Full Access / Never')).toBeInTheDocument();
    expect(screen.queryByTitle('Full Access')).not.toBeInTheDocument();

    const safetyButtons = screen
      .getAllByRole('button')
      .filter((button) => button.getAttribute('title')?.includes('Access'));
    expect(safetyButtons).toHaveLength(1);
  });
});
