import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ExecutorConfigs } from 'shared/types';
import { TerminalProfileControls } from './TerminalProfileControls';

const profiles = {
  codex: {
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
  it('does not render profile-derived controls for a locked ACP session', () => {
    const { container } = render(
      <TerminalProfileControls
        profiles={profiles}
        selectedProfile={{ executor: 'codex' as const, variant: null }}
        onChange={vi.fn()}
        lockExecutor={true}
        iconOnly={true}
      />
    );

    expect(container).toBeEmptyDOMElement();
  });
});
