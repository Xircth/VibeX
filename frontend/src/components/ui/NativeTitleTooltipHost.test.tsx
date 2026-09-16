import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeTitleTooltipHost } from './NativeTitleTooltipHost';
import { NATIVE_TITLE_SHOW_DELAY_MS } from './nativeTitleTooltip';

describe('NativeTitleTooltipHost', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('shows a capsule tooltip for native title hover and restores the attribute', () => {
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
    expect(trigger).toHaveAttribute('title', '最近项目');
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
    expect(trigger).toHaveAttribute('title', '最近项目');
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
});
