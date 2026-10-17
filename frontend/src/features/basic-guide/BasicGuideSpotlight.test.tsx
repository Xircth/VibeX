import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BasicGuideSpotlight } from './BasicGuideSpotlight';
import { BASIC_GUIDE_IDLE_MS, CALLOUT_MOVE_MS } from './spotlightGeometry';

function mountGuideTarget(
  id: string,
  rect: { left: number; top: number; width: number; height: number }
) {
  const node = document.createElement('div');
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

describe('BasicGuideSpotlight', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it('uses a circular box and flashes after 5s idle', () => {
    const button = document.createElement('button');
    button.dataset.basicGuide = 'toolbar-new-session';
    document.body.appendChild(button);
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({
      x: 900,
      y: 12,
      top: 12,
      left: 900,
      width: 28,
      height: 28,
      bottom: 40,
      right: 928,
      toJSON() {
        return {};
      },
    } as DOMRect);

    render(
      <BasicGuideSpotlight
        targets={[
          {
            id: 'toolbar-new-session',
            copyKey: 'click-new-session',
            shape: 'circle',
          },
        ]}
        resolveCopy={() => '首先，点击此按钮以创建会话'}
        panelSelector="[data-basic-guide-panel]"
      />
    );

    const box = document.querySelector('.basic-guide-spotlight');
    expect(box).toHaveAttribute('data-shape', 'circle');
    expect(box).toHaveClass('basic-guide-spotlight--circle');
    expect(box).not.toHaveClass('is-idle');
    expect(screen.getByText('点击')).toHaveClass('basic-guide-action');

    act(() => {
      vi.advanceTimersByTime(BASIC_GUIDE_IDLE_MS);
    });
    expect(document.querySelector('.basic-guide-spotlight')).toHaveClass(
      'is-idle'
    );
  });

  it('draws a connector from the box to the callout', () => {
    const target = document.createElement('div');
    target.dataset.basicGuide = 'welcome-global-project';
    document.body.appendChild(target);
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
      x: 400,
      y: 300,
      top: 300,
      left: 400,
      width: 360,
      height: 36,
      bottom: 336,
      right: 760,
      toJSON() {
        return {};
      },
    } as DOMRect);

    render(
      <BasicGuideSpotlight
        targets={[
          {
            id: 'welcome-global-project',
            copyKey: 'select-project-global',
          },
        ]}
        resolveCopy={() => '全局则是您的用户文件夹'}
        panelSelector="[data-basic-guide-panel]"
      />
    );

    const svg = document.querySelector('[data-basic-guide-connectors]');
    expect(svg).toBeInTheDocument();
    const path = svg?.querySelector('path');
    expect(path?.getAttribute('d')).toMatch(/^M /);
    expect(path?.getAttribute('stroke')).toBe('#111');
  });

  it('does not render copy when the matching box is not on this page', () => {
    render(
      <BasicGuideSpotlight
        targets={[
          {
            id: 'welcome-create-project',
            copyKey: 'select-project-create',
          },
        ]}
        resolveCopy={() => '项目就是一个文件夹'}
        panelSelector="[data-basic-guide-panel]"
      />
    );

    expect(document.querySelector('.basic-guide-spotlight')).toBeNull();
    expect(document.querySelector('[data-basic-guide-callout]')).toBeNull();
    expect(screen.queryByText('项目就是一个文件夹')).toBeNull();
  });

  it('flies the callout from the previous position to the next one', () => {
    mountGuideTarget('welcome-global-project', {
      left: 80,
      top: 200,
      width: 240,
      height: 36,
    });
    const copy = (key: string) =>
      key === 'select-project-global'
        ? '全局则是您的用户文件夹'
        : '首先，点击此按钮以创建会话';
    const { rerender } = render(
      <BasicGuideSpotlight
        targets={[
          { id: 'welcome-global-project', copyKey: 'select-project-global' },
        ]}
        resolveCopy={copy}
        panelSelector="[data-basic-guide-panel]"
      />
    );
    const start = document.querySelector(
      '[data-basic-guide-callout]'
    ) as HTMLElement;
    expect(start).toHaveTextContent('全局则是您的用户文件夹');
    const startLeft = start.style.left;
    const startTop = start.style.top;

    document
      .querySelector('[data-basic-guide="welcome-global-project"]')
      ?.remove();
    mountGuideTarget('toolbar-new-session', {
      left: 900,
      top: 12,
      width: 28,
      height: 28,
    });
    rerender(
      <BasicGuideSpotlight
        targets={[
          {
            id: 'toolbar-new-session',
            copyKey: 'click-new-session',
            shape: 'circle',
          },
        ]}
        resolveCopy={copy}
        panelSelector="[data-basic-guide-panel]"
      />
    );

    const moving = document.querySelector(
      '[data-basic-guide-callout]'
    ) as HTMLElement;
    expect(moving).toHaveClass('is-moving');
    expect(moving).toHaveAttribute('data-callout-kind', 'move');
    expect(moving).toHaveTextContent('首先，点击此按钮以创建会话');
    expect(moving.style.left).toBe(startLeft);
    expect(moving.style.top).toBe(startTop);
    expect(document.querySelector('[data-basic-guide-connectors]')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(0);
    });
    const flying = document.querySelector(
      '[data-basic-guide-callout]'
    ) as HTMLElement;
    expect(flying.style.left).not.toBe(startLeft);

    act(() => {
      vi.advanceTimersByTime(CALLOUT_MOVE_MS);
    });
    expect(document.querySelector('.basic-guide-callout')).not.toHaveClass(
      'is-moving'
    );
    expect(
      document.querySelector('[data-basic-guide-connectors]')
    ).toBeInTheDocument();
  });

  it('rings the nested + without a second explanation', () => {
    mountGuideTarget('kanban-session-list', {
      left: 40,
      top: 80,
      width: 280,
      height: 520,
    });
    mountGuideTarget('kanban-session-list-new', {
      left: 270,
      top: 92,
      width: 28,
      height: 28,
    });

    render(
      <BasicGuideSpotlight
        targets={[
          {
            id: 'kanban-session-list',
            copyKey: 'kanban-create-session',
          },
          {
            id: 'kanban-session-list-new',
            shape: 'circle',
          },
        ]}
        resolveCopy={() => '点击会话列表上的「+」，再新建一个会话。'}
        panelSelector="[data-basic-guide-panel]"
      />
    );

    const spots = document.querySelectorAll('.basic-guide-spotlight');
    expect(spots).toHaveLength(2);
    expect(
      document.querySelector(
        '[data-basic-guide-spotlight="kanban-session-list-new"]'
      )
    ).toHaveAttribute('data-shape', 'circle');
    expect(
      document.querySelectorAll('[data-basic-guide-callout]')
    ).toHaveLength(1);
    expect(
      document
        .querySelector('[data-basic-guide-connectors] path')
        ?.getAttribute('d')
    ).toMatch(/^M /);
  });

  it('rings send without a connector from the nested send button', () => {
    mountGuideTarget('session-composer', {
      left: 640,
      top: 420,
      width: 420,
      height: 160,
    });
    mountGuideTarget('session-send', {
      left: 1008,
      top: 540,
      width: 32,
      height: 32,
    });

    render(
      <BasicGuideSpotlight
        targets={[
          { id: 'session-composer', copyKey: 'send-hello' },
          { id: 'session-send', shape: 'circle' },
        ]}
        resolveCopy={() => '在输入框中编辑「你好」，然后发送。'}
        panelSelector="[data-basic-guide-panel]"
      />
    );

    expect(document.querySelectorAll('.basic-guide-spotlight')).toHaveLength(2);
    expect(
      document.querySelector('[data-basic-guide-spotlight="session-send"]')
    ).toHaveAttribute('data-shape', 'circle');
    expect(
      document.querySelectorAll('[data-basic-guide-callout]')
    ).toHaveLength(1);
    expect(
      document.querySelectorAll('[data-basic-guide-connectors] path')
    ).toHaveLength(1);
  });

  it('puts Continue under the matching idle callout', () => {
    mountGuideTarget('kanban-execution', {
      left: 820,
      top: 48,
      width: 400,
      height: 680,
    });
    const onContinue = vi.fn();

    render(
      <BasicGuideSpotlight
        targets={[{ id: 'kanban-execution', copyKey: 'kanban-execution' }]}
        resolveCopy={() => '这是会话执行区，正在进行的对话在这里展开。'}
        panelSelector="[data-basic-guide-panel]"
        continueCopyKey="kanban-execution"
        continueLabel="继续"
        onContinue={onContinue}
      />
    );

    const button = screen.getByRole('button', { name: '继续' });
    expect(button).toHaveClass('basic-guide-callout__continue');
    button.click();
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('hides Continue while a callout is flying', () => {
    mountGuideTarget('kanban-execution', {
      left: 820,
      top: 48,
      width: 400,
      height: 680,
    });
    const { rerender } = render(
      <BasicGuideSpotlight
        targets={[{ id: 'kanban-execution', copyKey: 'kanban-execution' }]}
        resolveCopy={(key) =>
          key === 'kanban-execution'
            ? '这是会话执行区，正在进行的对话在这里展开。'
            : '这是会话监控区，用来同时观察多个会话的进展。'
        }
        panelSelector="[data-basic-guide-panel]"
        continueCopyKey="kanban-execution"
        continueLabel="继续"
        onContinue={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: '继续' })).toBeInTheDocument();

    document.querySelector('[data-basic-guide="kanban-execution"]')?.remove();
    mountGuideTarget('kanban-monitor', {
      left: 280,
      top: 80,
      width: 500,
      height: 560,
    });
    rerender(
      <BasicGuideSpotlight
        targets={[{ id: 'kanban-monitor', copyKey: 'kanban-monitor' }]}
        resolveCopy={(key) =>
          key === 'kanban-execution'
            ? '这是会话执行区，正在进行的对话在这里展开。'
            : '这是会话监控区，用来同时观察多个会话的进展。'
        }
        panelSelector="[data-basic-guide-panel]"
        continueCopyKey="kanban-monitor"
        continueLabel="继续"
        onContinue={vi.fn()}
      />
    );

    expect(screen.queryByRole('button', { name: '继续' })).toBeNull();
    expect(document.querySelector('[data-basic-guide-callout]')).toHaveClass(
      'is-moving'
    );
  });
});
