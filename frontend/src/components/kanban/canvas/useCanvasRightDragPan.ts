import { useEffect, type RefObject } from 'react';

const MIDDLE_BUTTON = 1;
const MIDDLE_CLICK_SLOP_PX = 6;

function isCanvasEventTarget(
  surface: HTMLElement,
  target: EventTarget | null
): boolean {
  if (!(target instanceof Element)) return false;
  if (surface.contains(target)) return true;
  return Boolean(
    target.closest(
      '.react-flow, .react-flow__nodesselection, .react-flow__nodesselection-rect'
    )
  );
}

/**
 * Right-button pan is handled by React Flow (`panOnDrag={[2]}`).
 * Block the browser menu so that pan is not interrupted on mouseup.
 *
 * Middle-click must be claimed in capture: d3-zoom listens to pointer
 * events, and the selection overlay still treats middle-press as a pan
 * even when `panOnDrag` is right-only. WebKit may deliver the click as
 * `auxclick` instead of a paired pointerup.
 */
export function useCanvasRightDragPan(
  surfaceRef: RefObject<HTMLElement | null>,
  onMiddleClick?: (event: PointerEvent | MouseEvent) => void
): void {
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;

    let pending = false;
    let startX = 0;
    let startY = 0;

    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
    };

    const isClick = (event: PointerEvent | MouseEvent) =>
      Math.hypot(event.clientX - startX, event.clientY - startY) <=
      MIDDLE_CLICK_SLOP_PX;

    const beginMiddle = (event: PointerEvent | MouseEvent) => {
      if (event.button !== MIDDLE_BUTTON) return;
      if (!isCanvasEventTarget(surface, event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      pending = true;
      startX = event.clientX;
      startY = event.clientY;
    };

    const finishMiddle = (event: PointerEvent | MouseEvent) => {
      if (event.button !== MIDDLE_BUTTON || !pending) return;
      pending = false;
      event.preventDefault();
      event.stopPropagation();
      if (!isClick(event)) return;
      onMiddleClick?.(event);
    };

    const onAuxClick = (event: MouseEvent) => {
      if (event.button !== MIDDLE_BUTTON) return;
      if (!isCanvasEventTarget(surface, event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      if (!pending || !isClick(event)) {
        pending = false;
        return;
      }
      pending = false;
      onMiddleClick?.(event);
    };

    surface.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('pointerdown', beginMiddle, true);
    window.addEventListener('mousedown', beginMiddle, true);
    window.addEventListener('pointerup', finishMiddle, true);
    window.addEventListener('mouseup', finishMiddle, true);
    window.addEventListener('auxclick', onAuxClick, true);
    return () => {
      surface.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('pointerdown', beginMiddle, true);
      window.removeEventListener('mousedown', beginMiddle, true);
      window.removeEventListener('pointerup', finishMiddle, true);
      window.removeEventListener('mouseup', finishMiddle, true);
      window.removeEventListener('auxclick', onAuxClick, true);
    };
  }, [onMiddleClick, surfaceRef]);
}
