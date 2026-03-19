import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigateWithSearch } from '@/hooks';
import { tasksApi } from '@/lib/api';
import { paths } from '@/lib/paths';
import { useLayoutStore } from '@/stores/useLayoutStore';
import { taskRelationshipsKeys } from '@/hooks/useTaskRelationships';
import type {
  CreateTask,
  Task,
  TaskWithAttemptStatus,
  UpdateTask,
} from 'shared/types';
import { taskKeys } from './useTask';
import type { CreateAndStartTaskPayload } from '@/lib/api/tasks';

export function useTaskMutations(projectId?: string) {
  const queryClient = useQueryClient();
  const navigate = useNavigateWithSearch();
  const setActiveTab = useLayoutStore((state) => state.setActiveTab);

  const invalidateQueries = (taskId?: string) => {
    queryClient.invalidateQueries({ queryKey: taskKeys.all });
    if (taskId) {
      queryClient.invalidateQueries({ queryKey: taskKeys.byId(taskId) });
    }
  };

  const createTask = useMutation({
    mutationFn: (data: CreateTask) => tasksApi.create(data),
    onSuccess: (createdTask: Task) => {
      invalidateQueries();
      // Invalidate parent's relationships cache if this is a subtask
      if (createdTask.parent_workspace_id) {
        queryClient.invalidateQueries({
          queryKey: taskRelationshipsKeys.byAttempt(
            createdTask.parent_workspace_id
          ),
        });
      }
      if (projectId) {
        setActiveTab('workspace');
        navigate(`${paths.task(projectId, createdTask.id)}/attempts/latest`);
      }
    },
    onError: (err) => {
      console.error('Failed to create task:', err);
    },
  });

  const createAndStart = useMutation({
    mutationFn: (data: CreateAndStartTaskPayload) => tasksApi.createAndStart(data),
    onSuccess: (createdTask: TaskWithAttemptStatus) => {
      invalidateQueries();
      // Invalidate parent's relationships cache if this is a subtask
      if (createdTask.parent_workspace_id) {
        queryClient.invalidateQueries({
          queryKey: taskRelationshipsKeys.byAttempt(
            createdTask.parent_workspace_id
          ),
        });
      }
      if (projectId) {
        setActiveTab('workspace');
        navigate(`${paths.task(projectId, createdTask.id)}/attempts/latest`);
      }
    },
    onError: (err) => {
      console.error('Failed to create and start task:', err);
    },
  });

  const updateTask = useMutation({
    mutationFn: ({ taskId, data }: { taskId: string; data: UpdateTask }) =>
      tasksApi.update(taskId, data),
    onSuccess: (updatedTask: Task) => {
      invalidateQueries(updatedTask.id);
    },
    onError: (err) => {
      console.error('Failed to update task:', err);
    },
  });

  const deleteTask = useMutation({
    mutationFn: (taskId: string) => tasksApi.delete(taskId),
    onSuccess: (_: unknown, taskId: string) => {
      invalidateQueries(taskId);
      // Remove single-task cache entry to avoid stale data flashes
      queryClient.removeQueries({ queryKey: ['task', taskId], exact: true });
      // Invalidate all task relationships caches (safe approach since we don't know parent)
      queryClient.invalidateQueries({ queryKey: taskRelationshipsKeys.all });
    },
    onError: (err) => {
      console.error('Failed to delete task:', err);
    },
  });

  return {
    createTask,
    createAndStart,
    updateTask,
    deleteTask,
  };
}
