import { useCallback, useEffect, useState } from 'react';
import { FileWarning, Loader2, RotateCw } from 'lucide-react';

import { pluginControlApi } from '@/lib/api/plugins';
import { configuredBackendTransport } from '@/lib/backendTransport';

export function PluginFilePreview({ filePath }: { filePath: string }) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let acquired = false;
    let acquiredLeaseId: string | null = null;
    setPreviewUrl(null);
    setError(null);
    void pluginControlApi
      .openFilePreview(filePath)
      .then((result) => {
        if (!result) throw new Error('No active plugin can preview this file.');
        acquired = result.port !== null && result.leaseId !== null;
        acquiredLeaseId = result.leaseId;
        if (cancelled) {
          if (acquired) {
            void pluginControlApi.closeFilePreview(filePath, result.leaseId);
          }
          return;
        }
        setProvider(result.pluginId);
        setPreviewUrl(
          result.previewUrl ??
            (result.port !== null &&
            result.leaseId !== null &&
            result.capabilityToken !== null
              ? (configuredBackendTransport.artifactPreviewUrl?.({
                  leaseId: result.leaseId,
                  capabilityToken: result.capabilityToken,
                  loopbackPort: result.port,
                }) ?? null)
              : null)
        );
        setError(result.errorMessage ?? result.errorCode);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    return () => {
      cancelled = true;
      if (acquired) {
        void pluginControlApi.closeFilePreview(filePath, acquiredLeaseId);
      }
    };
  }, [filePath, retryKey]);
  const retry = useCallback(() => setRetryKey((value) => value + 1), []);

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <FileWarning className="h-8 w-8 text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">
          Plugin preview unavailable
        </p>
        <p className="max-w-sm break-words text-xs text-muted-foreground">
          {error}
        </p>
        <button
          type="button"
          onClick={retry}
          className="raised-control mt-1 flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium"
        >
          <RotateCw className="h-3.5 w-3.5" />
          Retry
        </button>
      </div>
    );
  }

  return (
    <div
      className="relative h-full min-h-0"
      data-preview-provider={provider ?? undefined}
    >
      {previewUrl === null ? (
        <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Starting plugin preview…
        </div>
      ) : (
        <iframe
          title={`${provider ?? 'Plugin'} preview`}
          src={previewUrl}
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
          referrerPolicy="no-referrer"
          className="absolute inset-0 h-full w-full border-0 bg-white"
        />
      )}
    </div>
  );
}
