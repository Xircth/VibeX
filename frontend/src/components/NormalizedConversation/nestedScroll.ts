import { useEffect, type RefObject } from 'react';

export const NESTED_SCROLL_ATTR = 'data-nested-scroll';

const EDGE_PX = 1;
const LINE_HEIGHT_PX = 16;
const PAGE_HEIGHT_PX = 800;

export type ScrollMetrics = {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  locked?: boolean;
};

export type NestedWheelResult =
  | { kind: 'native' }
  | { kind: 'inner' }
  | { kind: 'forward'; index: number };

export function hasOverflow(metrics: ScrollMetrics): boolean {
  return metrics.scrollHeight - metrics.clientHeight > EDGE_PX;
}

export function canConsume(metrics: ScrollMetrics, deltaY: number): boolean {
  if (metrics.locked) return false;
  const overflow = metrics.scrollHeight - metrics.clientHeight;
  if (overflow <= EDGE_PX) return false;
  if (deltaY < 0 && metrics.scrollTop <= EDGE_PX) return false;
  if (deltaY > 0 && metrics.scrollTop >= overflow - EDGE_PX) return false;
  return true;
}

/**
 * Innermost-first nested scrollers. No overflow / locked panes leave the
 * wheel to the browser so parent scrolling stays native and smooth. An
 * overflowing pane at its edge forwards to the next layer that can move.
 */
export function nestedWheelResult(
  layers: ScrollMetrics[],
  deltaY: number
): NestedWheelResult {
  const inner = layers[0];
  if (!inner) return { kind: 'native' };
  if (inner.locked || !hasOverflow(inner)) return { kind: 'native' };
  if (canConsume(inner, deltaY)) return { kind: 'inner' };
  const index = layers.findIndex(
    (layer, layerIndex) => layerIndex > 0 && canConsume(layer, deltaY)
  );
  if (index === -1) return { kind: 'native' };
  return { kind: 'forward', index };
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

export function bindNestedWheel(
  node: HTMLElement,
  options: { locked?: boolean } = {}
): () => void {
  const onWheel = (event: WheelEvent) => {
    const elements = collectNestedScrollers(node);
    const layers = elements.map((el, index) => ({
      scrollTop: el.scrollTop,
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      locked: index === 0 ? Boolean(options.locked) : false,
    }));
    const result = nestedWheelResult(layers, event.deltaY);
    // Passive: never preventDefault. Short / locked panes return immediately
    // so the compositor keeps native scrolling on the parent. Overflowing
    // panes stop bubbling so a parent binder cannot also apply the delta.
    if (result.kind === 'native') return;
    event.stopPropagation();
    if (result.kind === 'inner') return;
    const target = elements[result.index];
    if (!target) return;
    target.scrollTop += wheelDeltaPixels(event);
  };
  node.addEventListener('wheel', onWheel, { passive: true });
  return () => node.removeEventListener('wheel', onWheel);
}

export function useNestedWheel(
  ref: RefObject<HTMLElement | null>,
  options: { locked?: boolean; enabled?: boolean } = {}
) {
  const locked = Boolean(options.locked);
  const enabled = options.enabled ?? true;
  useEffect(() => {
    if (!enabled) return;
    const node = ref.current;
    if (!node) return;
    return bindNestedWheel(node, { locked });
  }, [enabled, locked, ref]);
}
