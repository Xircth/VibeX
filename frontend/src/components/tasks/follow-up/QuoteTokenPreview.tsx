import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Markdown } from '@astryxdesign/core/Markdown';
import { usePortalContainer } from '@/contexts/PortalContainerContext';

export function QuoteTokenPreview({
  anchor,
  id,
  text,
  onPointerEnter,
  onPointerLeave,
}: {
  anchor: HTMLElement;
  id?: string;
  text: string;
  onPointerEnter?: () => void;
  onPointerLeave?: (event: PointerEvent<HTMLDivElement>) => void;
}) {
  const portalContainer = usePortalContainer();
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<CSSProperties>({
    left: 0,
    top: 0,
    visibility: 'hidden',
  });

  useLayoutEffect(() => {
    const updatePosition = () => {
      const tooltip = tooltipRef.current;
      if (!tooltip || !anchor.isConnected) return;

      const anchorRect = anchor.getBoundingClientRect();
      const tooltipRect = tooltip.getBoundingClientRect();
      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = document.documentElement.clientHeight;
      const margin = 8;
      const gap = 7;
      const width = tooltipRect.width || 280;
      const height = tooltipRect.height || 160;
      const centeredLeft = anchorRect.left + anchorRect.width / 2 - width / 2;
      const left = Math.min(
        Math.max(margin, centeredLeft),
        Math.max(margin, viewportWidth - width - margin)
      );
      const preferredTop = anchorRect.top - height - gap;
      const top =
        preferredTop >= margin
          ? preferredTop
          : Math.min(
              anchorRect.bottom + gap,
              Math.max(margin, viewportHeight - height - margin)
            );

      setPosition({ left, top, visibility: 'visible' });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, {
      capture: true,
      passive: true,
    });
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [anchor, text]);

  return createPortal(
    <div
      ref={tooltipRef}
      id={id}
      role="tooltip"
      className="quote-token-preview fixed z-50 w-[min(22rem,calc(100vw-1rem))] max-h-48 overflow-y-auto overscroll-contain rounded-lg p-3 text-xs leading-5 text-foreground"
      style={position}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <div className="conv-markdown quote-token-preview-markdown break-words text-xs leading-5 text-foreground">
        <Markdown display="block" density="compact" autolink="gfm">
          {text}
        </Markdown>
      </div>
    </div>,
    portalContainer ?? document.body
  );
}
