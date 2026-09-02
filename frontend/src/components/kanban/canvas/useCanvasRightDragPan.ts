import { useEffect, type RefObject } from 'react';
import { useReactFlow } from '@xyflow/react';

const PAN_EXEMPT_SELECTOR = '.react-flow__panel, .react-flow__minimap';

function isPanButton(button: number): boolean {
  return button === 1 || button === 2;
}

export function useCanvasRightDragPan(
  surfaceRef: RefObject<HTMLElement | null>
): void {
  const { getViewport, setViewport } = useReactFlow();

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;

    let origin: {
      clientX: number;
      clientY: number;
      x: number;
      y: number;
      zoom: number;
    } | null = null;

    const stop = () => {
      if (!origin) return;
      origin = null;
      surface.removeAttribute('data-canvas-panning');
      window.removeEventListener('mousemove', onMouseMove, true);
      window.removeEventListener('mouseup', onMouseUp, true);
      window.removeEventListener('blur', stop);
    };

    const PAN_BUTTONS_MASK = 6;

    const onMouseMove = (event: MouseEvent) => {
      if (!origin) return;
      if ((event.buttons & PAN_BUTTONS_MASK) === 0) {
        stop();
        return;
      }
      setViewport({
        x: origin.x + (event.clientX - origin.clientX),
        y: origin.y + (event.clientY - origin.clientY),
        zoom: origin.zoom,
      });
    };

    const onMouseUp = (event: MouseEvent) => {
      if (!origin || !isPanButton(event.button)) return;
      stop();
    };

    const onMouseDown = (event: MouseEvent) => {
      if (!isPanButton(event.button)) return;
      if (!(event.target instanceof Element)) return;
      if (event.target.closest(PAN_EXEMPT_SELECTOR)) return;
      event.preventDefault();
      event.stopPropagation();
      const viewport = getViewport();
      origin = {
        clientX: event.clientX,
        clientY: event.clientY,
        x: viewport.x,
        y: viewport.y,
        zoom: viewport.zoom,
      };
      surface.setAttribute('data-canvas-panning', '');
      window.addEventListener('mousemove', onMouseMove, true);
      window.addEventListener('mouseup', onMouseUp, true);
      window.addEventListener('blur', stop);
    };

    surface.addEventListener('mousedown', onMouseDown, true);
    return () => {
      surface.removeEventListener('mousedown', onMouseDown, true);
      stop();
    };
  }, [getViewport, setViewport, surfaceRef]);
}
