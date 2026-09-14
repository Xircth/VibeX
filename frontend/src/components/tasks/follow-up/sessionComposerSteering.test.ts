import { describe, expect, it } from 'vitest';
import { getComposerSteeringTarget } from './sessionComposerSteering';

describe('getComposerSteeringTarget', () => {
  it('returns the in-flight turn when native steering is available', () => {
    expect(
      getComposerSteeringTarget({
        isTurnInFlight: true,
        steeringSupported: true,
        currentTurnId: 'turn-1',
      })
    ).toEqual({ turnId: 'turn-1' });
  });

  it('stays null when the turn is idle or steering is unsupported', () => {
    expect(
      getComposerSteeringTarget({
        isTurnInFlight: false,
        steeringSupported: true,
        currentTurnId: 'turn-1',
      })
    ).toBeNull();
    expect(
      getComposerSteeringTarget({
        isTurnInFlight: true,
        steeringSupported: false,
        currentTurnId: 'turn-1',
      })
    ).toBeNull();
    expect(
      getComposerSteeringTarget({
        isTurnInFlight: true,
        steeringSupported: true,
        currentTurnId: null,
      })
    ).toBeNull();
  });
});
