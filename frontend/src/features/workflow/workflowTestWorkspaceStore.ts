export type WorkflowTestWorkspaceMode = 'existing' | 'new';

export type WorkflowTestWorkspaceRecord = {
  mode: WorkflowTestWorkspaceMode | null;
  workspaceId: string | null;
  workspaceIds: string[];
};

const EMPTY_RECORD: WorkflowTestWorkspaceRecord = {
  mode: null,
  workspaceId: null,
  workspaceIds: [],
};

export function workflowTestWorkspaceKey(scope: string) {
  return `vibex.workflow.test-workspace:${scope}`;
}

export function loadWorkflowTestWorkspace(
  scope: string
): WorkflowTestWorkspaceRecord {
  if (!scope || typeof localStorage === 'undefined') return EMPTY_RECORD;
  try {
    const raw = localStorage.getItem(workflowTestWorkspaceKey(scope));
    if (!raw) return EMPTY_RECORD;
    const parsed = JSON.parse(raw) as Partial<WorkflowTestWorkspaceRecord>;
    const workspaceIds = Array.isArray(parsed.workspaceIds)
      ? parsed.workspaceIds.filter(
          (id): id is string => typeof id === 'string' && id.length > 0
        )
      : [];
    const workspaceId =
      typeof parsed.workspaceId === 'string' && parsed.workspaceId
        ? parsed.workspaceId
        : (workspaceIds.at(-1) ?? null);
    return {
      mode:
        parsed.mode === 'existing' || parsed.mode === 'new'
          ? parsed.mode
          : workspaceId
            ? 'existing'
            : null,
      workspaceId,
      workspaceIds,
    };
  } catch {
    return EMPTY_RECORD;
  }
}

export function saveWorkflowTestWorkspace(
  scope: string,
  record: WorkflowTestWorkspaceRecord
) {
  if (!scope || typeof localStorage === 'undefined') return;
  localStorage.setItem(workflowTestWorkspaceKey(scope), JSON.stringify(record));
}

export function rememberTestWorkspace(
  scope: string,
  workspaceId: string,
  mode: WorkflowTestWorkspaceMode = 'existing'
): WorkflowTestWorkspaceRecord {
  const current = loadWorkflowTestWorkspace(scope);
  const workspaceIds = current.workspaceIds.includes(workspaceId)
    ? current.workspaceIds
    : [...current.workspaceIds, workspaceId];
  const next: WorkflowTestWorkspaceRecord = {
    mode,
    workspaceId,
    workspaceIds,
  };
  saveWorkflowTestWorkspace(scope, next);
  return next;
}
