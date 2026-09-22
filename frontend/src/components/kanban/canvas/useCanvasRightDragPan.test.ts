import { renderHook } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useCanvasRightDragPan } from './useCanvasRightDragPan';

function pointer(type: string, init: PointerEventInit) {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    ...init,
  });
}

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

  it('claims right-button pointerdown immediately so pan is not delayed by a menu', () => {
    const { surface, ref } = mountSurface();
    const pane = document.createElement('div');
    pane.className = 'react-flow__pane';
    surface.appendChild(pane);
    renderHook(() => useCanvasRightDragPan(ref));

    const event = new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 2,
    });
    pane.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    surface.remove();
  });

  it('leaves session-list right-click free for the context menu', () => {
    const { surface, ref } = mountSurface();
    const list = document.createElement('aside');
    list.className = 'session-hub-sidebar';
    surface.appendChild(list);
    renderHook(() => useCanvasRightDragPan(ref));

    const down = new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 2,
    });
    list.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(false);

    const menu = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
    });
    list.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(false);
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

  it('pans after a right-button drag past the slop', () => {
    const { surface, ref } = mountSurface();
    const onRightPan = vi.fn();
    renderHook(() => useCanvasRightDragPan(ref, undefined, onRightPan));

    surface.dispatchEvent(
      pointer('pointerdown', { button: 2, clientX: 40, clientY: 40 })
    );
    window.dispatchEvent(
      pointer('pointermove', { buttons: 2, clientX: 80, clientY: 52 })
    );

    expect(onRightPan).toHaveBeenCalled();
    expect(onRightPan.mock.calls[0]?.[0]).toMatchObject({ x: 40, y: 12 });
    expect(surface.hasAttribute('data-canvas-panning')).toBe(true);

    window.dispatchEvent(
      pointer('pointermove', { buttons: 2, clientX: 90, clientY: 52 })
    );
    expect(onRightPan.mock.calls.at(-1)?.[0]).toMatchObject({ x: 50, y: 12 });
    expect(onRightPan.mock.calls[0]?.[0].gestureId).toBe(
      onRightPan.mock.calls.at(-1)?.[0].gestureId
    );
    surface.remove();
  });

  it('does not pan on a short right-click', () => {
    const { surface, ref } = mountSurface();
    const onRightPan = vi.fn();
    const onMiddleClick = vi.fn();
    renderHook(() => useCanvasRightDragPan(ref, onMiddleClick, onRightPan));

    const down = pointer('pointerdown', {
      button: 2,
      clientX: 40,
      clientY: 40,
    });
    surface.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);

    window.dispatchEvent(
      pointer('pointermove', { buttons: 2, clientX: 43, clientY: 41 })
    );
    window.dispatchEvent(
      pointer('pointerup', { button: 2, clientX: 43, clientY: 41 })
    );

    expect(onRightPan).not.toHaveBeenCalled();
    expect(onMiddleClick).not.toHaveBeenCalled();
    expect(surface.hasAttribute('data-canvas-panning')).toBe(false);
    surface.remove();
  });

  it('does not start a right pan from a nopan node', () => {
    const { surface, ref } = mountSurface();
    const onRightPan = vi.fn();
    const node = document.createElement('div');
    node.className = 'nopan';
    surface.appendChild(node);
    renderHook(() => useCanvasRightDragPan(ref, undefined, onRightPan));

    node.dispatchEvent(
      pointer('pointerdown', { button: 2, clientX: 40, clientY: 40 })
    );
    window.dispatchEvent(
      pointer('pointermove', { buttons: 2, clientX: 80, clientY: 80 })
    );

    expect(onRightPan).not.toHaveBeenCalled();
    surface.remove();
  });

  it('claims the selection overlay so a right drag can pan', () => {
    const { surface, overlay, ref } = mountSurface();
    const onRightPan = vi.fn();
    renderHook(() => useCanvasRightDragPan(ref, undefined, onRightPan));

    overlay.dispatchEvent(
      pointer('pointerdown', { button: 2, clientX: 40, clientY: 40 })
    );
    window.dispatchEvent(
      pointer('pointermove', { buttons: 2, clientX: 90, clientY: 40 })
    );

    expect(onRightPan).toHaveBeenCalledTimes(1);
    expect(onRightPan.mock.calls[0]?.[0]).toMatchObject({ x: 50, y: 0 });
    surface.remove();
  });
});
