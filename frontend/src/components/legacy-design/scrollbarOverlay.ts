export const THUMB_PX = 6;
export const EDGE_INSET = 0;
const MIN_THUMB = 24;
const HIDE_DELAY_MS = 700;

const SKIP =
  '.monaco-editor, .monaco-scrollable-element, .dv-tabs-and-actions-container, .dv-scrollable, .composer-at-reference-tabs, [data-overlay-scrollbar="off"]';

export function thumbGeometry(input: {
  clientSize: number;
  scrollSize: number;
  scrollOffset: number;
  trackSize: number;
  minThumb: number;
}): { size: number; offset: number } | null {
  const overflow = input.scrollSize - input.clientSize;
  if (overflow <= 1 || input.trackSize <= 1) return null;
  const size = Math.min(
    input.trackSize,
    Math.max(
      input.minThumb,
      (input.clientSize / input.scrollSize) * input.trackSize
    )
  );
  const travel = Math.max(0, input.trackSize - size);
  const offset = Math.min(
    travel,
    Math.max(0, (input.scrollOffset / overflow) * travel)
  );
  return { size, offset };
}

function isShownScroller(el: HTMLElement): boolean {
  if (!el.isConnected || el.getClientRects().length === 0) return false;
  const style = getComputedStyle(el);
  return style.visibility !== 'hidden' && style.visibility !== 'collapse';
}

function canScroll(el: HTMLElement, axis: 'x' | 'y'): boolean {
  const style = getComputedStyle(el);
  const overflow = axis === 'y' ? style.overflowY : style.overflowX;
  if (overflow !== 'auto' && overflow !== 'scroll' && overflow !== 'overlay') {
    return false;
  }
  if (axis === 'y') return el.scrollHeight - el.clientHeight > 1;
  return el.scrollWidth - el.clientWidth > 1;
}

export function findScroller(
  target: EventTarget | null,
  axis: 'x' | 'y'
): HTMLElement | null {
  if (!(target instanceof Element) || target.closest(SKIP)) return null;
  let node: Element | null = target;
  while (node) {
    if (node instanceof HTMLElement && canScroll(node, axis)) return node;
    node = node.parentElement;
  }
  return null;
}

function placeThumb(
  thumb: HTMLElement,
  scroller: HTMLElement,
  axis: 'x' | 'y'
): boolean {
  const rect = scroller.getBoundingClientRect();
  const viewport = axis === 'y' ? window.innerHeight : window.innerWidth;
  const start = Math.max(axis === 'y' ? rect.top : rect.left, 0);
  const end = Math.min(axis === 'y' ? rect.bottom : rect.right, viewport);
  const geo = thumbGeometry({
    clientSize: axis === 'y' ? scroller.clientHeight : scroller.clientWidth,
    scrollSize: axis === 'y' ? scroller.scrollHeight : scroller.scrollWidth,
    scrollOffset: axis === 'y' ? scroller.scrollTop : scroller.scrollLeft,
    trackSize: end - start,
    minThumb: MIN_THUMB,
  });
  if (!geo) {
    thumb.classList.remove('is-visible');
    return false;
  }
  if (axis === 'y') {
    thumb.style.top = `${start + geo.offset}px`;
    thumb.style.left = `${rect.right - THUMB_PX - EDGE_INSET}px`;
    thumb.style.width = `${THUMB_PX}px`;
    thumb.style.height = `${geo.size}px`;
  } else {
    thumb.style.left = `${start + geo.offset}px`;
    thumb.style.top = `${rect.bottom - THUMB_PX - EDGE_INSET}px`;
    thumb.style.height = `${THUMB_PX}px`;
    thumb.style.width = `${geo.size}px`;
  }
  thumb.classList.add('is-visible');
  return true;
}

