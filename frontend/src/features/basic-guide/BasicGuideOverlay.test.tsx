import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HotkeysProvider } from 'react-hotkeys-hook';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BasicGuideContext,
  type BasicGuideContextValue,
} from './BasicGuideContext';
import { BasicGuideExitButton, BasicGuideOverlay } from './BasicGuideOverlay';
import { ACTIVE_GUIDE, type PersistedBasicGuide } from './basicGuideState';
import { useLayoutStore } from '@/stores/useLayoutStore';

function renderOverlay(
  state: PersistedBasicGuide,
  extra?: Partial<BasicGuideContextValue>,
  {
    pathname = '/',
    activeTab = 'workspace',
    withExitButton = false,
  }: { pathname?: string; activeTab?: string; withExitButton?: boolean } = {}
) {
  act(() => {
    useLayoutStore.getState().setActiveTab(activeTab);
  });
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
        <MemoryRouter initialEntries={[pathname]}>
          <BasicGuideContext.Provider value={value}>
            <BasicGuideOverlay />
            {withExitButton ? <BasicGuideExitButton /> : null}
          </BasicGuideContext.Provider>
        </MemoryRouter>
      </HotkeysProvider>
    ),
  };
}

function mountGuideTarget(
  id: string,
  rect: { left: number; top: number; width: number; height: number } = {
    left: 420,
    top: 180,
    width: 280,
    height: 36,
  }
) {
  const node = document.createElement('button');
  node.dataset.basicGuide = id;
  document.body.appendChild(node);
  vi.spyOn(node, 'getBoundingClientRect').mockReturnValue({
    x: rect.left,
    y: rect.top,
    top: rect.top,
    left: rect.left,
    width: rect.width,
    height: rect.height,
    bottom: rect.top + rect.height,
    right: rect.left + rect.width,
    toJSON() {
      return {};
    },
  } as DOMRect);
  return node;
}

