import type { OverlayRect } from '@/lib/nativeSurfaceOverlay';

/**
 * One contract for every HTML layer that must sit above a native browser
 * HWND. CSS z-index cannot win against a child WebView; the overlay observer
 * uses these marks to freeze-then-hide the native page.
 *
 * `modal` hides the whole surface (dialogs, palettes). `popover` publishes a
 * rectangle so only overlapping native pages step aside.
 */
export const FLOATING_LAYER_ATTR = 'data-floating-layer';

export const FLOATING_LAYER_SELECTOR = [
  `[${FLOATING_LAYER_ATTR}]`,
  '[data-native-surface-occlusion]',
  '[role="dialog"][aria-modal="true"]',
  '[data-radix-popper-content-wrapper]',
  '[data-radix-menu-content]',
  '[data-radix-dropdown-menu-content]',
  '[data-radix-select-content]',
  '[data-radix-popover-content]',
  '[data-radix-context-menu-content]',
  '[data-radix-hover-card-content]',
  '.astryx-select-menu',
].join(',');

export type FloatingLayerKind = 'modal' | 'popover';

export type FloatingLayerOcclusion = {
  hide: boolean;
  rects: OverlayRect[];
};

const EMPTY: FloatingLayerOcclusion = { hide: false, rects: [] };

export function isModalFloatingLayer(element: Element): boolean {
  if (element.getAttribute(FLOATING_LAYER_ATTR) === 'modal') return true;
  if (element.getAttribute('aria-modal') === 'true') return true;
  return false;
}

function isInactiveLayer(element: Element): boolean {
  if (element.getAttribute('data-state') === 'closed') return true;
  if (element.hasAttribute('hidden')) return true;
  return false;
}

function boxOf(element: Element): OverlayRect | null {
  const target = element.hasAttribute('data-native-surface-occlusion')
    ? element.parentElement
    : element;
  if (!target) return null;
  const rect = target.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return null;
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

function rectKey(rect: OverlayRect): string {
  return `${Math.round(rect.x)}:${Math.round(rect.y)}:${Math.round(rect.width)}:${Math.round(rect.height)}`;
}

export function uniqueOverlayRects(
  rects: readonly OverlayRect[]
): OverlayRect[] {
  const seen = new Set<string>();
  const unique: OverlayRect[] = [];
  for (const rect of rects) {
    const key = rectKey(rect);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(rect);
  }
  return unique;
}

export function collectFloatingLayers(
  root: ParentNode | null | undefined
): FloatingLayerOcclusion {
  if (!root || typeof root.querySelectorAll !== 'function') return EMPTY;
  const nodes = root.querySelectorAll(FLOATING_LAYER_SELECTOR);
  const rects: OverlayRect[] = [];
  let hide = false;
  for (const node of nodes) {
    if (isInactiveLayer(node)) continue;
    const modal = isModalFloatingLayer(node);
    if (modal) hide = true;
    const box = boxOf(node);
    if (!box) continue;
    rects.push(box);
  }
  return { hide, rects: uniqueOverlayRects(rects) };
}

export function mergeFloatingLayerOcclusion(
  layers: readonly FloatingLayerOcclusion[]
): FloatingLayerOcclusion {
  return {
    hide: layers.some((layer) => layer.hide),
    rects: uniqueOverlayRects(layers.flatMap((layer) => layer.rects)),
  };
}

function elementTouchesFloatingLayer(element: Element): boolean {
  return (
    element.matches(FLOATING_LAYER_SELECTOR) ||
    Boolean(element.querySelector(FLOATING_LAYER_SELECTOR))
  );
}

/** True when a mutation might have mounted, unmounted, or moved a floating layer. */
export function mutationTouchesFloatingLayer(
  records: Iterable<MutationRecord>
): boolean {
  for (const record of records) {
    if (record.type === 'attributes') {
      const target = record.target;
      if (
        target instanceof Element &&
        (target.matches(FLOATING_LAYER_SELECTOR) ||
          target.closest(FLOATING_LAYER_SELECTOR))
      ) {
        return true;
      }
      continue;
    }
    for (const node of record.addedNodes) {
      if (node instanceof Element && elementTouchesFloatingLayer(node)) {
        return true;
      }
    }
    for (const node of record.removedNodes) {
      if (node instanceof Element && elementTouchesFloatingLayer(node)) {
        return true;
      }
    }
  }
  return false;
}
