export type BrowserSurfaceRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

const CANVAS_STAGE_CLIP_SELECTOR =
  '[data-canvas-surface], [data-testid="workspace-canvas-stage"], .react-flow, .workspace-stage-host';

const CANVAS_FLOATING_CHROME_SELECTOR = [
  '.session-canvas-floating-panel',
  '[data-dock-position="bottom"]',
  '[data-dock-position] .pointer-events-auto',
  '[data-viewport-position] .pointer-events-auto',
  '[data-testid="canvas-creation-panel"] .pointer-events-auto',
].join(',');

export function intersectBrowserSurfaceRects(
  a: BrowserSurfaceRect,
  b: BrowserSurfaceRect
): BrowserSurfaceRect {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.max(left, Math.min(a.right, b.right));
  const bottom = Math.max(top, Math.min(a.bottom, b.bottom));
  return { left, top, right, bottom };
}

export function browserSurfaceRectsOverlap(
  a: BrowserSurfaceRect,
  b: BrowserSurfaceRect
): boolean {
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  return right - Math.max(a.left, b.left) >= 1 && bottom - Math.max(a.top, b.top) >= 1;
}

/**
 * Intersect a browser host rect with enclosing stage/canvas clip containers so
 * a native child WebView panned near the edge of Infinite Canvas never bleeds
 * over the top toolbar, activity rail, dock sidebars, or status bar.
 */
export function clipBrowserSurfaceRect(
  host: HTMLElement | null,
  rect: BrowserSurfaceRect
): BrowserSurfaceRect {
  if (!host) return rect;
  let clipped = rect;
  let parent = host.parentElement;
  while (parent && parent !== document.body && parent !== document.documentElement) {
    if (parent.matches(CANVAS_STAGE_CLIP_SELECTOR)) {
      const bounds = parent.getBoundingClientRect();
      if (bounds.width > 0 && bounds.height > 0) {
        clipped = intersectBrowserSurfaceRects(clipped, bounds);
      }
    }
    parent = parent.parentElement;
  }
  return clipped;
}

function parseFlowNodeZIndex(node: HTMLElement): number {
  const inline = Number.parseInt(node.style.zIndex || '', 10);
  if (Number.isFinite(inline)) return inline;
  return 0;
}

/**
 * Detect whether a browser surface mounted inside React Flow's Infinite Canvas
 * is overlapped by a higher-stacking canvas node (whose header/close button
 * must remain visible and clickable) or by floating canvas chrome controls.
 */
export function canvasLayerCoversBrowser(host: HTMLElement | null): boolean {
  if (!host) return false;
  const flowRoot = host.closest('.react-flow');
  if (!flowRoot) return false;

  const raw = host.getBoundingClientRect();
  if (raw.width < 2 || raw.height < 2) return false;
  const clipped = clipBrowserSurfaceRect(host, raw);
  if (clipped.right - clipped.left < 2 || clipped.bottom - clipped.top < 2) {
    return false;
  }

  const ownNode = host.closest('.react-flow__node') as HTMLElement | null;
  if (ownNode) {
    const ownZ = parseFlowNodeZIndex(ownNode);
    const allNodes = flowRoot.querySelectorAll<HTMLElement>('.react-flow__node');
    for (const otherNode of allNodes) {
      if (
        otherNode === ownNode ||
        otherNode.contains(ownNode) ||
        ownNode.contains(otherNode)
      ) {
        continue;
      }
      if (
        otherNode.hasAttribute('hidden') ||
        otherNode.getAttribute('aria-hidden') === 'true'
      ) {
        continue;
      }
      const otherZ = parseFlowNodeZIndex(otherNode);
      const stacksAbove =
        otherZ > ownZ ||
        (otherZ === ownZ &&
          Boolean(
            ownNode.compareDocumentPosition(otherNode) &
              Node.DOCUMENT_POSITION_FOLLOWING
          ));
      if (!stacksAbove) continue;
      if (browserSurfaceRectsOverlap(clipped, otherNode.getBoundingClientRect())) {
        return true;
      }
    }
  }

  const canvasSurface =
    host.closest('[data-canvas-surface]') ?? flowRoot.parentElement;
  if (canvasSurface) {
    const chromeNodes = canvasSurface.querySelectorAll<HTMLElement>(
      CANVAS_FLOATING_CHROME_SELECTOR
    );
    for (const chrome of chromeNodes) {
      if (chrome.contains(host)) continue;
      if (
        chrome.hasAttribute('hidden') ||
        chrome.getAttribute('aria-hidden') === 'true'
      ) {
        continue;
      }
      if (browserSurfaceRectsOverlap(clipped, chrome.getBoundingClientRect())) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Snap a CSS rect onto the device pixel grid by rounding each edge, then
 * deriving size from those edges. Independent rounding of `x` and `width`
 * can make the native child one physical pixel wider than the HTML host,
 * which covers the dock sash while the freeze-frame (clipped to the host)
 * does not.
 */
export function snapBrowserSurfaceRect(
  rect: BrowserSurfaceRect,
  scale: number
): { x: number; y: number; width: number; height: number } {
  const s = scale > 0 ? scale : 1;
  const x = Math.round(rect.left * s) / s;
  const y = Math.round(rect.top * s) / s;
  const right = Math.round(rect.right * s) / s;
  const bottom = Math.round(rect.bottom * s) / s;
  return {
    x,
    y,
    width: Math.max(1 / s, right - x),
    height: Math.max(1 / s, bottom - y),
  };
}
