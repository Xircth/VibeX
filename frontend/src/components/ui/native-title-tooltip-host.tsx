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
};

function isMousePointer(event: PointerEvent): boolean {
  return event.pointerType === 'mouse' || event.pointerType === '';
}

export function NativeTitleTooltipHost() {
  const container = usePortalContainer();
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
      setTooltip(null);
    };

    const place = (element: Element, text: string) => {
      const node = document.querySelector<HTMLElement>(
        `.${NATIVE_TITLE_TOOLTIP_CLASS}[data-native-title-tooltip='true']`
      );
      const tooltipSize = node
        ? { width: node.offsetWidth, height: node.offsetHeight }
        : {
            width: Math.min(352, Math.max(48, text.length * 7.2)),
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
      requestAnimationFrame(() => place(element, text));
    };

    const onPointerOver = (event: PointerEvent) => {
      if (!isMousePointer(event)) return;
      const next = findTitledElement(event.target);
      const from = findTitledElement(event.relatedTarget);
      if (next === from) return;
      if (next) suppress(next);
      if (!next || isOwnedAppTooltip(next)) {
        hide();
        return;
      }
      if (next === active) return;
      hide();
      active = next;
      suppress(next);
      showTimer = window.setTimeout(() => {
        showTimer = null;
        if (active === next) show(next);
      }, NATIVE_TITLE_SHOW_DELAY_MS);
    };

    const onPointerDown = () => hide();
    const onKeyDown = () => hide();
    const onScroll = () => hide();
    const onBlur = () => hide();

    document.addEventListener('pointerover', onPointerOver, true);
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
    </div>
  );

  return createPortal(node, container ?? document.body);
}
