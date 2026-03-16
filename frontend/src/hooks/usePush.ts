import { useMutation, useQueryClient } from '@tanstack/react-query';
import { attemptsApi } from '@/lib/api';
import type { PushError, PushTaskAttemptRequest } from 'shared/types';

class PushErrorWithData extends Error {
  constructor(
    message: string,
    public errorData?: PushError
  ) {
    super(message);
    this.name = 'PushErrorWithData';
  }
}

export interface UsePushOptions {
  force?: boolean;
}

export function usePush(
  attemptId?: string,
  onSuccess?: () => void,
  onError?: (
    err: unknown,
    errorData?: PushError,
    params?: PushTaskAttemptRequest
  ) => void,
  options?: UsePushOptions
) {
  const queryClient = useQueryClient();
  const force = options?.force ?? false;

  return useMutation<void, unknown, PushTaskAttemptRequest>({
    mutationFn: async (params: PushTaskAttemptRequest) => {
      if (!attemptId) return;
      const result = force
        ? await attemptsApi.forcePush(attemptId, params)
        : await attemptsApi.push(attemptId, params);
      if (!result.success) {
        throw new PushErrorWithData(
          result.message || (force ? 'Force push failed' : 'Push failed'),
          result.error
        );
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['branchStatus', attemptId] });
      onSuccess?.();
    },
    onError: (err, variables) => {
      const errorData =
        err instanceof PushErrorWithData ? err.errorData : undefined;
      onError?.(err, errorData, variables);
    },
  });
}
