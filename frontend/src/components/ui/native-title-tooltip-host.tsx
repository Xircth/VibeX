import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePortalContainer } from '@/contexts/PortalContainerContext';
import {
  findTitledElement,
  isOwnedAppTooltip,
  NATIVE_TITLE_SHOW_DELAY_MS,
  NATIVE_TITLE_TOOLTIP_CLASS,
  positionHoverTooltip,
  restoreNativeTitle,
  suppressNativeTitle,
} from './native-title-tooltip';

type TooltipState = {
  text: string;
  top: number;
  left: number;
  side: 'bottom' | 'top';
  arrowLeft: number;
  placed: boolean;
};

function isMousePointer(event: PointerEvent): boolean {
  return event.pointerType === 'mouse' || event.pointerType === '';
}

function unplacedTooltip(text: string): TooltipState {
  return {
    text,
    top: 0,
    left: 0,
    side: 'bottom',
    arrowLeft: 0,
    placed: false,
  };
}

export function NativeTitleTooltipHost() {
  const container = usePortalContainer();
  const tooltipRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<Element | null>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  useEffect(() => {
    let showTimer: number | null = null;
    let active: Element | null = null;
    let observer: MutationObserver | null = null;
    const suppressed = new Set<Element>();

    const clearShowTimer = () => {
      if (showTimer != null) {
        window.clearTimeout(showTimer);
        showTimer = null;
      }
    };

    const suppress = (element: Element) => {
      suppressNativeTitle(element);
      suppressed.add(element);
    };

    const hide = () => {
      clearShowTimer();
      observer?.disconnect();
      observer = null;
      active = null;
      anchorRef.current = null;
      setTooltip(null);
    };

    const place = (element: Element, text: string) => {
      anchorRef.current = element;
      // Publish text only. The measured width is not known until the capsule
      // is in the layout, and an estimate for CJK session titles is too wide,
      // so centering it would paint left of the tab and then jump.
      setTooltip(unplacedTooltip(text));
    };

    const watchTitle = (element: Element) => {
      observer?.disconnect();
      observer = new MutationObserver(() => {
        if (!element.hasAttribute('title')) return;
        suppress(element);
        const text = suppressNativeTitle(element);
        if (!text) {
          hide();
          return;
        }
        place(element, text);
      });
      observer.observe(element, {
        attributes: true,
        attributeFilter: ['title'],
      });
    };

    const show = (element: Element) => {
      suppress(element);
      const text = suppressNativeTitle(element);
      if (!text) {
        hide();
        return;
      }
      active = element;
      watchTitle(element);
      place(element, text);
    };

    const onPointerOver = (event: PointerEvent) => {
      if (!isMousePointer(event)) return;
      const next = findTitledElement(event.target);
      const from = findTitledElement(event.relatedTarget);
      if (next) suppress(next);
      if (!next || isOwnedAppTooltip(next)) {
        hide();
        return;
      }
      if (next === from || next === active) return;
      hide();
      active = next;
      suppress(next);
      showTimer = window.setTimeout(() => {
        showTimer = null;
        if (active === next) show(next);
      }, NATIVE_TITLE_SHOW_DELAY_MS);
    };

    const onPointerOut = (event: PointerEvent) => {
      if (!active) return;
      const from = findTitledElement(event.target);
      if (from !== active) return;
      const to = findTitledElement(event.relatedTarget);
      if (to === active) return;
      hide();
    };

    const onPointerDown = () => hide();
    const onKeyDown = () => hide();
    const onScroll = () => hide();
    const onBlur = () => hide();

    document.addEventListener('pointerover', onPointerOver, true);
    document.addEventListener('pointerout', onPointerOut, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.documentElement.addEventListener('pointerleave', hide);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('blur', onBlur);

    return () => {
      hide();
      for (const element of suppressed) {
        restoreNativeTitle(element);
      }
      suppressed.clear();
      document.removeEventListener('pointerover', onPointerOver, true);
      document.removeEventListener('pointerout', onPointerOut, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      document.documentElement.removeEventListener('pointerleave', hide);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  useLayoutEffect(() => {
    if (!tooltip || tooltip.placed) return;
    const node = tooltipRef.current;
    const anchor = anchorRef.current;
    if (!node || !anchor || node.offsetWidth <= 0 || node.offsetHeight <= 0) {
      return;
    }
    const next = positionHoverTooltip(
      anchor.getBoundingClientRect(),
      { width: node.offsetWidth, height: node.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight }
    );
    setTooltip({ text: tooltip.text, ...next, placed: true });
  }, [tooltip]);

  if (!tooltip) return null;

  const node = (
    <div
      ref={tooltipRef}
      role="tooltip"
      data-native-title-tooltip="true"
      data-placed={tooltip.placed ? 'true' : undefined}
      data-side={tooltip.side}
      className={NATIVE_TITLE_TOOLTIP_CLASS}
      style={{
        position: 'fixed',
        top: tooltip.top,
        left: tooltip.left,
        zIndex: 10000,
        visibility: tooltip.placed ? 'visible' : 'hidden',
        pointerEvents: 'none',
      }}
    >
      {tooltip.text}
      <span
        aria-hidden="true"
        className="app-hover-tooltip-native-arrow"
        data-side={tooltip.side}
        style={{ left: tooltip.arrowLeft }}
      />
    </div>
  );

  return createPortal(node, container ?? document.body);
}
