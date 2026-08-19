import { describe, expect, it } from 'vitest';
import { moveAgentInOrder, nudgeAgentInOrder } from './agentBarOrder';

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
