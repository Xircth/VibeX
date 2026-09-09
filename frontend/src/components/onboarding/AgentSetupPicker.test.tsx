import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'postcss';
import { afterEach, describe, expect, it } from 'vitest';

import '@/i18n';

import { AgentSetupPicker } from './AgentSetupPicker';
import type { OnboardingAgentOption } from './onboardingAgentModel';

function option(
  overrides: Partial<OnboardingAgentOption> &
    Pick<OnboardingAgentOption, 'agentId' | 'displayName'>
): OnboardingAgentOption {
  return {
    description: `${overrides.displayName} description`,
    iconLight: null,
    iconDark: null,
    iconSvg: null,
    recommended: false,
    builtIn: true,
    added: true,
    enabled: false,
    platformSupported: true,
    runtimeInstalled: false,
    lifecycle: 'uninstalled',
    needsInstallation: true,
    ...overrides,
  };
}

function installOnboardingIconStyles() {
  const onboardingCss = readFileSync(
    resolve(process.cwd(), 'src/components/onboarding/firstRunExperience.css'),
    'utf8'
  );
  const appCss = readFileSync(
    resolve(process.cwd(), 'src/styles/legacy/index.css'),
    'utf8'
  );
  const relevantRules: string[] = [onboardingCss];
  parse(appCss).walkRules((rule) => {
    if (
      rule.selector.includes('.agent-management-brand') ||
      rule.selector.includes('.agent-management-svg')
    ) {
      relevantRules.push(rule.toString());
    }
  });
  const style = document.createElement('style');
  style.textContent = relevantRules.join('\n');
  document.head.append(style);
  return style;
}

describe('AgentSetupPicker icons', () => {
  let style: HTMLStyleElement;

  afterEach(() => {
    style?.remove();
  });

  it('keeps Cursor and CodeBuddy artwork inside the 24px onboarding slot', () => {
    style = installOnboardingIconStyles();
    render(
      <AgentSetupPicker
        agents={[
          option({
            agentId: 'cursor',
            displayName: 'Cursor',
            iconLight: '/agents/cursor-light.svg',
            iconDark: '/agents/cursor-dark.svg',
          }),
          option({
            agentId: 'codebuddy',
            displayName: 'CodeBuddy',
            iconLight: '/agents/codebuddy.svg',
            iconDark: '/agents/codebuddy.svg',
          }),
          option({
            agentId: 'codex',
            displayName: 'Codex',
          }),
        ]}
        enabledAgentIds={new Set()}
        defaultAgentId={null}
        loading={false}
        discoveryProgress={null}
        error={null}
        validationError={null}
        onRetry={() => undefined}
        onEnabledChange={() => undefined}
        onDefaultChange={() => undefined}
      />
    );

    const frames = document.querySelectorAll('.onboarding-agent-icon');
    expect(frames).toHaveLength(3);

    for (const frame of frames) {
      expect(getComputedStyle(frame).width).toBe('36px');
      expect(getComputedStyle(frame).height).toBe('36px');
      expect(getComputedStyle(frame).overflow).toBe('hidden');
    }

    const cursorArtwork = screen
      .getByRole('checkbox', { name: '启用 Cursor' })
      .closest('article')
      ?.querySelector('.onboarding-agent-icon img');
    const codebuddyArtwork = screen
      .getByRole('checkbox', { name: '启用 CodeBuddy' })
      .closest('article')
      ?.querySelector('.onboarding-agent-icon img');
    const codexArtwork = screen
      .getByRole('checkbox', { name: '启用 Codex' })
      .closest('article')
      ?.querySelector('.onboarding-agent-icon svg');

    expect(cursorArtwork).toHaveAttribute('src', '/agents/cursor-light.svg');
    expect(codebuddyArtwork).toHaveAttribute('src', '/agents/codebuddy.svg');
    expect(codexArtwork).not.toBeNull();

    expect(getComputedStyle(cursorArtwork!).width).toBe('24px');
    expect(getComputedStyle(cursorArtwork!).height).toBe('24px');
    expect(getComputedStyle(codebuddyArtwork!).width).toBe('24px');
    expect(getComputedStyle(codebuddyArtwork!).height).toBe('24px');
    expect(getComputedStyle(codexArtwork!).width).toBe('24px');
    expect(getComputedStyle(codexArtwork!).height).toBe('24px');
  });
});
