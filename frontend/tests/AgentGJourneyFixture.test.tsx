import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentGJourneyFixture } from '@/e2e/agentG/AgentGJourneyFixture';
import i18n from '@/i18n';

describe('Agent G desktop journey', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh-CN');
    HTMLElement.prototype.scrollIntoView = vi.fn();
    HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
    HTMLElement.prototype.setPointerCapture = vi.fn();
  });

  it('runs an Office Automation through a worktree, Turn, Artifact, and recovery states', async () => {
    const user = userEvent.setup();
    render(<AgentGJourneyFixture />);

    await user.click(await screen.findByRole('button', { name: '新建自动化' }));
    await user.type(
      screen.getByRole('textbox', { name: '名称' }),
      'Office 周报'
    );
    const composer = screen.getByRole('textbox', { name: '消息' });
    composer.textContent = '汇总本周进展，创建一份可编辑的管理层 PPT。';
    fireEvent.input(composer);
    await user.click(await screen.findByRole('button', { name: '创建 PPT' }));
    await user.click(screen.getByRole('button', { name: '保存' }));
    await user.click(
      await screen.findByRole('button', { name: '运行 Office 周报' })
    );

    expect(await screen.findByText('已完成')).toBeVisible();
    expect(screen.getByText('worktree-run-1')).toBeVisible();
    const evidence = screen.getByRole('region', {
      name: 'Fake backend scenarios',
    });
    expect(evidence).toHaveTextContent('conversation-office-1 / turn-office-1');
    expect(within(evidence).getByText('weekly-review.pptx')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Dirty shared root' }));
    await user.click(screen.getByRole('button', { name: '运行 Office 周报' }));
    expect(
      await screen.findByText('Shared root has uncommitted changes')
    ).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Overlapping skip' }));
    await user.click(screen.getByRole('button', { name: '运行 Office 周报' }));
    expect(await screen.findByText('已跳过')).toBeVisible();

    await user.click(
      screen.getByRole('button', { name: 'Restart Interrupted' })
    );
    await user.click(screen.getByRole('button', { name: '运行 Office 周报' }));
    expect(await screen.findByText('已中断')).toBeVisible();
  }, 15_000);
});