export function attachOverlayScrollbars(
  root: Document,
  thumbs: { vertical: HTMLElement; horizontal: HTMLElement }
): () => void {
  let active: HTMLElement | null = null;
  let pointerInside = false;
  let dragging: 'x' | 'y' | null = null;
  let hideTimer = 0;
  let frame = 0;

  const hideNow = () => {
    window.clearTimeout(hideTimer);
    thumbs.vertical.classList.remove('is-visible');
    thumbs.horizontal.classList.remove('is-visible');
  };

  const scheduleHide = () => {
    window.clearTimeout(hideTimer);
    if (dragging || pointerInside) return;
    hideTimer = window.setTimeout(() => {
      if (dragging || pointerInside) return;
      hideNow();
    }, HIDE_DELAY_MS);
  };

  const release = () => {
    observer.disconnect();
    resizeObserver.disconnect();
    active = null;
    pointerInside = false;
    hideNow();
  };

  const place = (scroller: HTMLElement) => {
    if (!isShownScroller(scroller)) {
      release();
      return;
    }
    const vertical = placeThumb(thumbs.vertical, scroller, 'y');
    const horizontal = placeThumb(thumbs.horizontal, scroller, 'x');
    if (!vertical && !horizontal) scheduleHide();
  };

  const schedulePlace = (scroller: HTMLElement) => {
    window.cancelAnimationFrame(frame);
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      if (active === scroller) place(scroller);
    });
  };

  const observer = new MutationObserver(() => {
    if (active) schedulePlace(active);
  });
  const resizeObserver = new ResizeObserver(() => {
    if (!active) return;
    if (!isShownScroller(active)) {
      release();
      return;
    }
    schedulePlace(active);
  });

  const watch = (scroller: HTMLElement | null) => {
    observer.disconnect();
    resizeObserver.disconnect();
    active = scroller;
    if (!scroller) {
      hideNow();
      return;
    }
    observer.observe(scroller, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    resizeObserver.observe(scroller);
    place(scroller);
  };

  const syncFrom = (target: EventTarget | null, inside: boolean) => {
    if (
      target instanceof Element &&
      target.closest('.overlay-scrollbar-thumb')
    ) {
      return;
    }
    const vertical = findScroller(target, 'y');
    const horizontal = findScroller(target, 'x');
    const next = vertical ?? horizontal;
    pointerInside = inside && next !== null;
    if (next !== active) watch(next);
    else if (next) place(next);
    if (!next) hideNow();
  };

  const onPointer = (event: Event) => {
    syncFrom(event.target, true);
  };
  const onScroll = (event: Event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.closest(SKIP)) return;
    if (!canScroll(target, 'y') && !canScroll(target, 'x')) return;
    if (target !== active) watch(target);
    else place(target);
    if (!pointerInside) scheduleHide();
  };

  const bindDrag = (thumb: HTMLElement, axis: 'x' | 'y') => {
    let startPointer = 0;
    let startScroll = 0;
    let travel = 1;
    let overflow = 0;
    const onDown = (event: PointerEvent) => {
      if (!active || event.button !== 0) return;
      dragging = axis;
      thumb.classList.add('is-dragging');
      startPointer = axis === 'y' ? event.clientY : event.clientX;
      startScroll = axis === 'y' ? active.scrollTop : active.scrollLeft;
      const client = axis === 'y' ? active.clientHeight : active.clientWidth;
      const scroll = axis === 'y' ? active.scrollHeight : active.scrollWidth;
      const thumbSize = axis === 'y' ? thumb.offsetHeight : thumb.offsetWidth;
      travel = Math.max(1, client - thumbSize);
      overflow = Math.max(1, scroll - client);
      thumb.setPointerCapture(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    };
    const onMove = (event: PointerEvent) => {
      if (dragging !== axis || !active) return;
      const pointer = axis === 'y' ? event.clientY : event.clientX;
      const delta = ((pointer - startPointer) / travel) * overflow;
      if (axis === 'y') active.scrollTop = startScroll + delta;
      else active.scrollLeft = startScroll + delta;
      event.preventDefault();
    };
    const onUp = () => {
      if (dragging !== axis) return;
      dragging = null;
      thumb.classList.remove('is-dragging');
      if (!pointerInside) scheduleHide();
    };
    thumb.addEventListener('pointerdown', onDown);
    thumb.addEventListener('pointermove', onMove);
    thumb.addEventListener('pointerup', onUp);
    thumb.addEventListener('pointercancel', onUp);
    return () => {
      thumb.removeEventListener('pointerdown', onDown);
      thumb.removeEventListener('pointermove', onMove);
      thumb.removeEventListener('pointerup', onUp);
      thumb.removeEventListener('pointercancel', onUp);
    };
  };

  const unbindVertical = bindDrag(thumbs.vertical, 'y');
  const unbindHorizontal = bindDrag(thumbs.horizontal, 'x');
  const onPointerDown = () => {
    window.requestAnimationFrame(() => {
      if (active && !isShownScroller(active)) release();
    });
  };
  root.addEventListener('pointerover', onPointer, true);
  root.addEventListener('pointerdown', onPointerDown, true);
  root.addEventListener('scroll', onScroll, true);

  return () => {
    window.clearTimeout(hideTimer);
    window.cancelAnimationFrame(frame);
    observer.disconnect();
    resizeObserver.disconnect();
    root.removeEventListener('pointerover', onPointer, true);
    root.removeEventListener('pointerdown', onPointerDown, true);
    root.removeEventListener('scroll', onScroll, true);
    unbindVertical();
    unbindHorizontal();
  };
}
