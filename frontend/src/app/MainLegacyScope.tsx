import { Suspense, type ReactNode } from 'react';

import { LegacyDesignScope } from '@/components/legacy-design/LegacyDesignScope';
import { Loader } from '@/components/ui/loader';

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
  return (
    <LegacyDesignScope className={className}>
      {pageSuspense ? (
        <Suspense fallback={<RouteFallback />}>{children}</Suspense>
      ) : (
        children
      )}
    </LegacyDesignScope>
  );
}
