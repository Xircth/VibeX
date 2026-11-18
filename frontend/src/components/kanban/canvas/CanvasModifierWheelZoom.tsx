import { useEffect, useRef } from 'react';
import { useReactFlow, useStore } from '@xyflow/react';
import { isMac } from '@/utils/platform';
import {
  isCanvasModifierZoomWheel,
  nextCanvasModifierZoom,
} from './canvasModifierZoom';

/**
 * React Flow refuses wheel gestures whose target sits inside `.nowheel`.
 * Expanded canvas nodes use that class so a plain scroll moves the thread
 * instead of the board. Capture Ctrl/Cmd+wheel on the flow root first and
 * zoom toward the pointer even when it is over a node.
 */
export function CanvasModifierWheelZoom({
  minZoom,
  maxZoom,
}: {
  minZoom: number;
  maxZoom: number;
}) {
  const { getViewport, setViewport } = useReactFlow();
  const domNode = useStore((state) => state.domNode);
  const getViewportRef = useRef(getViewport);
  const setViewportRef = useRef(setViewport);
  getViewportRef.current = getViewport;
  setViewportRef.current = setViewport;

  useEffect(() => {
    if (!domNode) return;
    const onWheel = (event: WheelEvent) => {
      if (!isCanvasModifierZoomWheel(event)) return;
      event.preventDefault();
      event.stopPropagation();
      const bounds = domNode.getBoundingClientRect();
      const next = nextCanvasModifierZoom({
        viewport: getViewportRef.current(),
        pointerX: event.clientX - bounds.left,
        pointerY: event.clientY - bounds.top,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        pinchBoost: event.ctrlKey && isMac(),
        minZoom,
        maxZoom,
      });
      void setViewportRef.current(next);
    };
    domNode.addEventListener('wheel', onWheel, {
      capture: true,
      passive: false,
    });
    return () => {
      domNode.removeEventListener('wheel', onWheel, { capture: true });
    };
  }, [domNode, maxZoom, minZoom]);

  return null;
}
