import { describe, expect, it } from 'vitest';

import {
  getStartupPromptStep,
  type StartupPromptConfig,
} from './appStartupPrompt';

function config(
  overrides: Partial<StartupPromptConfig> = {}
): StartupPromptConfig {
  return {
    disclaimer_acknowledged: true,
    onboarding_acknowledged: true,
    show_release_notes: false,
    ...overrides,
  };
}

describe('getStartupPromptStep', () => {
  it('suppresses startup prompts on settings routes', () => {
    expect(
      getStartupPromptStep({
        config: config({
          disclaimer_acknowledged: false,
          onboarding_acknowledged: false,
          show_release_notes: true,
        }),
        pathname: '/settings/agents',
      })
    ).toBe('none');
  });

  it.each(['/plugins', '/plugins/vibex.office'])(
    'suppresses startup prompts in the product plugin module at %s',
    (pathname) => {
      expect(
        getStartupPromptStep({
          config: config({
            disclaimer_acknowledged: false,
            onboarding_acknowledged: false,
            show_release_notes: true,
          }),
          pathname,
        })
      ).toBe('none');
    }
  );

  it('uses one full-screen first-run experience for disclaimer and onboarding', () => {
    expect(
      getStartupPromptStep({
        config: config({
          disclaimer_acknowledged: false,
          onboarding_acknowledged: false,
          show_release_notes: true,
        }),
        pathname: '/local-projects',
      })
    ).toBe('first-run');
  });

  it('keeps first-run open until both acknowledgements are persisted', () => {
    expect(
      getStartupPromptStep({
        config: config({
          onboarding_acknowledged: false,
          show_release_notes: true,
        }),
        pathname: '/local-projects',
      })
    ).toBe('first-run');

    expect(
      getStartupPromptStep({
        config: config({ disclaimer_acknowledged: false }),
        pathname: '/local-projects',
      })
    ).toBe('first-run');
  });

  it('dismisses release notes after onboarding is acknowledged', () => {
    expect(
      getStartupPromptStep({
        config: config({ show_release_notes: true }),
        pathname: '/',
      })
    ).toBe('dismiss-release-notes');
  });

  it('does nothing after all startup gates are clear or config is missing', () => {
    expect(
      getStartupPromptStep({
        config: config(),
        pathname: '/',
      })
    ).toBe('none');

    expect(
      getStartupPromptStep({
        config: null,
        pathname: '/',
      })
    ).toBe('none');
  });
});
