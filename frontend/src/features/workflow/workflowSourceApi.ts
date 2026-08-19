import {
  configuredBackendTransport,
  type BackendTransport,
} from '@/lib/backendTransport';

export type WorkflowSourceDocument = {
  path: string;
  content: string;
  revision: string;
};

export type WorkflowSourceApi = ReturnType<typeof createWorkflowSourceApi>;

export function createWorkflowSourceApi(transport: BackendTransport) {
  return {
    read: (path: string) =>
      transport.call('workflow_source_read', {
        path,
      }) as Promise<WorkflowSourceDocument>,
    write: (path: string, content: string, expectedRevision?: string) =>
      transport.call('workflow_source_write', {
        path,
        content,
        expectedRevision: expectedRevision ?? null,
      }) as Promise<{ revision: string }>,
  };
}

/**
 * Resolve the expected revision to pass to a source write.
 *
 * The backend refuses to overwrite an existing Workflow source without an
 * expected revision ("Existing Workflow source requires expectedRevision"), so
 * an editor that has not loaded the file yet (e.g. a brand-new automation)
 * must read the current file first and use its revision as the optimistic
 * lock. When the file does not exist yet the write is a plain create.
 */
export async function resolveWorkflowSourceRevision(
  api: WorkflowSourceApi,
  path: string,
  knownRevision: string | null
): Promise<string | null> {
  if (knownRevision) return knownRevision;
  try {
    const existing = await api.read(path);
    return existing.revision;
  } catch {
    return null;
  }
}

export const workflowSourceApi = createWorkflowSourceApi(
  configuredBackendTransport
);
