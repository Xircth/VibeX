import type { QueryClient } from '@tanstack/react-query';
import { fileContentKeys } from '@/hooks/useFileContent';
import { fileTreeKeys } from '@/hooks/useFileTree';

export interface PreviewTabRefreshPayload {
  panelId?: string;
  filePath?: string | null;
}

type PreviewTabRefreshListener = (payload: PreviewTabRefreshPayload) => void;

const listeners = new Set<PreviewTabRefreshListener>();

export function subscribePreviewTabRefresh(
  listener: PreviewTabRefreshListener
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function requestPreviewTabRefresh(
  payload: PreviewTabRefreshPayload & { queryClient?: QueryClient | null } = {}
): void {
  const { queryClient, panelId, filePath } = payload;
  if (queryClient) {
    if (filePath) {
      void queryClient.invalidateQueries({
        queryKey: fileContentKeys.byPath(filePath),
      });
      void queryClient.invalidateQueries({
        queryKey: fileContentKeys.headByPath(filePath),
      });
      void queryClient.invalidateQueries({
        queryKey: fileContentKeys.binaryAssetByPath(filePath),
      });
    }
    void queryClient.invalidateQueries({ queryKey: fileContentKeys.all });
    void queryClient.invalidateQueries({ queryKey: fileContentKeys.allHead });
    void queryClient.invalidateQueries({
      queryKey: fileContentKeys.allBinaryAssets,
    });
    void queryClient.invalidateQueries({ queryKey: fileTreeKeys.all });
  }

  for (const listener of listeners) {
    listener({ panelId, filePath });
  }
}
