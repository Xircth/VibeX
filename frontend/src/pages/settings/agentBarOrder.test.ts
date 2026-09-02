import { describe, expect, it } from 'vitest';
import {
  defaultAgentIdFromOrder,
  moveAgentInOrder,
  nudgeAgentInOrder,
  sortAgentsForBar,
} from './agentBarOrder';

describe('agentBarOrder', () => {
  it('inserts the dragged agent at the drop target and shifts the rest', () => {
    expect(
      moveAgentInOrder(
        ['claude_code', 'codex', 'opencode', 'pi'],
        'pi',
        'codex'
      )
    ).toEqual(['claude_code', 'pi', 'codex', 'opencode']);
  });

  it('returns null when the drop does not change order', () => {
    expect(moveAgentInOrder(['claude_code', 'codex'], 'codex', 'codex')).toBe(
      null
    );
    expect(moveAgentInOrder(['claude_code'], 'missing', 'claude_code')).toBe(
      null
    );
  });

  it('moves the neighbor forward when A is inserted between B and C', () => {
    expect(moveAgentInOrder(['A', 'B', 'C'], 'A', 'B')).toEqual([
      'B',
      'A',
      'C',
    ]);
  });

  it('moves the neighbor backward when C is inserted between A and B', () => {
    expect(moveAgentInOrder(['A', 'B', 'C'], 'C', 'B')).toEqual([
      'A',
      'C',
      'B',
    ]);
  });

  it('nudges an agent one slot earlier or later', () => {
    expect(
      nudgeAgentInOrder(['claude_code', 'codex', 'pi'], 'codex', -1)
    ).toEqual(['codex', 'claude_code', 'pi']);
    expect(
      nudgeAgentInOrder(['claude_code', 'codex', 'pi'], 'codex', 1)
    ).toEqual(['claude_code', 'pi', 'codex']);
    expect(
      nudgeAgentInOrder(['claude_code', 'codex', 'pi'], 'claude_code', -1)
    ).toBe(null);
  });
});

describe('sortAgentsForBar', () => {
  const agents = [
    { agent_id: 'pi', enabled: false },
    { agent_id: 'codex', enabled: true },
    { agent_id: 'claude_code', enabled: true },
    { agent_id: 'grok', enabled: false },
  ];

  it('puts the default Agent first, then other enabled Agents, then disabled Agents', () => {
    expect(
      sortAgentsForBar(agents, 'codex').map((agent) => agent.agent_id)
    ).toEqual(['codex', 'claude_code', 'pi', 'grok']);
  });

  it('falls back to the first enabled Agent when the default is missing', () => {
    expect(
      sortAgentsForBar(agents, 'missing').map((agent) => agent.agent_id)
    ).toEqual(['codex', 'claude_code', 'pi', 'grok']);
  });
});

describe('defaultAgentIdFromOrder', () => {
  it('uses the first icon as the default Agent', () => {
    expect(defaultAgentIdFromOrder(['pi', 'codex'], 'codex')).toBe('pi');
    expect(defaultAgentIdFromOrder([], 'codex')).toBe('codex');
  });
});
