import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HotkeysProvider } from 'react-hotkeys-hook';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BasicGuideContext,
  type BasicGuideContextValue,
} from './BasicGuideContext';
import { BasicGuideOverlay } from './BasicGuideOverlay';
import { ACTIVE_GUIDE, type PersistedBasicGuide } from './basicGuideState';

function renderOverlay(
  state: PersistedBasicGuide,
  extra?: Partial<BasicGuideContextValue>,
  { pathname = '/' }: { pathname?: string } = {}
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
        <MemoryRouter initialEntries={[pathname]}>
          <BasicGuideContext.Provider value={value}>
            <BasicGuideOverlay />
          </BasicGuideContext.Provider>
        </MemoryRouter>
      </HotkeysProvider>
    ),
  };
}

function mountGuideTarget(id: string) {
  const node = document.createElement('button');
  node.dataset.basicGuide = id;
  document.body.appendChild(node);
  vi.spyOn(node, 'getBoundingClientRect').mockReturnValue({
    x: 420,
    y: 180,
    top: 180,
    left: 420,
    width: 280,
    height: 36,
    bottom: 216,
    right: 700,
    toJSON() {
      return {};
    },
  } as DOMRect);
  return node;
}

describe('BasicGuideOverlay', () => {
  afterEach(() => {
    document
      .querySelectorAll('[data-basic-guide]')
      .forEach((node) => node.remove());
  });

  it('frames skip and steps in a raised bottom-left stack', () => {
    renderOverlay(ACTIVE_GUIDE);
    const panel = screen.getByRole('complementary', { name: '基础引导' });
    expect(panel).toBeInTheDocument();
    expect(panel.querySelector('.dialog-surface')).toBeNull();
    expect(screen.getByText('创建或选择项目')).toBeInTheDocument();
    expect(screen.getByText('进入工作区并创建会话')).toBeInTheDocument();
    expect(screen.getByText('熟悉页面构成')).toBeInTheDocument();
    expect(
      screen.getByText('用一个文件夹隔离会话与工作状态')
    ).toBeInTheDocument();
    expect(screen.getByText('选择 Agent 并发送第一条消息')).toBeInTheDocument();
    expect(screen.getByText('了解侧栏、看板和计量统计')).toBeInTheDocument();
    expect(panel.querySelectorAll('.astryx-step__description')).toHaveLength(3);
    expect(
      within(panel).queryByText(/项目就是一个文件夹/, { exact: false })
    ).toBeNull();
    expect(document.querySelector('[data-basic-guide-callout]')).toBeNull();
    const skip = screen.getByRole('button', { name: '跳过基础引导' });
    const steps = panel.querySelector('.astryx-step');
    const frame = panel.querySelector('.basic-guide-panel__stack--framed');
    expect(skip).toBeInTheDocument();
    expect(steps).toBeTruthy();
    expect(frame).toBeTruthy();
    expect(frame?.contains(skip)).toBe(true);
    expect(frame?.contains(steps)).toBe(true);
    expect(
      Boolean(
        steps &&
          skip.compareDocumentPosition(steps) & Node.DOCUMENT_POSITION_FOLLOWING
      )
    ).toBe(true);
    expect(panel.className).toMatch(/basic-guide-panel--bottom/);
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

  it('hides the step panel on the settings window', () => {
    renderOverlay(ACTIVE_GUIDE, undefined, {
      pathname: '/settings/general',
    });
    expect(
      screen.queryByRole('complementary', { name: '基础引导' })
    ).toBeNull();
    expect(screen.queryByText('创建或选择项目')).toBeNull();
    expect(document.querySelector('[data-basic-guide-callout]')).toBeNull();
  });

  it('keeps callout copy on settings only when that window has the box', () => {
    mountGuideTarget('settings-agent-bar');
    renderOverlay(
      {
        phase: 'active',
        reachedStep: 1,
        substep: 'settings-agent-icon',
        endCopy: 'none',
      },
      undefined,
      { pathname: '/settings/agents' }
    );
    expect(
      screen.queryByRole('complementary', { name: '基础引导' })
    ).toBeNull();
    expect(
      document.querySelector('[data-basic-guide-callout="settings-agent-icon"]')
    ).toHaveTextContent('先点选一个 Agent');
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
      screen.getByRole('button', { name: '跳过基础引导' })
    ).toBeInTheDocument();
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
});
