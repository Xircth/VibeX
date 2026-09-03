import { describe, expect, it } from 'vitest';

import {
  invokeErrorText,
  isAgentInstallLaunchError,
  splitLaunchError,
} from './sessionControlsError';

describe('session controls launch errors', () => {
  it('strips invoke wrappers and recognizes an install failure with diagnostic detail', () => {
    const raw = invokeErrorText(
      new Error(
        'Bad request: This Agent is not installed successfully. Repair or reinstall it in Settings.\n\nnpm view dist.integrity failed: npm error code ECONNREFUSED'
      )
    );
    expect(isAgentInstallLaunchError(raw)).toBe(true);
    expect(splitLaunchError(raw)).toEqual({
      headline:
        'This Agent is not installed successfully. Repair or reinstall it in Settings.',
      detail: 'npm view dist.integrity failed: npm error code ECONNREFUSED',
    });
  });

  it('still recognizes the previous internal lock message', () => {
    expect(
      isAgentInstallLaunchError(
        invokeErrorText('Bad request: Agent has no current Installation lock')
      )
    ).toBe(true);
  });
});
