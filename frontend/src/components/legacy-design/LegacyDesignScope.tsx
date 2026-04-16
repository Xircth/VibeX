import { ReactNode, useState } from 'react';
import { PortalContainerContext } from '@/contexts/PortalContainerContext';
import NiceModal from '@ebay/nice-modal-react';
import { cn } from '@/lib/utils';
import '@/styles/legacy/index.css';

interface LegacyDesignScopeProps {
  children: ReactNode;
  className?: string;
}

export function LegacyDesignScope({
  children,
  className,
}: LegacyDesignScopeProps) {
  const [container, setContainer] = useState<HTMLElement | null>(null);

  return (
    <div
      ref={setContainer}
      className={cn('legacy-design min-h-screen w-full', className)}
    >
      {container && (
        <PortalContainerContext.Provider value={container}>
          <NiceModal.Provider>{children}</NiceModal.Provider>
        </PortalContainerContext.Provider>
      )}
    </div>
  );
}
