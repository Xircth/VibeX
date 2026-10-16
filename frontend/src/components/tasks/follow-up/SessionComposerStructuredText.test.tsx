import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  SessionComposerTokenChip,
  SESSION_COMPOSER_TOKEN_VARIANTS,
} from './SessionComposerStructuredText';
import {
  formatSessionComposerCommand,
  getSessionComposerStructuredTokens,
} from './sessionComposerStructuredTokens';

describe('SessionComposerTokenChip', () => {
  it('gives @ tokens the slash-command tone and a leading icon', () => {
    const [token] = getSessionComposerStructuredTokens(
      formatSessionComposerCommand({
        type: '@',
        key: 'App.tsx',
        value: 'src/App.tsx',
      })
    );

    render(<SessionComposerTokenChip token={token} />);

    const chip = screen.getByTestId('session-composer-token-chip');
    expect(chip).toHaveAttribute('data-token-kind', 'file');
    expect(chip).toHaveAttribute('data-variant', 'blue');
    expect(chip).toHaveAttribute(
      'data-variant',
      SESSION_COMPOSER_TOKEN_VARIANTS.slash
    );
    expect(chip.querySelector('svg')).not.toBeNull();
    expect(chip).toHaveTextContent('@App.tsx');
  });

  it('shows agent mentions as icon plus name without an ampersand', () => {
    const [token] = getSessionComposerStructuredTokens(
      '[&Codex](vibex://agent/codex)'
    );

    render(<SessionComposerTokenChip token={token} />);

    const chip = screen.getByTestId('session-composer-token-chip');
    expect(chip).toHaveAttribute('data-token-kind', 'agent_mention');
    expect(chip).toHaveTextContent('Codex');
    expect(chip).not.toHaveTextContent('&');
    expect(screen.getByRole('img', { name: 'Codex' })).toBeInTheDocument();
  });
});
