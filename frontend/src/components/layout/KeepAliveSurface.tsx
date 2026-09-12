import { useEffect, useState, type ReactNode } from 'react';

interface KeepAliveSurfaceProps {
  active: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * Mounts children the first time `active` is true and keeps them mounted
 * afterwards, hiding the surface instead of unmounting. Used so kanban
 * monitor/execution conversations survive workspace tab switches.
 */
export function KeepAliveSurface({
  active,
  className,
  children,
}: KeepAliveSurfaceProps) {
  const [mounted, setMounted] = useState(active);

  useEffect(() => {
    if (active) {
      setMounted(true);
    }
  }, [active]);

  if (!mounted) {
    return null;
  }

  return (
    <div
      className={className}
      hidden={!active}
      inert={!active}
      aria-hidden={!active}
    >
      {children}
    </div>
  );
}
