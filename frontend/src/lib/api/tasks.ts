import type {
  CreateTask,
  CreateAndStartTaskRequest,
  Task,
  TaskWithAttemptStatus,
  UpdateTask,
} from 'shared/types';

import { tauriInvoke } from './base';

export type CreateAndStartTaskPayload = CreateAndStartTaskRequest & {
  use_worktree?: boolean;
};

// Task Management APIs
export const tasksApi = {
  getById: async (taskId: string): Promise<Task> => {
    return tauriInvoke<Task>('get_task', { taskId });
  },

  create: async (data: CreateTask): Promise<Task> => {
    return tauriInvoke<Task>('create_task', { payload: data });
  },

  createAndStart: async (
    data: CreateAndStartTaskPayload
  ): Promise<TaskWithAttemptStatus> => {
    return tauriInvoke<TaskWithAttemptStatus>('create_task_and_start', {
      payload: data,
    });
  },

  update: async (taskId: string, data: UpdateTask): Promise<Task> => {
    return tauriInvoke<Task>('update_task', { taskId, payload: data });
  },

  delete: async (taskId: string): Promise<void> => {
    return tauriInvoke<void>('delete_task', { taskId });
  },
};
