import { useCallback, useMemo } from 'react';
import { useTauriPatchStream } from './useTauriPatchStream';
import { scratchApi } from '@/lib/api';
import { ScratchType, type Scratch, type UpdateScratch } from 'shared/types';

type ScratchState = {
  scratch: Scratch | null;
};

export interface UseScratchResult {
  scratch: Scratch | null;
  isLoading: boolean;
  isConnected: boolean;
  error: string | null;
  updateScratch: (update: UpdateScratch) => Promise<void>;
  deleteScratch: () => Promise<void>;
}

interface UseScratchOptions {
  /** Whether to enable the stream. Defaults to true. */
  enabled?: boolean;
}

/**
 * Stream a single scratch item via Tauri events (JSON Patch).
 * Server sends the scratch object directly at /scratch.
 */
export const useScratch = (
  scratchType: ScratchType,
  id: string,
  options?: UseScratchOptions
): UseScratchResult => {
  // Skip connection when disabled or no ID
  const enabled = (options?.enabled ?? true) && id.length > 0;

  const subscribeArgs = useMemo(
    () => (enabled ? { scratchId: id, scratchType } : undefined),
    [enabled, id, scratchType]
  );

  const initialData = useCallback((): ScratchState => ({ scratch: null }), []);

  const { data, isConnected, isInitialized, error } =
    useTauriPatchStream<ScratchState>({
      subscribeCommand: 'subscribe_scratch_stream',
      subscribeArgs,
      eventChannel: `scratch-stream:${id}`,
      initialData,
      enabled,
    });

  // Treat deleted scratches as null
  const rawScratch = data?.scratch as (Scratch & { deleted?: boolean }) | null;
  const scratch = rawScratch?.deleted ? null : rawScratch;

  const updateScratch = useCallback(
    async (update: UpdateScratch) => {
      await scratchApi.update(scratchType, id, update);
    },
    [scratchType, id]
  );

  const deleteScratch = useCallback(async () => {
    await scratchApi.delete(scratchType, id);
  }, [scratchType, id]);

  const isLoading = !isInitialized && !error;

  return {
    scratch,
    isLoading,
    isConnected,
    error,
    updateScratch,
    deleteScratch,
  };
};
