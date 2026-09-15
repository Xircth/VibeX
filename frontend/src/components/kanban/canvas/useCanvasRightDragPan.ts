import { useEffect, type RefObject } from 'react';
import { CANVAS_DROP_IGNORE_SELECTOR } from '@/components/kanban/session-hub/sessionListDrag';

const RIGHT_BUTTON = 2;
const MIDDLE_BUTTON = 1;
const MIDDLE_CLICK_SLOP_PX = 6;

function isSessionListEventTarget(target: EventTarget | null): boolean {
  return target instanceof Element
    ? Boolean(target.closest(CANVAS_DROP_IGNORE_SELECTOR))
    : false;
}

function isCanvasEventTarget(
  surface: HTMLElement,
  target: EventTarget | null
): boolean {
  if (!(target instanceof Element)) return false;
  if (isSessionListEventTarget(target)) return false;
  if (surface.contains(target)) return true;
  return Boolean(
    target.closest(
      '.react-flow, .react-flow__nodesselection, .react-flow__nodesselection-rect'
    )
  );
}

/**
 * Right-button pan is handled by React Flow (`panOnDrag={[2]}`).
 * Claim the right button on pointerdown in capture so WebView2 does not
 * wait for a context-menu gesture, and block the menu so pan is not
 * interrupted.
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

    const onRightPointerDown = (event: PointerEvent) => {
      if (event.button !== RIGHT_BUTTON) return;
      if (!isCanvasEventTarget(surface, event.target)) return;
      event.preventDefault();
    };

    const onContextMenu = (event: MouseEvent) => {
      if (isSessionListEventTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
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

    surface.addEventListener('pointerdown', onRightPointerDown, true);
    surface.addEventListener('contextmenu', onContextMenu, true);
    window.addEventListener('pointerdown', beginMiddle, true);
    window.addEventListener('mousedown', beginMiddle, true);
    window.addEventListener('pointerup', finishMiddle, true);
    window.addEventListener('mouseup', finishMiddle, true);
    window.addEventListener('auxclick', onAuxClick, true);
    return () => {
      surface.removeEventListener('pointerdown', onRightPointerDown, true);
      surface.removeEventListener('contextmenu', onContextMenu, true);
      window.removeEventListener('pointerdown', beginMiddle, true);
      window.removeEventListener('mousedown', beginMiddle, true);
      window.removeEventListener('pointerup', finishMiddle, true);
      window.removeEventListener('mouseup', finishMiddle, true);
      window.removeEventListener('auxclick', onAuxClick, true);
    };
  }, [onMiddleClick, surfaceRef]);
}
