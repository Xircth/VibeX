import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { MemberBotAvatar, deriveMemberBotAvatar } from './MemberBotAvatar';

describe('MemberBotAvatar session motion', () => {
  it('stays static when sessionActive is off', () => {
    const { getByTestId } = render(
      <MemberBotAvatar
        config={deriveMemberBotAvatar('小A')}
        animated={false}
        sessionActive={false}
        data-testid="message-avatar"
      />
    );
    const avatar = getByTestId('message-avatar');
    expect(avatar).toHaveAttribute('data-bot-session-active', 'false');
    expect(avatar).not.toHaveClass('collaboration-bot-avatar--animated');
    expect(avatar).not.toHaveAttribute('data-bot-animation-nonce');
  });

  it('gives working instances independent animation nonces', () => {
    const config = deriveMemberBotAvatar('小A');
    const { getByTestId } = render(
      <>
        <MemberBotAvatar
          config={config}
          sessionActive
          data-testid="sidebar-avatar"
        />
        <MemberBotAvatar
          config={config}
          sessionActive
          data-testid="header-avatar"
        />
        <MemberBotAvatar
          config={config}
          sessionActive
          data-testid="working-avatar"
        />
      </>
    );
    const nonces = [
      getByTestId('sidebar-avatar').getAttribute('data-bot-animation-nonce'),
      getByTestId('header-avatar').getAttribute('data-bot-animation-nonce'),
      getByTestId('working-avatar').getAttribute('data-bot-animation-nonce'),
    ];
    expect(nonces.every((nonce) => Boolean(nonce))).toBe(true);
    expect(new Set(nonces).size).toBe(3);
  });
});
