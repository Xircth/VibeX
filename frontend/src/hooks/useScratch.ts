import { useCallback, useMemo, useRef } from 'react';
import { useTauriPatchStream } from './useTauriPatchStream';
import { scratchApi } from '@/lib/api';
import {
  ScratchType,
  type Scratch,
  type ScratchUpdateOutcome,
  type UpdateScratch,
} from 'shared/types';

type ScratchState = {
  scratch: Scratch | null;
};

export interface UpdateScratchOptions {
  overwriteOnConflict?: boolean;
}

export interface UseScratchResult {
  scratch: Scratch | null;
  isLoading: boolean;
  isConnected: boolean;
  error: string | null;
  updateScratch: (
    update: UpdateScratch,
    options?: UpdateScratchOptions
  ) => Promise<ScratchUpdateOutcome>;
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
  const scratchRef = useRef(scratch);
  scratchRef.current = scratch;

  const updateScratch = useCallback(
    async (
      update: UpdateScratch,
      persistOptions?: UpdateScratchOptions
    ): Promise<ScratchUpdateOutcome> => {
      const overwriteOnConflict = persistOptions?.overwriteOnConflict ?? true;
      const expectedRevision =
        update.expected_revision ?? scratchRef.current?.revision ?? 0;
      let outcome = await scratchApi.update(scratchType, id, {
        ...update,
        expected_revision: expectedRevision,
      });
      if (outcome.kind === 'conflict' && overwriteOnConflict) {
        outcome = await scratchApi.update(scratchType, id, {
          ...update,
          expected_revision: outcome.server.revision,
        });
      }
      return outcome;
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
