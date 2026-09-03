import { renderHook } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useCanvasRightDragPan } from './useCanvasRightDragPan';

function mountSurface() {
  const surface = document.createElement('div');
  const overlay = document.createElement('div');
  overlay.className = 'react-flow__nodesselection';
  surface.appendChild(overlay);
  document.body.appendChild(surface);
  return { surface, overlay, ref: { current: surface } };
}

describe('useCanvasRightDragPan', () => {
  it('blocks the browser context menu so right-button pan can run', () => {
    const { surface, ref } = mountSurface();
    renderHook(() => useCanvasRightDragPan(ref));

    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
    });
    fireEvent(surface, event);
    expect(event.defaultPrevented).toBe(true);
    surface.remove();
  });

  it('blocks middle-click autoscroll and selection-overlay pan', () => {
    const { surface, overlay, ref } = mountSurface();
    renderHook(() => useCanvasRightDragPan(ref));

    const event = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button: 1,
    });
    const seenOnOverlay = vi.fn();
    overlay.addEventListener('mousedown', seenOnOverlay);
    overlay.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(seenOnOverlay).not.toHaveBeenCalled();
    surface.remove();
  });

  it('opens the middle-click menu after a click on the selection overlay', () => {
    const { surface, overlay, ref } = mountSurface();
    const onMiddleClick = vi.fn();
    renderHook(() => useCanvasRightDragPan(ref, onMiddleClick));

    overlay.dispatchEvent(
      new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        button: 1,
        clientX: 40,
        clientY: 40,
      })
    );
    overlay.dispatchEvent(
      new MouseEvent('mouseup', {
        bubbles: true,
        cancelable: true,
        button: 1,
        clientX: 42,
        clientY: 41,
      })
    );
    expect(onMiddleClick).toHaveBeenCalledTimes(1);
    surface.remove();
  });

  it('claims the selection overlay pointer so React Flow cannot pan it', () => {
    const { surface, overlay, ref } = mountSurface();
    const onMiddleClick = vi.fn();
    const seenOnOverlay = vi.fn();
    overlay.addEventListener('pointerdown', seenOnOverlay);
    renderHook(() => useCanvasRightDragPan(ref, onMiddleClick));

    const down = new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 1,
      clientX: 40,
      clientY: 40,
    });
    overlay.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    expect(seenOnOverlay).not.toHaveBeenCalled();

    overlay.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        cancelable: true,
        button: 1,
        clientX: 41,
        clientY: 40,
      })
    );
    expect(onMiddleClick).toHaveBeenCalledTimes(1);
    surface.remove();
  });

  it('does not open the menu when the middle button dragged', () => {
    const { surface, overlay, ref } = mountSurface();
    const onMiddleClick = vi.fn();
    renderHook(() => useCanvasRightDragPan(ref, onMiddleClick));

    overlay.dispatchEvent(
      new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        button: 1,
        clientX: 40,
        clientY: 40,
      })
    );
    overlay.dispatchEvent(
      new MouseEvent('mouseup', {
        bubbles: true,
        cancelable: true,
        button: 1,
        clientX: 80,
        clientY: 80,
      })
    );
    expect(onMiddleClick).not.toHaveBeenCalled();
    surface.remove();
  });

  it('opens the menu from auxclick when pointerup is missing', () => {
    const { surface, overlay, ref } = mountSurface();
    const onMiddleClick = vi.fn();
    renderHook(() => useCanvasRightDragPan(ref, onMiddleClick));

    overlay.dispatchEvent(
      new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        button: 1,
        clientX: 40,
        clientY: 40,
      })
    );
    overlay.dispatchEvent(
      new MouseEvent('auxclick', {
        bubbles: true,
        cancelable: true,
        button: 1,
        clientX: 41,
        clientY: 40,
      })
    );
    expect(onMiddleClick).toHaveBeenCalledTimes(1);
    surface.remove();
  });
});
