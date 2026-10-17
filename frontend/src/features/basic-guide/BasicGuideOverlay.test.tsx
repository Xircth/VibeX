import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HotkeysProvider } from 'react-hotkeys-hook';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import {
  BasicGuideContext,
  type BasicGuideContextValue,
} from './BasicGuideContext';
import { BasicGuideOverlay } from './BasicGuideOverlay';
import { ACTIVE_GUIDE, type PersistedBasicGuide } from './basicGuideState';

function renderOverlay(
  state: PersistedBasicGuide,
  extra?: Partial<BasicGuideContextValue>
) {
  const value: BasicGuideContextValue = {
    state,
    continueStep: vi.fn(),
    requestExit: vi.fn(),
    confirmExit: vi.fn(),
    cancelExit: vi.fn(),
    finish: vi.fn(),
    restart: vi.fn(),
    start: vi.fn(),
    skip: vi.fn(),
    dismissEnd: vi.fn(),
    exitOpen: false,
    ...extra,
  };
  return {
    value,
    ...render(
      <HotkeysProvider initiallyActiveScopes={['dialog']}>
        <MemoryRouter>
          <BasicGuideContext.Provider value={value}>
            <BasicGuideOverlay />
          </BasicGuideContext.Provider>
        </MemoryRouter>
      </HotkeysProvider>
    ),
  };
}

describe('BasicGuideOverlay', () => {
  it('keeps the three steps on the left without a card, copy on the page', () => {
    renderOverlay(ACTIVE_GUIDE);
    const panel = screen.getByRole('complementary', { name: '基础引导' });
    expect(panel).toBeInTheDocument();
    expect(panel.querySelector('.dialog-surface')).toBeNull();
    expect(panel.querySelector('.basic-guide-panel__card')).toBeNull();
    expect(screen.getByText('创建或选择项目')).toBeInTheDocument();
    expect(screen.getByText('进入工作区并创建会话')).toBeInTheDocument();
    expect(screen.getByText('熟悉页面构成')).toBeInTheDocument();
    expect(
      within(panel).queryByText(/项目就是一个文件夹/, { exact: false })
    ).toBeNull();
    expect(
      document.querySelector(
        '[data-basic-guide-callout="select-project-create"]'
      )
    ).toHaveTextContent('项目就是一个文件夹');
    expect(
      document.querySelector(
        '[data-basic-guide-callout="select-project-global"]'
      )
    ).toHaveTextContent('用户文件夹');
    expect(
      screen.getByRole('button', { name: '直接退出' })
    ).toBeInTheDocument();
  });

  it('shows the finish button without coaching copy', () => {
    renderOverlay({
      phase: 'active',
      reachedStep: 2,
      substep: 'show-end',
      endCopy: 'none',
    });
    expect(screen.getByRole('button', { name: '结束' })).toBeInTheDocument();
    expect(
      screen.queryByText('熟悉完页面后，点击结束即可。')
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '直接退出' })
    ).toBeInTheDocument();
  });

  it('asks for confirmation before exiting to Settings → General', async () => {
    const user = userEvent.setup();
    const { value } = renderOverlay(ACTIVE_GUIDE, { exitOpen: true });
    expect(
      screen.getByText(/是否确认直接退出引导/, { exact: false })
    ).toBeInTheDocument();
    expect(screen.getByText('设置-常规')).toBeInTheDocument();
    expect(screen.getByText('重新开始基础引导')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '确认退出' }));
    expect(value.confirmExit).toHaveBeenCalled();
  });

  it('shows the end copy after the guide finishes', async () => {
    const user = userEvent.setup();
    const { value } = renderOverlay({
      phase: 'completed',
      reachedStep: 2,
      substep: 'show-end',
      endCopy: 'finished',
    });
    expect(
      screen.getByRole('button', {
        name: '更多使用技巧请查看官方文档或社区，Vibing~~~',
      })
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', {
        name: '更多使用技巧请查看官方文档或社区，Vibing~~~',
      })
    );
    expect(value.dismissEnd).toHaveBeenCalled();
  });
});
