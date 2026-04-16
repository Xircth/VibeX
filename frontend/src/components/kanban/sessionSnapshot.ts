import type { Session } from 'shared/types';
import type { KanbanProjectSessionRecord } from '@/hooks/useKanbanProjectSessions';

export function createSessionSnapshot(
  session: KanbanProjectSessionRecord
): Session {
  return {
    id: session.id,
    workspace_id: session.workspace.id,
    task_id: session.taskId,
    name: session.name,
    initial_prompt: session.firstPrompt,
    status: session.status,
    executor: session.executor,
    created_at: session.createdAt,
    updated_at: session.updatedAt,
  };
}
