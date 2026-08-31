import { describe, expect, it } from 'vitest';
import type { MessageTurn } from 'shared/types';
import {
  agentCommandCapturesFromTurn,
  isLongRunningAgentCommand,
} from './agentCommandCapture';

describe('agentCommandCapture', () => {
  it('detects long-running dev servers and ignores one-shot commands', () => {
    expect(isLongRunningAgentCommand('pnpm run dev')).toBe(true);
    expect(isLongRunningAgentCommand('npm run start')).toBe(true);
    expect(isLongRunningAgentCommand('ls -la')).toBe(false);
    expect(isLongRunningAgentCommand('git status')).toBe(false);
  });

  it('captures a running bash tool until its result arrives', () => {
    const turn: MessageTurn = {
      id: 't1:assistant',
      role: 'assistant',
      timestamp: '2026-08-31T00:00:00.000Z',
      blocks: [
        {
          type: 'tool_use',
          tool_name: 'bash',
          tool_use_id: 'tool-1',
          kind: 'execute',
          input_preview: JSON.stringify({ command: 'pnpm run dev' }),
          meta: null,
        },
      ],
    };

    expect(agentCommandCapturesFromTurn(turn)).toEqual([
      {
        toolUseId: 'tool-1',
        command: 'pnpm run dev',
        output: '',
        running: true,
      },
    ]);

    turn.blocks.push({
      type: 'tool_result',
      tool_use_id: 'tool-1',
      output_preview: 'ready',
      is_error: false,
    });

    expect(agentCommandCapturesFromTurn(turn)[0]?.running).toBe(false);
  });
});
