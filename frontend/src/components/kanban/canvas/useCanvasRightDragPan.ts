import { useEffect, type RefObject } from 'react';
import { CANVAS_DROP_IGNORE_SELECTOR } from '@/components/kanban/session-hub/sessionListDrag';

const MIDDLE_BUTTON = 1;
const RIGHT_BUTTON = 2;
const RIGHT_BUTTON_MASK = 2;
const MIDDLE_CLICK_SLOP_PX = 6;
const RIGHT_PAN_SLOP_PX = 6;

export type CanvasRightPanDelta = { x: number; y: number; gestureId: number };

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

function isRightPanTarget(
  surface: HTMLElement,
  target: EventTarget | null
): boolean {
  if (!(target instanceof Element)) return false;
  if (!isCanvasEventTarget(surface, target)) return false;
  if (
    target.closest(
      'button, a, input, textarea, select, [role="menu"], [role="menuitem"], [contenteditable="true"]'
    )
  ) {
    return false;
  }
  if (
    target.closest(
      '.react-flow__nodesselection, .react-flow__nodesselection-rect'
    )
  ) {
    return true;
  }
  return !target.closest('.nopan');
}

/**
 * Own right-button pan in capture. React Flow `panOnDrag={[2]}` plus
 * `onPaneContextMenu` collides click with drag; dropping the click and
 * leaving d3-zoom on button 2 still fails because d3-zoom does not
 * preventDefault on right mousedown, so Chromium never sends mousemove.
 *
 * Pan only after slop. A short press is a no-op (no menu, no pan).
 *
 * Middle-click must be claimed in capture: the selection overlay still
 * treats middle-press as a pan. WebKit may deliver the click as
 * `auxclick` instead of a paired pointerup.
 */
export function useCanvasRightDragPan(
  surfaceRef: RefObject<HTMLElement | null>,
  onMiddleClick?: (event: PointerEvent | MouseEvent) => void,
  onRightPan?: (delta: CanvasRightPanDelta) => void
): void {
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;

    let pendingMiddle = false;
    let middleStartX = 0;
    let middleStartY = 0;
    let rightGestureId = 0;
    let rightSession: {
      pointerId: number | null;
      gestureId: number;
      startX: number;
      startY: number;
      panning: boolean;
    } | null = null;

    const onContextMenu = (event: MouseEvent) => {
      if (isSessionListEventTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
    };

    const isMiddleClick = (event: PointerEvent | MouseEvent) =>
      Math.hypot(event.clientX - middleStartX, event.clientY - middleStartY) <=
      MIDDLE_CLICK_SLOP_PX;

    const beginMiddle = (event: PointerEvent | MouseEvent) => {
      if (event.button !== MIDDLE_BUTTON) return;
      if (!isCanvasEventTarget(surface, event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      pendingMiddle = true;
      middleStartX = event.clientX;
      middleStartY = event.clientY;
    };

    const finishMiddle = (event: PointerEvent | MouseEvent) => {
      if (event.button !== MIDDLE_BUTTON || !pendingMiddle) return;
      pendingMiddle = false;
      event.preventDefault();
      event.stopPropagation();
      if (!isMiddleClick(event)) return;
      onMiddleClick?.(event);
    };

    const onAuxClick = (event: MouseEvent) => {
      if (event.button !== MIDDLE_BUTTON) return;
      if (!isCanvasEventTarget(surface, event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      if (!pendingMiddle || !isMiddleClick(event)) {
        pendingMiddle = false;
        return;
      }
      pendingMiddle = false;
      onMiddleClick?.(event);
    };

    const captureRightPointer = (event: PointerEvent | MouseEvent) => {
      if (!rightSession || !('pointerId' in event)) return;
      rightSession.pointerId = event.pointerId;
      try {
        surface.setPointerCapture(event.pointerId);
      } catch {
        rightSession.pointerId = null;
      }
    };

    const releaseRightPointer = () => {
      if (!rightSession || rightSession.pointerId == null) return;
      if (surface.hasPointerCapture?.(rightSession.pointerId)) {
        try {
          surface.releasePointerCapture(rightSession.pointerId);
        } catch {
          /* already released */
        }
      }
    };

    const endRight = () => {
      if (!rightSession) return;
      if (rightSession.panning) {
        surface.removeAttribute('data-canvas-panning');
      }
      releaseRightPointer();
      rightSession = null;
    };

    const beginRight = (event: PointerEvent | MouseEvent) => {
      if (event.button !== RIGHT_BUTTON) return;
      if (!isRightPanTarget(surface, event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      if (rightSession) return;
      rightGestureId += 1;
      rightSession = {
        pointerId: null,
        gestureId: rightGestureId,
        startX: event.clientX,
        startY: event.clientY,
        panning: false,
      };
      captureRightPointer(event);
    };

    const moveRight = (event: PointerEvent | MouseEvent) => {
      if (!rightSession) return;
      if ((event.buttons & RIGHT_BUTTON_MASK) === 0) {
        endRight();
        return;
      }
      const dx = event.clientX - rightSession.startX;
      const dy = event.clientY - rightSession.startY;
      if (!rightSession.panning) {
        if (Math.hypot(dx, dy) <= RIGHT_PAN_SLOP_PX) return;
        rightSession.panning = true;
        surface.setAttribute('data-canvas-panning', '');
      }
      event.preventDefault();
      onRightPan?.({ x: dx, y: dy, gestureId: rightSession.gestureId });
    };

    const finishRight = (event: PointerEvent | MouseEvent) => {
      if (!rightSession) return;
      if (event.type !== 'pointercancel' && event.button !== RIGHT_BUTTON) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      endRight();
    };

    surface.addEventListener('contextmenu', onContextMenu, true);
    window.addEventListener('pointerdown', beginMiddle, true);
    window.addEventListener('mousedown', beginMiddle, true);
    window.addEventListener('pointerup', finishMiddle, true);
    window.addEventListener('mouseup', finishMiddle, true);
    window.addEventListener('auxclick', onAuxClick, true);
    window.addEventListener('pointerdown', beginRight, true);
    window.addEventListener('mousedown', beginRight, true);
    window.addEventListener('pointermove', moveRight, true);
    window.addEventListener('mousemove', moveRight, true);
    window.addEventListener('pointerup', finishRight, true);
    window.addEventListener('mouseup', finishRight, true);
    window.addEventListener('pointercancel', finishRight, true);
    window.addEventListener('blur', endRight);
    return () => {
      endRight();
      surface.removeEventListener('contextmenu', onContextMenu, true);
      window.removeEventListener('pointerdown', beginMiddle, true);
      window.removeEventListener('mousedown', beginMiddle, true);
      window.removeEventListener('pointerup', finishMiddle, true);
      window.removeEventListener('mouseup', finishMiddle, true);
      window.removeEventListener('auxclick', onAuxClick, true);
      window.removeEventListener('pointerdown', beginRight, true);
      window.removeEventListener('mousedown', beginRight, true);
      window.removeEventListener('pointermove', moveRight, true);
      window.removeEventListener('mousemove', moveRight, true);
      window.removeEventListener('pointerup', finishRight, true);
      window.removeEventListener('mouseup', finishRight, true);
      window.removeEventListener('pointercancel', finishRight, true);
      window.removeEventListener('blur', endRight);
    };
  }, [onMiddleClick, onRightPan, surfaceRef]);
}
