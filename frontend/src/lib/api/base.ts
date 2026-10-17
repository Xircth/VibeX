import type { GitOperationError } from 'shared/types';

import { backendCall } from '../backendTransport';

// Re-export the transport-backed call helper for legacy facade modules.
export { backendCall };

// Pull result type (matches Rust PullResult)
export interface PullResult {
  success: boolean;
  new_commits: number;
  error: string | null;
}

// Commit graph types (not generated from Rust via ts-rs, defined locally)
export interface CommitGraphNode {
  hash: string;
  full_hash: string;
  message: string;
  author: string;
  timestamp: number;
  parents: string[];
  refs: string[];
  is_current_branch: boolean;
}

export interface CommitGraphResult {
  nodes: CommitGraphNode[];
  merge_base: string | null;
  current_branch: string;
  target_branch: string;
}

export type { SessionStatus, SessionSummary } from 'shared/types';

// Backend RebaseResult - conflicts are embedded in the Ok response, not as Tauri errors
export interface RebaseResult {
  error: GitOperationError | null;
}

// Re-export Result type for consumers that still import it
export type Ok<T> = { success: true; data: T };
export type Err<E> = { success: false; error: E | undefined; message?: string };
export type Result<T, E> = Ok<T> | Err<E>;

// Helper to convert try/catch pattern into Result type for backward compat
export async function invokeAsResult<T, E>(
  cmd: string,
  args?: Record<string, unknown>
): Promise<Result<T, E>> {
  try {
    const data = await backendCall<T>(cmd, args);
    return { success: true, data };
  } catch (error) {
    const errorStr =
      typeof error === 'string'
        ? error
        : error instanceof Error
          ? error.message
          : typeof error === 'object' &&
              error !== null &&
              'message' in error &&
              typeof (error as { message?: unknown }).message === 'string'
            ? (error as { message: string }).message
            : JSON.stringify(error);
    let errorData: E | undefined;
    if (typeof error === 'string') {
      try {
        errorData = JSON.parse(error) as E;
      } catch {
        errorData = undefined;
      }
    } else if (error instanceof Error) {
      const details =
        'details' in error
          ? (error as { details?: unknown }).details
          : 'error_data' in error
            ? (error as { error_data?: unknown }).error_data
            : undefined;
      errorData =
        details !== undefined && details !== null ? (details as E) : undefined;
    } else {
      errorData = error as E;
    }
    return { success: false, error: errorData, message: errorStr };
  }
}
