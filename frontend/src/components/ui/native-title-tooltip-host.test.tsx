import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeTitleTooltipHost } from './native-title-tooltip-host';
import { NATIVE_TITLE_SHOW_DELAY_MS } from './native-title-tooltip';

describe('NativeTitleTooltipHost', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(80);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(28);
  });

  afterEach(() => {
    cleanup();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('shows a capsule tooltip for native title hover and keeps the native title suppressed', () => {
    render(
      <div>
        <NativeTitleTooltipHost />
        <button type="button" title="最近项目">
          项目
        </button>
      </div>
    );

    const trigger = screen.getByRole('button', { name: '项目' });
    fireEvent.pointerOver(trigger, { pointerType: 'mouse' });

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(trigger).not.toHaveAttribute('title');
    expect(trigger).toHaveAttribute('data-app-title', '最近项目');

    act(() => {
      vi.advanceTimersByTime(NATIVE_TITLE_SHOW_DELAY_MS);
    });

    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveTextContent('最近项目');
    expect(tooltip).toHaveClass('app-hover-tooltip');
    expect(tooltip).toHaveAttribute('data-native-title-tooltip', 'true');

    fireEvent.pointerOver(document.body, {
      pointerType: 'mouse',
      relatedTarget: trigger,
    });

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(trigger).not.toHaveAttribute('title');
    expect(trigger).toHaveAttribute('data-app-title', '最近项目');
  });

  it('does not show a second tooltip for Radix-owned hover targets', () => {
    render(
      <div>
        <NativeTitleTooltipHost />
        <button type="button" data-app-owned-tooltip="" title="Settings">
          Settings
        </button>
      </div>
    );

    const trigger = screen.getByRole('button', { name: 'Settings' });
    fireEvent.pointerOver(trigger, { pointerType: 'mouse' });
    act(() => {
      vi.advanceTimersByTime(NATIVE_TITLE_SHOW_DELAY_MS);
    });

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(trigger).not.toHaveAttribute('title');
    expect(trigger).toHaveAttribute('data-app-title', 'Settings');
  });

  it('hides when the pointer leaves the window', () => {
    render(
      <div>
        <NativeTitleTooltipHost />
        <button type="button" title="最近项目">
          项目
        </button>
      </div>
    );

    const trigger = screen.getByRole('button', { name: '项目' });
    fireEvent.pointerOver(trigger, { pointerType: 'mouse' });
    act(() => {
      vi.advanceTimersByTime(NATIVE_TITLE_SHOW_DELAY_MS);
    });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    fireEvent.pointerLeave(document.documentElement);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(trigger).not.toHaveAttribute('title');
    expect(trigger).toHaveAttribute('data-app-title', '最近项目');
  });

  it('does not open on touch pointers', () => {
    render(
      <div>
        <NativeTitleTooltipHost />
        <button type="button" title="复制">
          复制
        </button>
      </div>
    );

    fireEvent.pointerOver(screen.getByRole('button', { name: '复制' }), {
      pointerType: 'touch',
    });
    act(() => {
      vi.advanceTimersByTime(NATIVE_TITLE_SHOW_DELAY_MS);
    });

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '复制' })).toHaveAttribute(
      'title',
      '复制'
    );
  });

  it('keeps a conversation-tab tooltip hidden until its measured width is centered', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(0);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);

    render(
      <div>
        <NativeTitleTooltipHost />
        <button type="button" title="新会话4">
          新会话4
        </button>
      </div>
    );

    fireEvent.pointerOver(screen.getByRole('button', { name: '新会话4' }), {
      pointerType: 'mouse',
    });
    act(() => {
      vi.advanceTimersByTime(NATIVE_TITLE_SHOW_DELAY_MS);
    });

    const tooltip = screen.getByRole('tooltip', { hidden: true });
    expect(tooltip).toHaveStyle({ visibility: 'hidden' });
    expect(tooltip).not.toHaveAttribute('data-placed');
  });

  it('centers the tooltip on the measured capsule before showing it', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 40,
      left: 200,
      width: 92,
      height: 28,
      right: 292,
      bottom: 68,
      x: 200,
      y: 40,
      toJSON() {
        return this;
      },
    } as DOMRect);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(120);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(28);

    render(
      <div>
        <NativeTitleTooltipHost />
        <button type="button" title="新会话4">
          新会话4
        </button>
      </div>
    );

    fireEvent.pointerOver(screen.getByRole('button', { name: '新会话4' }), {
      pointerType: 'mouse',
    });
    act(() => {
      vi.advanceTimersByTime(NATIVE_TITLE_SHOW_DELAY_MS);
    });

    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveAttribute('data-placed', 'true');
    expect(tooltip).toHaveStyle({ left: '186px', visibility: 'visible' });
  });

  it('does not mount a native surface occlusion hold and hides on pointerout into native child surfaces', () => {
    render(
      <div>
        <NativeTitleTooltipHost />
        <button type="button" title="开发者工具">
          调试
        </button>
      </div>
    );

    const trigger = screen.getByRole('button', { name: '调试' });
    fireEvent.pointerOver(trigger, { pointerType: 'mouse' });
    act(() => {
      vi.advanceTimersByTime(NATIVE_TITLE_SHOW_DELAY_MS);
    });

    const tooltip = screen.getByRole('tooltip');
    expect(tooltip.querySelector('[data-native-surface-occlusion]')).toBeNull();

    fireEvent.pointerOut(trigger, {
      pointerType: 'mouse',
      relatedTarget: null,
    });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });
});
