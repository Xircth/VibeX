import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18n from '@/i18n';
import { AgentEJourneyFixture } from '@/e2e/agentE/AgentEJourneyFixture';

describe('Agent E desktop journey', () => {
  beforeEach(async () => {
    window.localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    await i18n.changeLanguage('zh-CN');
  });

  it('runs two mentions, restores success and cancellation, and opens a child', async () => {
    const user = userEvent.setup();
    const firstRender = render(<AgentEJourneyFixture />);
    const editor = await screen.findByRole('textbox');
    await user.click(editor);
    await user.type(editor, 'Ask &Co');
    await user.click(await screen.findByRole('option', { name: /Codex/ }));
    await user.type(editor, 'and &Cl');
    await user.click(
      await screen.findByRole('option', { name: /Claude Code/ })
    );

    expect(screen.queryByText('运行中')).toBeNull();
    expect(
      screen.getByText(
        'No delegation has run. Select agents and send the parent prompt.'
      )
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Send to parent' }));

    expect(await screen.findByText('已完成')).toBeVisible();
    expect(await screen.findByText('已取消')).toBeVisible();
    expect(screen.getByLabelText('BackendTransport log')).toHaveTextContent(
      'fixture_delegate'
    );
    const openChildButtons = screen.getAllByRole('button', {
      name: '打开子会话',
    });
    await user.click(openChildButtons[1]);
    expect(
      screen.getByRole('region', { name: 'Child conversation' })
    ).toHaveTextContent('fixture-child-2');

    firstRender.unmount();
    render(<AgentEJourneyFixture />);

    await waitFor(() => {
      expect(screen.getByText('已完成')).toBeVisible();
      expect(screen.getByText('已取消')).toBeVisible();
    });
    expect(screen.getByRole('group', { name: '委派给 Codex' })).toBeVisible();
    expect(
      screen.getByRole('group', { name: '委派给 Claude Code' })
    ).toBeVisible();
  });
});
