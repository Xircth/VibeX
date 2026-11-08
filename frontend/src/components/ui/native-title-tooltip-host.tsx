import { useEffect, useState } from 'react';
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
};

function isMousePointer(event: PointerEvent): boolean {
  return event.pointerType === 'mouse' || event.pointerType === '';
}

function estimateTooltipWidth(text: string): number {
  let width = 24;
  for (const ch of text) {
    width += ch.charCodeAt(0) > 0x7f ? 12.5 : 7.2;
  }
  return Math.min(352, Math.max(48, Math.ceil(width)));
}

export function NativeTitleTooltipHost() {
  const container = usePortalContainer();
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  useEffect(() => {
    let showTimer: number | null = null;
    let rafId: number | null = null;
    let active: Element | null = null;
    let observer: MutationObserver | null = null;
    const suppressed = new Set<Element>();

    const clearShowTimer = () => {
      if (showTimer != null) {
        window.clearTimeout(showTimer);
        showTimer = null;
      }
      if (rafId != null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
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
      setTooltip(null);
    };

    const place = (element: Element, text: string) => {
      const node = document.querySelector<HTMLElement>(
        `.${NATIVE_TITLE_TOOLTIP_CLASS}[data-native-title-tooltip='true']`
      );
      const tooltipSize =
        node && node.offsetWidth > 0 && node.offsetHeight > 0
          ? { width: node.offsetWidth, height: node.offsetHeight }
          : {
              width: estimateTooltipWidth(text),
              height: 28,
            };
      const next = positionHoverTooltip(
        element.getBoundingClientRect(),
        tooltipSize,
        { width: window.innerWidth, height: window.innerHeight }
      );
      setTooltip({ text, ...next });
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
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        if (active === element) place(element, text);
      });
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

  if (!tooltip) return null;

  const node = (
    <div
      role="tooltip"
      data-native-title-tooltip="true"
      data-side={tooltip.side}
      className={NATIVE_TITLE_TOOLTIP_CLASS}
      style={{
        position: 'fixed',
        top: tooltip.top,
        left: tooltip.left,
        zIndex: 10000,
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
