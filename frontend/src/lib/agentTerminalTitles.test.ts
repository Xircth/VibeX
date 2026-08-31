import { describe, expect, it } from 'vitest';
import {
  agentTerminalLabel,
  nextAgentTerminalTitle,
} from './agentTerminalTitles';

describe('agent terminal titles', () => {
  it('uses short agent labels', () => {
    expect(agentTerminalLabel('codex')).toBe('Codex');
    expect(agentTerminalLabel('claude_code')).toBe('Claude');
    expect(agentTerminalLabel(null)).toBe('Agent');
  });

  it('increments Codex-01 style titles per workspace', () => {
    expect(nextAgentTerminalTitle('codex', [])).toBe('Codex-01');
    expect(nextAgentTerminalTitle('codex', ['Codex-01', 'VU-01'])).toBe(
      'Codex-02'
    );
  });
});
