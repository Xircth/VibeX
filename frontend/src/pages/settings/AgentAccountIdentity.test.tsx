import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AgentAccountIdentity, accountInitial } from './AgentAccountIdentity';

describe('AgentAccountIdentity', () => {
  it('renders the account as an identity chip instead of a sentence', () => {
    render(<AgentAccountIdentity signedIn accountLabel="linus@example.com" />);

    const identity = screen.getByTestId('agent-account-identity');
    expect(identity).toHaveAttribute('data-state', 'identified');
    expect(identity).toHaveAccessibleName('当前登录账户：linus@example.com');
    expect(screen.getByText('linus@example.com')).toBeVisible();
    expect(screen.getByText('L')).toBeVisible();
    expect(
      screen.queryByText('当前登录账户：linus@example.com')
    ).not.toBeInTheDocument();
  });

  it('keeps the signed-in state when user information is missing', () => {
    render(<AgentAccountIdentity signedIn />);

    const identity = screen.getByTestId('agent-account-identity');
    expect(identity).toHaveAttribute('data-state', 'unknown');
    expect(identity).toHaveAccessibleName('未获得有效用户信息');
    expect(screen.getByText('未获得有效用户信息')).toBeVisible();
  });

  it('renders a signed-out identity chip', () => {
    render(<AgentAccountIdentity signedIn={false} />);

    expect(screen.getByTestId('agent-account-identity')).toHaveAttribute(
      'data-state',
      'signed-out'
    );
    expect(screen.getByText('未登录官方账号')).toBeVisible();
  });

  it('uses the local part of an email as the monogram', () => {
    expect(accountInitial('linus@example.com')).toBe('L');
    expect(accountInitial('艾达')).toBe('艾');
  });
});
