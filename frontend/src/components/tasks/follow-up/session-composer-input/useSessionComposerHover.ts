import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent,
} from 'react';
import type { SessionComposerStructuredToken } from '../sessionComposerStructuredTokens';
import {
  getHoverableTokenFromEventTarget,
  getStructuredHoverToken,
} from './composerSearch';

export function useSessionComposerHover() {
  const elementTokenTooltipId = useId();
  const quoteTokenTooltipId = useId();
  const hoverHideTimerRef = useRef<number | null>(null);
  const [activeHoverToken, setActiveHoverToken] = useState<{
    anchor: HTMLElement;
    token: SessionComposerStructuredToken;
  } | null>(null);

  const cancelHoverHide = useCallback(() => {
    if (hoverHideTimerRef.current != null) {
      window.clearTimeout(hoverHideTimerRef.current);
      hoverHideTimerRef.current = null;
    }
  }, []);

  const showTokenHover = useCallback(
    (target: EventTarget | null) => {
      const anchor = getHoverableTokenFromEventTarget(target);
      if (!anchor) return;
      const token = getStructuredHoverToken(anchor);
      if (!token) return;
      cancelHoverHide();
      setActiveHoverToken((current) =>
        current?.anchor === anchor && current.token.raw === token.raw
          ? current
          : { anchor, token }
      );
    },
    [cancelHoverHide]
  );

  const hideTokenHover = useCallback(
    (anchor: HTMLElement, delayMs = 0) => {
      const hide = () => {
        setActiveHoverToken((current) =>
          current?.anchor === anchor ? null : current
        );
        hoverHideTimerRef.current = null;
      };
      cancelHoverHide();
      if (delayMs <= 0) {
        hide();
        return;
      }
      hoverHideTimerRef.current = window.setTimeout(hide, delayMs);
    },
    [cancelHoverHide]
  );

  const handleTokenPointerOver = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      showTokenHover(event.target);
    },
    [showTokenHover]
  );

  const handleTokenPointerOut = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const anchor = getHoverableTokenFromEventTarget(event.target);
      if (!anchor) return;
      if (
        event.relatedTarget instanceof Node &&
        anchor.contains(event.relatedTarget)
      ) {
        return;
      }
      hideTokenHover(anchor, 120);
    },
    [hideTokenHover]
  );

  const handleTokenFocus = useCallback(
    (event: FocusEvent<HTMLDivElement>) => {
      showTokenHover(event.target);
    },
    [showTokenHover]
  );

  const handleTokenBlur = useCallback(
    (event: FocusEvent<HTMLDivElement>) => {
      const anchor = getHoverableTokenFromEventTarget(event.target);
      if (anchor) hideTokenHover(anchor, 120);
    },
    [hideTokenHover]
  );

  useEffect(() => () => cancelHoverHide(), [cancelHoverHide]);

  useEffect(() => {
    const anchor = activeHoverToken?.anchor;
    if (!anchor) return undefined;
    if (!anchor.isConnected) {
      setActiveHoverToken(null);
      return undefined;
    }
    const observer = new MutationObserver(() => {
      if (!anchor.isConnected) setActiveHoverToken(null);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [activeHoverToken]);

  useEffect(() => {
    const anchor = activeHoverToken?.anchor;
    if (!anchor) return undefined;
    const tooltipId =
      activeHoverToken.token.kind === 'quote'
        ? quoteTokenTooltipId
        : elementTokenTooltipId;

    const previousDescription = anchor.getAttribute('aria-describedby');
    const descriptionIds = new Set(
      previousDescription?.split(/\s+/).filter(Boolean) ?? []
    );
    descriptionIds.add(tooltipId);
    anchor.setAttribute(
      'aria-describedby',
      Array.from(descriptionIds).join(' ')
    );

    return () => {
      const remainingIds = new Set(
        anchor.getAttribute('aria-describedby')?.split(/\s+/).filter(Boolean) ??
          []
      );
      remainingIds.delete(tooltipId);
      if (remainingIds.size > 0) {
        anchor.setAttribute(
          'aria-describedby',
          Array.from(remainingIds).join(' ')
        );
      } else {
        anchor.removeAttribute('aria-describedby');
      }
    };
  }, [activeHoverToken, elementTokenTooltipId, quoteTokenTooltipId]);

  return {
    elementTokenTooltipId,
    quoteTokenTooltipId,
    activeHoverToken,
    cancelHoverHide,
    hideTokenHover,
    handleTokenPointerOver,
    handleTokenPointerOut,
    handleTokenFocus,
    handleTokenBlur,
  };
}
