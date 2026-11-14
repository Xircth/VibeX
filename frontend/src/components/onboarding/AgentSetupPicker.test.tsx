import { fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'postcss';
import { afterEach, describe, expect, it, vi } from 'vitest';

import i18n from '@/i18n';

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
        checks={{}}
        onInspect={() => undefined}
        onInstall={() => undefined}
        loading={false}
        discoveryProgress={null}
        error={null}
        onRetry={() => undefined}
      />
    );

    const frames = document.querySelectorAll('.onboarding-agent-icon');
    expect(frames).toHaveLength(3);

    for (const frame of frames) {
      expect(getComputedStyle(frame).width).toBe('28px');
      expect(getComputedStyle(frame).height).toBe('28px');
      expect(getComputedStyle(frame).overflow).toBe('hidden');
    }

    const artworks = ['Cursor', 'CodeBuddy', 'Codex'].map((name) =>
      screen
        .getByRole('button', {
          name: i18n.t('dialogs:onboarding.agentDetail', { agent: name }),
        })
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

  it('offers authentication configuration without an enable checkbox', () => {
    const onInspect = vi.fn();
    const onInstall = vi.fn();
    render(
      <AgentSetupPicker
        agents={[
          option({
            agentId: 'codex',
            displayName: 'Codex',
            lifecycle: 'needs_auth',
            runtimeInstalled: true,
            needsInstallation: false,
          }),
        ]}
        checks={{
          codex: {
            report: {
              agent_id: 'codex',
              checked_at: '',
              items: [
                {
                  id: 'acp',
                  label: 'ACP',
                  status: 'pass',
                  detail: '',
                  version: null,
                  path: null,
                  source: null,
                  repairable: false,
                  update_available: false,
                  available_version: null,
                  update_group: null,
                },
              ],
            },
          },
        }}
        loading={false}
        discoveryProgress={null}
        error={null}
        onRetry={() => undefined}
        onInspect={onInspect}
        onInstall={onInstall}
      />
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: i18n.t('dialogs:onboarding.configureAuthAria', {
          agent: 'Codex',
        }),
      })
    );
    expect(onInspect).toHaveBeenCalledWith('codex');
    expect(onInstall).not.toHaveBeenCalled();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(
      screen.getByText(i18n.t('dialogs:onboarding.agentStatus.needs_auth'))
    ).toBeInTheDocument();
  });
});