describe('BasicGuideOverlay', () => {
  afterEach(() => {
    act(() => {
      useLayoutStore.getState().setActiveTab('workspace');
    });
    document
      .querySelectorAll('[data-basic-guide]')
      .forEach((node) => node.remove());
  });

  it('renders the skip button with primary accent styling without a standalone container', async () => {
    const user = userEvent.setup();
    const { value } = renderOverlay(ACTIVE_GUIDE, undefined, {
      withExitButton: true,
    });
    expect(
      screen.queryByRole('complementary', { name: '基础引导' })
    ).toBeNull();
    expect(
      document.querySelector('.basic-guide-panel__stack--framed')
    ).toBeNull();
    expect(document.querySelector('[data-basic-guide-callout]')).toBeNull();

    const skip = screen.getByRole('button', { name: '跳过基础引导' });
    expect(skip).toBeInTheDocument();
    expect(skip.className).toMatch(/primary-control/);
    await user.click(skip);
    expect(value.requestExit).toHaveBeenCalledTimes(1);
  });

  it('keeps the step panel pinned without a workspace offset when showing the end banner', () => {
    renderOverlay(
      {
        phase: 'completed',
        reachedStep: 2,
        substep: 'show-end',
        endCopy: 'finished',
      },
      undefined,
      {
        pathname: '/local-projects/abc/sessions',
      }
    );
    const panel = screen.getByRole('complementary', { name: '基础引导' });
    expect(panel.className).toMatch(/basic-guide-panel--bottom/);
    expect(panel.className).not.toMatch(/basic-guide-panel--workspace/);
    expect(panel.className).not.toMatch(/basic-guide-panel--kanban/);
  });

  it('moves the step panel to 10px on the kanban page', () => {
    renderOverlay(
      {
        phase: 'completed',
        reachedStep: 2,
        substep: 'show-end',
        endCopy: 'finished',
      },
      undefined,
      {
        pathname: '/local-projects/abc',
        activeTab: 'kanban',
      }
    );
    const panel = screen.getByRole('complementary', { name: '基础引导' });
    expect(panel.className).toMatch(/basic-guide-panel--kanban/);
  });

  it('places callout copy next to a measured box on this window', () => {
    mountGuideTarget('welcome-create-project');
    renderOverlay(ACTIVE_GUIDE);
    expect(
      document.querySelector(
        '[data-basic-guide-callout="select-project-create"]'
      )
    ).toHaveTextContent('项目就是一个文件夹');
    expect(
      document.querySelector(
        '[data-basic-guide-callout="select-project-global"]'
      )
    ).toBeNull();
  });

  it('hides the step panel and exit button on the settings window', () => {
    renderOverlay(ACTIVE_GUIDE, undefined, {
      pathname: '/settings/general',
      withExitButton: true,
    });
    expect(
      screen.queryByRole('complementary', { name: '基础引导' })
    ).toBeNull();
    expect(screen.queryByRole('button', { name: '跳过基础引导' })).toBeNull();
    expect(document.querySelector('[data-basic-guide-callout]')).toBeNull();
  });

  it('does not render a manual finish button and hides the exit button once finished', () => {
    renderOverlay(
      {
        phase: 'completed',
        reachedStep: 2,
        substep: 'show-end',
        endCopy: 'finished',
      },
      undefined,
      { withExitButton: true }
    );
    const panel = screen.getByRole('complementary', { name: '基础引导' });
    expect(within(panel).queryByRole('button', { name: '结束' })).toBeNull();
    expect(screen.queryByRole('button', { name: '结束' })).toBeNull();
    expect(screen.queryByRole('button', { name: '跳过基础引导' })).toBeNull();
  });

  it('asks for confirmation before exiting to Settings → General', async () => {
    const user = userEvent.setup();
    const { value } = renderOverlay(ACTIVE_GUIDE, { exitOpen: true });
    expect(
      screen.getByText(/是否确认跳过基础引导/, { exact: false })
    ).toBeInTheDocument();
    expect(screen.getByText('设置-常规')).toBeInTheDocument();
    expect(screen.getByText('重新开始基础引导')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: '跳过基础引导' })
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '确认跳过' }));
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
    const end = document.querySelector('[data-basic-guide-callout="end"]');
    expect(end).toHaveTextContent(
      '更多使用技巧请查看官方文档或社区，Vibing~~~'
    );
    expect(end).toHaveClass('basic-guide-callout');
    expect(end).toHaveClass('basic-guide-end');
    expect(
      screen.queryByRole('button', {
        name: '更多使用技巧请查看官方文档或社区，Vibing~~~',
      })
    ).toBeNull();
    await user.click(screen.getByRole('button', { name: '关闭' }));
    expect(value.dismissEnd).toHaveBeenCalled();
    expect(
      document.querySelector('.basic-guide-panel__stack--framed')
    ).toBeNull();
  });

  it('coaches Host selector, Project selector, and the 4 left rail buttons with Continue on each callout', async () => {
    const user = userEvent.setup();
    const targets: Array<
      [
        (
          | 'toolbar-host-selector'
          | 'project-switcher'
          | 'rail-session-list'
          | 'rail-bots'
          | 'rail-file-tree'
          | 'rail-git'
        ),
        string,
        { left: number; top: number; width: number; height: number },
      ]
    > = [
      [
        'toolbar-host-selector',
        'Host 选择器',
        { left: 160, top: 8, width: 110, height: 28 },
      ],
      [
        'project-switcher',
        '项目选择器',
        { left: 280, top: 8, width: 130, height: 28 },
      ],
      [
        'rail-session-list',
        '会话列表',
        { left: 8, top: 64, width: 28, height: 28 },
      ],
      ['rail-bots', 'Bot 助手', { left: 8, top: 96, width: 28, height: 28 }],
      [
        'rail-file-tree',
        '文件树',
        { left: 8, top: 128, width: 28, height: 28 },
      ],
      ['rail-git', 'Git 面板', { left: 8, top: 160, width: 28, height: 28 }],
    ];

    for (const [substep, expectedText, rect] of targets) {
      document
        .querySelectorAll('[data-basic-guide]')
        .forEach((node) => node.remove());
      mountGuideTarget(substep, rect);
      const { value, unmount } = renderOverlay({
        phase: 'active',
        reachedStep: 1,
        substep,
        endCopy: 'none',
      });

      expect(
        screen.queryByRole('complementary', { name: '基础引导' })
      ).toBeNull();
      expect(
        document.querySelector(`[data-basic-guide-spotlight="${substep}"]`)
      ).toBeInTheDocument();
      const callout = document.querySelector(
        `[data-basic-guide-callout="${substep}"]`
      ) as HTMLElement;
      expect(callout).toHaveTextContent(expectedText);
      const continueButton = within(callout).getByRole('button', {
        name: '继续',
      });
      expect(continueButton).toHaveClass('basic-guide-callout__continue');
      await user.click(continueButton);
      expect(value.continueStep).toHaveBeenCalledTimes(1);
      unmount();
    }
  });
});
