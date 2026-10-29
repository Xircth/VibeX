import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { createPortal } from 'react-dom';
import { MousePointer2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { usePortalContainer } from '@/contexts/PortalContainerContext';

import { type SessionComposerStructuredToken } from '../sessionComposerStructuredTokens';

import {
  parsePreviewElementTokenDetails,
  rectsOverlap,
} from './composerSearch';

export function elementTooltipTop({
  anchorTop,
  anchorBottom,
  height,
  gap,
  margin,
  viewportHeight,
  left,
  width,
  blocked,
}: {
  anchorTop: number;
  anchorBottom: number;
  height: number;
  gap: number;
  margin: number;
  viewportHeight: number;
  left: number;
  width: number;
  blocked: Array<Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom'>>;
}): number {
  const above = anchorTop - height - gap;
  const below = anchorBottom + gap;
  const fits = (top: number) =>
    top >= margin &&
    top + height <= viewportHeight - margin &&
    !blocked.some((rect) => rectsOverlap(left, top, width, height, rect));
  if (fits(below)) return below;
  if (fits(above)) return above;
  return Math.min(below, Math.max(margin, viewportHeight - height - margin));
}

export function nativeBrowserSurfaces(): DOMRect[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      '[data-testid="host-browser-surface"]'
    )
  )
    .map((element) => element.getBoundingClientRect())
    .filter((rect) => rect.width > 2 && rect.height > 2);
}

export function PreviewElementTokenTooltip({
  anchor,
  id,
  token,
}: {
  anchor: HTMLElement;
  id: string;
  token: SessionComposerStructuredToken;
}) {
  const { t } = useTranslation('tasks');
  const portalContainer = usePortalContainer();
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<CSSProperties>({
    left: 0,
    top: 0,
    visibility: 'hidden',
  });
  const details = useMemo(
    () => parsePreviewElementTokenDetails(token),
    [token]
  );

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
      const width = tooltipRect.width || 320;
      const height = tooltipRect.height || 160;
      const centeredLeft = anchorRect.left + anchorRect.width / 2 - width / 2;
      const left = Math.min(
        Math.max(margin, centeredLeft),
        Math.max(margin, viewportWidth - width - margin)
      );
      const top = elementTooltipTop({
        anchorTop: anchorRect.top,
        anchorBottom: anchorRect.bottom,
        height,
        gap,
        margin,
        viewportHeight,
        left,
        width,
        blocked: nativeBrowserSurfaces(),
      });

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
  }, [anchor]);

  const content = (
    <div
      ref={tooltipRef}
      id={id}
      role="tooltip"
      className="pointer-events-none fixed z-[2147483646] w-[min(22rem,calc(100vw-1rem))] rounded-lg bg-transparent p-3 text-xs text-foreground shadow-none"
      style={position}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[hsl(var(--primary)/0.12)] text-primary">
          <MousePointer2 className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
        <span className="min-w-0">
          <span className="block truncate font-medium text-foreground">
            {token.label}
          </span>
          <span className="block text-xs text-muted-foreground">
            {t('composer.elementToken.type')}
          </span>
        </span>
      </div>

      <dl className="mt-2.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1.5">
        {details.dom ? (
          <>
            <dt className="text-muted-foreground">DOM</dt>
            <dd className="min-w-0 truncate font-mono text-xs text-foreground">
              {details.dom}
            </dd>
          </>
        ) : null}
        {details.source ? (
          <>
            <dt className="text-muted-foreground">
              {t('composer.elementToken.source')}
            </dt>
            <dd className="min-w-0 truncate font-mono text-xs text-foreground">
              {details.source}
            </dd>
          </>
        ) : null}
        {details.selector ? (
          <>
            <dt className="text-muted-foreground">
              {t('composer.elementToken.selector')}
            </dt>
            <dd className="min-w-0 truncate font-mono text-xs text-foreground">
              {details.selector}
            </dd>
          </>
        ) : null}
      </dl>

      {details.html ? (
        <div className="mt-2.5 border-t border-border/60 pt-2">
          <div className="mb-1 text-xs text-muted-foreground">
            {t('composer.elementToken.html')}
          </div>
          <pre className="max-h-20 overflow-hidden whitespace-pre-wrap break-all rounded-md bg-[var(--surface-control)] px-2 py-1.5 font-mono text-xs leading-4 text-foreground">
            {details.html.slice(0, 600)}
            {details.html.length > 600 ? '…' : ''}
          </pre>
        </div>
      ) : null}
    </div>
  );

  return createPortal(content, portalContainer ?? document.body);
}
