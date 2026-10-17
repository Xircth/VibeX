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

    const artworks = ['Cursor', 'CodeBuddy', 'Codex'].map((name) =>
      screen
        .getByRole('checkbox', { name: `启用 ${name}` })
        .closest('article')
        ?.querySelector('.onboarding-agent-icon svg')
    );

    for (const artwork of artworks) {
      expect(artwork).not.toBeNull();
      expect(getComputedStyle(artwork!).width).toBe('24px');
      expect(getComputedStyle(artwork!).height).toBe('24px');
    }
    expect(document.querySelector('.onboarding-agent-icon img')).toBeNull();
  });

  it('separates the agent list from a lighter panel without painting selected rows', () => {
    const css = readFileSync(
      resolve(
        process.cwd(),
        'src/components/onboarding/firstRunExperience.css'
      ),
      'utf8'
    );
    expect(css).toMatch(
      /\.onboarding-agent-panel\s*\{[^}]*background:\s*var\(--surface-dialog\);/
    );
    expect(css).toMatch(
      /\.onboarding-agent-list\s*\{[^}]*background:\s*var\(--surface-card-strong\);/
    );
    expect(css).toMatch(
      /\.dark \.onboarding-agent-list\s*\{[^}]*background:\s*var\(--surface-card\);/
    );
    expect(css).toMatch(
      /\.onboarding-editor-panel\s*\{[^}]*background:\s*var\(--surface-dialog\);/
    );
    expect(css).toMatch(
      /\.onboarding-experience \.onboarding-editor-select,\s*\.onboarding-experience \.onboarding-editor-options\s*\{[^}]*background:\s*var\(--surface-card-strong\);/
    );
    expect(css).not.toMatch(
      /\.onboarding-agent-row\.is-enabled\s*\{[^}]*background:/
    );
  });

  it('centers a horizontal agent rail inside the install detail', () => {
    const css = readFileSync(
      resolve(
        process.cwd(),
        'src/components/onboarding/firstRunExperience.css'
      ),
      'utf8'
    );
    expect(css).toMatch(
      /\.onboarding-install-step\s*\{[^}]*align-content:\s*safe center;/
    );
    expect(css).toMatch(
      /\.onboarding-install-step\s*\{[^}]*padding:\s*88px 32px 48px;/
    );
    expect(css).toMatch(
      /\.onboarding-install-column\s*\{[^}]*width:\s*min\(1120px,/
    );
    expect(css).toMatch(
      /\.onboarding-agent-rail\s*\{[^}]*justify-content:\s*center;/
    );
    expect(css).toMatch(
      /\.onboarding-agent-rail \.agent-management-bar\s*\{[^}]*max-width:\s*440px;/
    );
    expect(css).toMatch(
      /\.agent-management-bar\.is-hug\s*\{[^}]*width:\s*max-content;/
    );
    expect(css).toMatch(
      /\.onboarding-install-guidance\s*\{[^}]*align-self:\s*flex-end;/
    );
    expect(css).toMatch(
      /\.agent-management-bar-pager\.is-next\s*svg\s*\{[^}]*transform:\s*scaleX\(-1\);/
    );
    expect(css).not.toMatch(
      /\.agent-management-bar-label\s*\{[^}]*max-width:\s*none;/
    );
    expect(css).toMatch(/\.onboarding-install-panels\s*\{[^}]*gap:\s*16px;/);
    const settingsCss = readFileSync(
      resolve(process.cwd(), 'src/styles/legacy/index.css'),
      'utf8'
    );
    expect(settingsCss).toMatch(
      /\.agent-management-bar-label\s*\{[^}]*max-width:\s*0;/
    );
    expect(settingsCss).toMatch(
      /\.agent-management-bar-item\.is-selected\s+\.agent-management-bar-label\s*\{[^}]*opacity:\s*1;/
    );
    expect(css).toMatch(/@keyframes onboarding-install-dot/);
  });
});
