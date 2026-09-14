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
