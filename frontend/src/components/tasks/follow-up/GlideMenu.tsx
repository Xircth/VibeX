import {
  useCallback,
  useRef,
  useState,
  type FocusEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { cn } from '@/lib/utils';

type HighlightRect = {
  top: number;
  height: number;
  visible: boolean;
};

/**
 * Tracks hovered or keyboard-focused `[data-menu-row]` children with a sliding
 * background pill highlight.
 */
export function GlideMenu({
  children,
  className,
  highlightClassName,
}: {
  children: ReactNode;
  className?: string;
  highlightClassName?: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [rect, setRect] = useState<HighlightRect>({
    top: 0,
    height: 0,
    visible: false,
  });

  const trackTarget = useCallback((target: EventTarget | null) => {
    const container = containerRef.current;
    if (!container || !(target instanceof HTMLElement)) return;
    const row = target.closest<HTMLElement>('[data-menu-row]');
    if (!row || !container.contains(row)) return;
    const nextTop = row.offsetTop;
    const nextHeight = row.offsetHeight;
    setRect((current) =>
      current.visible &&
      current.top === nextTop &&
      current.height === nextHeight
        ? current
        : { top: nextTop, height: nextHeight, visible: true }
    );
  }, []);

  const hide = useCallback(() => {
    setRect((current) =>
      current.visible ? { ...current, visible: false } : current
    );
  }, []);

  const handleMouseMove = (event: MouseEvent<HTMLDivElement>) => {
    trackTarget(event.target);
  };

  const handleFocusCapture = (event: FocusEvent<HTMLDivElement>) => {
    trackTarget(event.target);
  };

  const handleBlurCapture = (event: FocusEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    const nextFocused = event.relatedTarget;
    if (
      container &&
      nextFocused instanceof Node &&
      container.contains(nextFocused)
    ) {
      return;
    }
    hide();
  };

  return (
    <div
      ref={containerRef}
      className={cn('relative', className)}
      onMouseMove={handleMouseMove}
      onMouseLeave={hide}
      onFocusCapture={handleFocusCapture}
      onBlurCapture={handleBlurCapture}
    >
      <div
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute inset-x-0 z-0 transition-[top,height,opacity] duration-150 ease-out motion-reduce:transition-none',
          highlightClassName
        )}
        style={{
          top: rect.top,
          height: rect.height,
          opacity: rect.visible ? 1 : 0,
        }}
      />
      {children}
    </div>
  );
}
