import { describe, expect, it } from 'vitest';
import {
  STREAMING_ACTIVITY_VERBS,
  isTerminalTurnPhase,
  nextStreamingActivityVerb,
  shouldShowAssistantStreamingStatus,
} from './assistantStreamingActivity';

describe('shouldShowAssistantStreamingStatus', () => {
  it('shows only while the assistant turn is actively streaming', () => {
    expect(shouldShowAssistantStreamingStatus({ phase: 'streaming' })).toBe(
      true
    );
  });

  it('hides after the turn settles, fails, is cancelled, or is interrupted', () => {
    for (const phase of [
      'settled',
      'failed',
      'cancelled',
      'interrupted',
    ] as const) {
      expect(shouldShowAssistantStreamingStatus({ phase })).toBe(false);
    }
  });

  it('hides when the turn already has an error even if phase is still streaming', () => {
    expect(
      shouldShowAssistantStreamingStatus({
        phase: 'streaming',
        hasTurnError: true,
      })
    ).toBe(false);
  });
});

describe('isTerminalTurnPhase', () => {
  it('treats finished user-turn phases as terminal', () => {
    expect(isTerminalTurnPhase('failed')).toBe(true);
    expect(isTerminalTurnPhase('cancelled')).toBe(true);
    expect(isTerminalTurnPhase('interrupted')).toBe(true);
    expect(isTerminalTurnPhase('settled')).toBe(true);
    expect(isTerminalTurnPhase('streaming')).toBe(false);
    expect(isTerminalTurnPhase('optimistic')).toBe(false);
  });
});

describe('nextStreamingActivityVerb', () => {
  it('picks a known activity verb and avoids repeating the current one', () => {
    const next = nextStreamingActivityVerb(
      STREAMING_ACTIVITY_VERBS,
      'Thinking',
      () => 0
    );
    expect(STREAMING_ACTIVITY_VERBS).toContain(next);
    expect(next).not.toBe('Thinking');
  });
});
