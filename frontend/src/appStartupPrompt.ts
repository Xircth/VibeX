import type { Config } from 'shared/types';

export type StartupPromptStep = 'first-run' | 'dismiss-release-notes' | 'none';

export type StartupPromptConfig = Pick<
  Config,
  'disclaimer_acknowledged' | 'onboarding_acknowledged' | 'show_release_notes'
>;

export function getStartupPromptStep({
  config,
  pathname,
}: {
  config: StartupPromptConfig | null;
  pathname: string;
}): StartupPromptStep {
  if (!config) return 'none';
  if (pathname.startsWith('/settings')) return 'none';
  if (!config.disclaimer_acknowledged || !config.onboarding_acknowledged) {
    return 'first-run';
  }
  if (config.show_release_notes) return 'dismiss-release-notes';
  return 'none';
}
