import { useEffect, type RefObject } from 'react';

export const NESTED_SCROLL_ATTR = 'data-nested-scroll';

const EDGE_PX = 1;
const LINE_HEIGHT_PX = 16;
const PAGE_HEIGHT_PX = 800;

export type ScrollMetrics = {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  /** Session transcript. Leave its wheel to the browser. */
  conversation?: boolean;
};

export type NestedWheelResult =
  | { kind: 'native' }
  | { kind: 'scroll'; index: number };

export function canConsume(metrics: ScrollMetrics, deltaY: number): boolean {
  if (metrics.conversation || deltaY === 0) return false;
  const overflow = metrics.scrollHeight - metrics.clientHeight;
  if (overflow <= EDGE_PX) return false;
  if (deltaY < 0 && metrics.scrollTop <= EDGE_PX) return false;
  if (deltaY > 0 && metrics.scrollTop >= overflow - EDGE_PX) return false;
  return true;
}

/**
 * Innermost nested pane that can still move. A pane at its top or bottom
 * yields to the next nested pane. The conversation transcript is never
 * scrolled here, so the browser can move it by one native wheel step.
 */
export function nestedWheelResult(
  layers: ScrollMetrics[],
  deltaY: number
): NestedWheelResult {
  const index = layers.findIndex((layer) => canConsume(layer, deltaY));
  if (index === -1) return { kind: 'native' };
  return { kind: 'scroll', index };
}

export function wheelDeltaPixels(
  event: Pick<WheelEvent, 'deltaY' | 'deltaMode'>
): number {
  if (event.deltaMode === 1) return event.deltaY * LINE_HEIGHT_PX;
  if (event.deltaMode === 2) return event.deltaY * PAGE_HEIGHT_PX;
  return event.deltaY;
}

export function isNestedScroller(el: Element): el is HTMLElement {
  return (
    el instanceof HTMLElement &&
    (el.hasAttribute(NESTED_SCROLL_ATTR) ||
      el.getAttribute('data-panel') === 'conversation-logs')
  );
}

export function collectNestedScrollers(from: HTMLElement): HTMLElement[] {
  const layers: HTMLElement[] = [];
  let current: HTMLElement | null = from;
  while (current) {
    if (isNestedScroller(current)) layers.push(current);
    current = current.parentElement;
  }
  return layers;
}

function wheelOrigin(event: WheelEvent): HTMLElement | null {
  const target = event.target;
  if (target instanceof HTMLElement) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
}

function metricsFor(el: HTMLElement): ScrollMetrics {
  return {
    scrollTop: el.scrollTop,
    clientHeight: el.clientHeight,
    scrollHeight: el.scrollHeight,
    conversation: el.getAttribute('data-panel') === 'conversation-logs',
  };
}

export function bindNestedWheel(node: HTMLElement): () => void {
  const onWheel = (event: WheelEvent) => {
    if (event.ctrlKey || event.deltaY === 0) return;
    const origin = wheelOrigin(event);
    if (!origin) return;
    const elements = collectNestedScrollers(origin);
    const result = nestedWheelResult(
      elements.map(metricsFor),
      wheelDeltaPixels(event)
    );
    if (result.kind !== 'scroll') return;
    const target = elements[result.index];
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    target.scrollTop += wheelDeltaPixels(event);
  };
  // Must be active so preventDefault wins over the transcript's native wheel.
  // Otherwise stopPropagation leaves the nested pane unmoved.
  node.addEventListener('wheel', onWheel, { passive: false });
  return () => node.removeEventListener('wheel', onWheel);
}

export function useNestedWheel(
  ref: RefObject<HTMLElement | null>,
  options: { enabled?: boolean } = {}
) {
  const enabled = options.enabled ?? true;
  useEffect(() => {
    if (!enabled) return;
    const node = ref.current;
    if (!node) return;
    return bindNestedWheel(node);
  }, [enabled, ref]);
}
