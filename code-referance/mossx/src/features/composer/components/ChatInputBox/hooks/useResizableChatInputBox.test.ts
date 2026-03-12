// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useResizableChatInputBox } from './useResizableChatInputBox';

function createWrapperElement(height: number): HTMLDivElement {
  const element = document.createElement('div');
  const rect = {
    x: 0,
    y: 0,
    width: 640,
    height,
    top: 0,
    right: 640,
    bottom: height,
    left: 0,
    toJSON: () => ({}),
  };

  vi.spyOn(element, 'getBoundingClientRect').mockImplementation(() => rect as DOMRect);
  return element;
}

function getHeightPx(value: string | number | undefined): number | null {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

describe('useResizableChatInputBox', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('drags down and holds 400ms to collapse', () => {
    const editableWrapperRef = { current: createWrapperElement(140) };
    const containerRef = { current: document.createElement('div') };

    const { result } = renderHook(() =>
      useResizableChatInputBox({
        containerRef,
        editableWrapperRef,
      })
    );

    const handleProps = result.current.getHandleProps('n');
    act(() => {
      handleProps.onPointerDown?.({
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        clientY: 100,
      } as unknown as Parameters<NonNullable<typeof handleProps.onPointerDown>>[0]);
    });

    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientY: 180 }));
    });

    expect(result.current.isCollapsed).toBe(false);

    act(() => {
      vi.advanceTimersByTime(399);
    });
    expect(result.current.isCollapsed).toBe(false);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.isCollapsed).toBe(true);
  });

  it('expands from collapsed after 400ms without auto-growing height', () => {
    const editableWrapperRef = { current: createWrapperElement(140) };
    const containerRef = { current: document.createElement('div') };

    const { result } = renderHook(() =>
      useResizableChatInputBox({
        containerRef,
        editableWrapperRef,
      })
    );

    const handleProps = result.current.getHandleProps('n');
    act(() => {
      handleProps.onPointerDown?.({
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        clientY: 120,
      } as unknown as Parameters<NonNullable<typeof handleProps.onPointerDown>>[0]);
    });
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientY: 190 }));
      vi.advanceTimersByTime(400);
      window.dispatchEvent(new MouseEvent('pointerup'));
    });
    expect(result.current.isCollapsed).toBe(true);

    const collapsedHandleProps = result.current.getHandleProps('n');
    act(() => {
      collapsedHandleProps.onPointerDown?.({
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        clientY: 200,
      } as unknown as Parameters<NonNullable<typeof collapsedHandleProps.onPointerDown>>[0]);
    });
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientY: 165 }));
    });

    expect(result.current.isCollapsed).toBe(true);

    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(result.current.isCollapsed).toBe(false);

    const expandedHeight = getHeightPx(result.current.editableWrapperStyle.height);
    expect(expandedHeight).toBe(112);

    act(() => {
      window.dispatchEvent(new MouseEvent('pointerup'));
      vi.advanceTimersByTime(1000);
    });

    const heightAfterRelease = getHeightPx(result.current.editableWrapperStyle.height);
    expect(heightAfterRelease).toBe(112);
  });

  it('keeps dragging up for 1s to unlock height growth after expand', () => {
    const editableWrapperRef = { current: createWrapperElement(140) };
    const containerRef = { current: document.createElement('div') };

    const { result } = renderHook(() =>
      useResizableChatInputBox({
        containerRef,
        editableWrapperRef,
      })
    );

    const handleProps = result.current.getHandleProps('n');
    act(() => {
      handleProps.onPointerDown?.({
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        clientY: 120,
      } as unknown as Parameters<NonNullable<typeof handleProps.onPointerDown>>[0]);
      window.dispatchEvent(new MouseEvent('pointermove', { clientY: 190 }));
      vi.advanceTimersByTime(400);
      window.dispatchEvent(new MouseEvent('pointerup'));
    });
    expect(result.current.isCollapsed).toBe(true);

    const collapsedHandleProps = result.current.getHandleProps('n');
    act(() => {
      collapsedHandleProps.onPointerDown?.({
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        clientY: 200,
      } as unknown as Parameters<NonNullable<typeof collapsedHandleProps.onPointerDown>>[0]);
      window.dispatchEvent(new MouseEvent('pointermove', { clientY: 160 }));
      vi.advanceTimersByTime(400);
    });
    expect(result.current.isCollapsed).toBe(false);
    expect(getHeightPx(result.current.editableWrapperStyle.height)).toBe(112);

    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientY: 110 }));
      vi.advanceTimersByTime(999);
    });
    expect(getHeightPx(result.current.editableWrapperStyle.height)).toBe(112);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect((getHeightPx(result.current.editableWrapperStyle.height) ?? 0) > 112).toBe(true);
  });
});
