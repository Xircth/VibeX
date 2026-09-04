import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';

/**
 * Renders a tree that reads React Query state.
 *
 * Anything showing plugin contributions needs this, because the contribution
 * catalog is shared server state that the Host invalidates on a backend event
 * rather than per-component fetch state.
 *
 * Each call gets a fresh client so one test's cache never leaks into the next.
 */
export function renderWithQueryClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
  );
}
