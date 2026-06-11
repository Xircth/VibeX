import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AgentTerminalPanel } from './AgentTerminalPanel';

describe('AgentTerminalPanel', () => {
  it('renders terminal output snapshots', () => {
    render(
      <AgentTerminalPanel
        terminals={[
          {
            id: 'terminal',
            command: 'pnpm',
            args: ['test'],
          },
        ]}
        snapshots={{
          terminal: {
            terminal_id: 'terminal',
            output: 'passed',
            truncated: false,
            exit: { kind: 'code', code: 0 },
          },
        }}
      />
    );

    expect(screen.getByText('pnpm test')).toBeInTheDocument();
    expect(screen.getByText('passed')).toBeInTheDocument();
    expect(screen.getByText('closed')).toBeInTheDocument();
  });
});
