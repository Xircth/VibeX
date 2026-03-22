import type { GitOperationError } from 'shared/types';

import { tauriInvoke } from '../tauriApi';

// Re-export tauriInvoke for use by other modules
export { tauriInvoke };

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
    const data = await tauriInvoke<T>(cmd, args);
    return { success: true, data };
  } catch (error) {
    // Tauri errors come as strings or objects
    const errorStr = typeof error === 'string' ? error : JSON.stringify(error);
    let errorData: E | undefined;
    try {
      errorData = typeof error === 'string' ? JSON.parse(error) : (error as E);
    } catch {
      errorData = undefined;
    }
    return { success: false, error: errorData, message: errorStr };
  }
}
