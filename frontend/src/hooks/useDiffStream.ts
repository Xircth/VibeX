import { useCallback, useMemo } from 'react';
import type { Diff, PatchType } from 'shared/types';
import { useTauriPatchStream } from './useTauriPatchStream';

interface DiffEntries {
  [filePath: string]: PatchType;
}

type DiffStreamEvent = {
  entries: DiffEntries;
};

export interface UseDiffStreamOptions {
  statsOnly?: boolean;
}

interface UseDiffStreamResult {
  diffs: Diff[];
  error: string | null;
  isInitialized: boolean;
}

export const useDiffStream = (
  attemptId: string | null,
  enabled: boolean,
  options?: UseDiffStreamOptions
): UseDiffStreamResult => {
  const statsOnly = options?.statsOnly;

  const subscribeArgs = useMemo(
    () =>
      attemptId
        ? {
            workspaceId: attemptId,
            ...(typeof statsOnly === 'boolean'
              ? { statsOnly }
              : {}),
          }
        : undefined,
    [attemptId, statsOnly]
  );

  const initialData = useCallback(
    (): DiffStreamEvent => ({
      entries: {},
    }),
    []
  );

  const { data, error, isInitialized } = useTauriPatchStream<DiffStreamEvent>({
    subscribeCommand: 'subscribe_diff_stream',
    subscribeArgs,
    eventChannel: `diff-stream:${attemptId}`,
    initialData,
    enabled: enabled && !!attemptId,
  });

  const diffs = useMemo(() => {
    return Object.values(data?.entries ?? {})
      .filter((entry) => entry?.type === 'DIFF')
      .map((entry) => entry.content);
  }, [data?.entries]);

  return { diffs, error, isInitialized };
};
