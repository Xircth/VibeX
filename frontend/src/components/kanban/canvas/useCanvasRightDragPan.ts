import { useEffect, type RefObject } from 'react';

const MIDDLE_BUTTON = 1;
const MIDDLE_CLICK_SLOP_PX = 6;

/**
 * Right-button pan is handled by React Flow (`panOnDrag={[2]}`).
 * Block the browser menu so that pan is not interrupted on mouseup.
 *
 * Middle-click must be claimed in capture: `preventDefault` on mousedown
 * suppresses `auxclick`, and d3-zoom treats middle-mousedown on
 * `.react-flow__nodesselection` as a pan even when `panOnDrag` is right-only.
 */
export function useCanvasRightDragPan(
  surfaceRef: RefObject<HTMLElement | null>,
  onMiddleClick?: (event: MouseEvent) => void
): void {
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;

    let middleDown = false;
    let startX = 0;
    let startY = 0;

    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
    };
    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== MIDDLE_BUTTON) return;
      event.preventDefault();
      event.stopPropagation();
      middleDown = true;
      startX = event.clientX;
      startY = event.clientY;
    };
    const onMouseUp = (event: MouseEvent) => {
      if (event.button !== MIDDLE_BUTTON || !middleDown) return;
      middleDown = false;
      event.preventDefault();
      event.stopPropagation();
      if (
        Math.hypot(event.clientX - startX, event.clientY - startY) >
        MIDDLE_CLICK_SLOP_PX
      ) {
        return;
      }
      onMiddleClick?.(event);
    };

    surface.addEventListener('contextmenu', onContextMenu);
    surface.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('mouseup', onMouseUp, true);
    return () => {
      surface.removeEventListener('contextmenu', onContextMenu);
      surface.removeEventListener('mousedown', onMouseDown, true);
      window.removeEventListener('mouseup', onMouseUp, true);
    };
  }, [onMiddleClick, surfaceRef]);
}
