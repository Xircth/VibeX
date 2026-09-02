import { useEffect, type RefObject } from 'react';

const MARQUEE_ATTR = 'data-canvas-marquee';
const PRIMARY_BUTTON_MASK = 1;

export function useCanvasMarqueeTextGuard(
  surfaceRef: RefObject<HTMLElement | null>
): void {
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;

    const stop = () => {
      surface.removeAttribute(MARQUEE_ATTR);
      window.removeEventListener('mousemove', onMouseMove, true);
      window.removeEventListener('mouseup', onMouseUp, true);
      window.removeEventListener('blur', stop);
      document.removeEventListener('selectionchange', onSelectionChange);
    };

    const onMouseUp = (event: MouseEvent) => {
      if (event.button === 0) stop();
    };

    const onMouseMove = (event: MouseEvent) => {
      if ((event.buttons & PRIMARY_BUTTON_MASK) === 0) stop();
    };

    const onSelectionChange = () => {
      if (!surface.hasAttribute(MARQUEE_ATTR)) return;
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0) selection.removeAllRanges();
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      if (!(event.target instanceof Element)) return;
      if (!event.target.classList.contains('react-flow__pane')) return;
      event.preventDefault();
      window.getSelection()?.removeAllRanges();
      surface.setAttribute(MARQUEE_ATTR, '');
      window.addEventListener('mousemove', onMouseMove, true);
      window.addEventListener('mouseup', onMouseUp, true);
      window.addEventListener('blur', stop);
      document.addEventListener('selectionchange', onSelectionChange);
    };

    surface.addEventListener('pointerdown', onPointerDown);
    return () => {
      surface.removeEventListener('pointerdown', onPointerDown);
      stop();
    };
  }, [surfaceRef]);
}
