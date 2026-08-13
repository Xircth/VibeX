import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
// CSS is now imported by design scope components (LegacyDesignScope, NewDesignScope)

import {
  QueryClient,
  QueryClientProvider,
  QueryCache,
} from '@tanstack/react-query';
import { isBinaryContentError } from '@/utils/filePreviewKind';
import { isCanceledError } from '@/lib/errors';
import { initUiZoom } from '@/lib/uiZoom';
import { initMonoFont } from '@/lib/uiFont';
import { preloadMonacoEditor } from '@/lib/monacoPreload';
// Initialize the i18n runtime (module side-effect) before first render.
import '@/i18n';
// Import modal type definitions
import './types/modals';
import { isTauriRuntime, WebTransportBootstrap } from './WebTransportBootstrap';

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => {
      if (
        (query.meta as { suppressGlobalError?: boolean } | undefined)
          ?.suppressGlobalError
      ) {
        return;
      }
      const queryRoot =
        Array.isArray(query.queryKey) && query.queryKey.length > 0
          ? query.queryKey[0]
          : null;
      const isFileContentQuery =
        queryRoot === 'fileContent' || queryRoot === 'fileContentHead';
      if (isCanceledError(error)) {
        return;
      }
      if (isFileContentQuery && isBinaryContentError(error)) {
        return;
      }
      console.error('[React Query Error]', {
        queryKey: query.queryKey,
        error: error,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      refetchOnWindowFocus: false,
    },
  },
});

initUiZoom();
initMonoFont();
void preloadMonacoEditor().catch((error) => {
  console.error('Failed to preload the local file preview runtime:', error);
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <React.Suspense fallback={null}>
        {isTauriRuntime() ? (
          <App />
        ) : (
          <WebTransportBootstrap>
            <App />
          </WebTransportBootstrap>
        )}
      </React.Suspense>
    </QueryClientProvider>
  </React.StrictMode>
);
