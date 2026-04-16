export const paths = {
  projects: () => '/local-projects',
  projectTasks: (projectId: string) => `/local-projects/${projectId}/tasks`,
  projectWorkspace: (projectId: string, workspaceId: string) =>
    `/local-projects/${projectId}/workspaces/${workspaceId}`,
  projectSession: (projectId: string, workspaceId: string, sessionId: string) =>
    `/local-projects/${projectId}/workspaces/${workspaceId}/sessions/${sessionId}`,
  projectSessionFull: (
    projectId: string,
    workspaceId: string,
    sessionId: string
  ) =>
    `/local-projects/${projectId}/workspaces/${workspaceId}/sessions/${sessionId}/full`,
  task: (projectId: string, taskId: string) =>
    `/local-projects/${projectId}/tasks/${taskId}`,
  attempt: (projectId: string, taskId: string, attemptId: string) =>
    `/local-projects/${projectId}/tasks/${taskId}/attempts/${attemptId}`,
  attemptFull: (projectId: string, taskId: string, attemptId: string) =>
    `/local-projects/${projectId}/tasks/${taskId}/attempts/${attemptId}/full`,
};
