import { useEffect, useState, type ReactNode } from 'react';

interface KeepAliveSurfaceProps {
  active: boolean;
  className?: string;
  children: ReactNode;
  evictAfterMs?: number;
}

/**
 * Mounts children the first time `active` is true and keeps them mounted
 * afterwards, hiding the surface instead of unmounting. Used so kanban
 * monitor/execution conversations survive workspace tab switches.
 * When `evictAfterMs` is provided, inactive surfaces are evicted after the
 * idle window to reclaim DOM and JS heap.
 */
export function KeepAliveSurface({
  active,
  className,
  children,
  evictAfterMs,
}: KeepAliveSurfaceProps) {
  const [mounted, setMounted] = useState(active);

  useEffect(() => {
    if (active) {
      setMounted(true);
      return undefined;
    }

    if (typeof evictAfterMs !== 'number' || evictAfterMs <= 0) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      setMounted(false);
    }, evictAfterMs);

    return () => {
      window.clearTimeout(timer);
    };
  }, [active, evictAfterMs]);

  if (!mounted) {
    return null;
  }

  return (
    <div
      className={className}
      // CSS hiding keeps descendant layout effects (conversation slots)
      // registered. React's `hidden` prop would tear those slots down on
      // workspace tab switches and leave canvas windows without a message stream.
      style={active ? undefined : { display: 'none' }}
      inert={!active}
      aria-hidden={!active}
    >
      {children}
    </div>
  );
}
