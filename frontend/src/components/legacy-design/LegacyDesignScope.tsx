import { ReactNode, useState } from 'react';
import { PortalContainerContext } from '@/contexts/PortalContainerContext';
import NiceModal from '@ebay/nice-modal-react';
import { cn } from '@/lib/utils';
import '@/styles/legacy/index.css';

export const TAHOE_DESIGN_SCOPE_CLASS = 'legacy-design';

interface LegacyDesignScopeProps {
  children: ReactNode;
  className?: string;
}

/**
 * Compatibility wrapper for the Tahoe app-design token layer.
 *
 * The CSS class stays `legacy-design` because Tailwind is currently scoped to
 * that selector. Treat this component as the active app design scope, not as a
 * separate historical design system.
 */
export function LegacyDesignScope({
  children,
  className,
}: LegacyDesignScopeProps) {
  const [container, setContainer] = useState<HTMLElement | null>(null);

  return (
    <div
      ref={setContainer}
      className={cn(TAHOE_DESIGN_SCOPE_CLASS, 'min-h-screen w-full', className)}
    >
      {container && (
        <PortalContainerContext.Provider value={container}>
          <NiceModal.Provider>{children}</NiceModal.Provider>
        </PortalContainerContext.Provider>
      )}
    </div>
  );
}
