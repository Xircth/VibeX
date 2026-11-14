import { Suspense, useContext, type ReactNode } from 'react';

import { LegacyDesignScope } from '@/components/legacy-design/LegacyDesignScope';
import { Loader } from '@/components/ui/loader';
import { StartupOverlayContext } from '@/contexts/StartupOverlayContext';

export function RouteFallback() {
  return (
    <div data-testid="route-fallback">
      <Loader size={24} className="h-full min-h-[40vh]" />
    </div>
  );
}

export function MainLegacyScope({
  children,
  className,
  pageSuspense = true,
}: {
  children: ReactNode;
  className?: string;
  pageSuspense?: boolean;
}) {
  const startupOverlay = useContext(StartupOverlayContext);
  return (
    <LegacyDesignScope className={className}>
      {pageSuspense ? (
        <Suspense fallback={<RouteFallback />}>{children}</Suspense>
      ) : (
        children
      )}
      {startupOverlay}
    </LegacyDesignScope>
  );
}
