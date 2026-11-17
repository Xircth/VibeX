import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  getExpandableRevision,
  isExpandableOpen,
  useExpandable,
  useExpandableGroup,
  useExpandableRevision,
  useProcessExpandableRevision,
} from './useExpandableStore';

describe('useExpandableStore revision tracking', () => {
  it('increments processRevision only on process:* keys and keeps getExpandableRevision in sync', () => {
    const initialRev = getExpandableRevision();
    const { result } = renderHook(() => ({
      rev: useExpandableRevision(),
      processRev: useProcessExpandableRevision(),
      toolCard: useExpandable('command-tool-entry:tool-1', false),
      processFold: useExpandable('process:turn-1:0', false),
      group: useExpandableGroup([
        'command-tool-entry:tool-2',
        'process:turn-2:0',
      ]),
    }));

    expect(result.current.rev).toBe(initialRev);
    const startProcessRev = result.current.processRev;

    // Non-process tool expansion bumps global revision but NOT processRevision.
    act(() => {
      result.current.toolCard[1](true);
    });
    expect(result.current.rev).toBe(initialRev + 1);
    expect(getExpandableRevision()).toBe(initialRev + 1);
    expect(result.current.processRev).toBe(startProcessRev);
    expect(isExpandableOpen('command-tool-entry:tool-1')).toBe(true);

    // Repeating identical state is a no-op.
    act(() => {
      result.current.toolCard[1](true);
    });
    expect(result.current.rev).toBe(initialRev + 1);
    expect(result.current.processRev).toBe(startProcessRev);

    // Process fold key bumps both global revision and processRevision.
    act(() => {
      result.current.processFold[1]();
    });
    expect(result.current.rev).toBe(initialRev + 2);
    expect(getExpandableRevision()).toBe(initialRev + 2);
    expect(result.current.processRev).toBe(startProcessRev + 1);
    expect(isExpandableOpen('process:turn-1:0')).toBe(true);

    // Group containing a process:* key also bumps processRevision.
    act(() => {
      result.current.group[1](true);
    });
    expect(result.current.rev).toBe(initialRev + 3);
    expect(result.current.processRev).toBe(startProcessRev + 2);
  });
});
