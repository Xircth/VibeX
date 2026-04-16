import { memo } from 'react';
import {
  type DragEndEvent,
  KanbanBoard,
  KanbanCards,
  KanbanHeader,
  KanbanProvider,
} from '@/components/ui/shadcn-io/kanban';
import { TaskCard } from './TaskCard';
import type { TaskStatus, TaskWithAttemptStatus } from 'shared/types';
import { statusBoardColors, statusLabels } from '@/utils/statusLabels';

export type KanbanColumns = Record<TaskStatus, TaskWithAttemptStatus[]>;

interface TaskKanbanBoardProps {
  columns: KanbanColumns;
  onDragEnd: (event: DragEndEvent) => void;
  onViewTaskDetails: (task: TaskWithAttemptStatus) => void;
  selectedTaskId?: string;
  onCreateTask?: (status: TaskStatus) => void;
  onClearDoneTasks?: () => void;
  canClearDoneTasks?: boolean;
  projectId: string;
}

function renderColumn(
  statusKey: TaskStatus,
  tasks: TaskWithAttemptStatus[],
  {
    onCreateTask,
    onClearDoneTasks,
    canClearDoneTasks,
    onViewTaskDetails,
    selectedTaskId,
    projectId,
  }: Pick<
    TaskKanbanBoardProps,
    | 'onCreateTask'
    | 'onClearDoneTasks'
    | 'canClearDoneTasks'
    | 'onViewTaskDetails'
    | 'selectedTaskId'
    | 'projectId'
  >
) {
  return (
    <KanbanBoard key={statusKey} id={statusKey}>
      <KanbanHeader
        name={statusLabels[statusKey]}
        color={statusBoardColors[statusKey]}
        onAddTask={() => onCreateTask?.(statusKey)}
        onClearColumn={statusKey === 'done' ? onClearDoneTasks : undefined}
        clearDisabled={statusKey === 'done' ? !canClearDoneTasks : false}
      />
      <KanbanCards>
        {tasks.map((task, index) => (
          <TaskCard
            key={task.id}
            task={task}
            index={index}
            status={statusKey}
            onViewDetails={onViewTaskDetails}
            isOpen={selectedTaskId === task.id}
            projectId={projectId}
          />
        ))}
      </KanbanCards>
    </KanbanBoard>
  );
}

function TaskKanbanBoard({
  columns,
  onDragEnd,
  onViewTaskDetails,
  selectedTaskId,
  onCreateTask,
  onClearDoneTasks,
  canClearDoneTasks,
  projectId,
}: TaskKanbanBoardProps) {
  const shared = {
    onCreateTask,
    onClearDoneTasks,
    canClearDoneTasks,
    onViewTaskDetails,
    selectedTaskId,
    projectId,
  };

  return (
    <KanbanProvider onDragEnd={onDragEnd}>
      {renderColumn('todo', columns.todo, shared)}
      {renderColumn('inprogress', columns.inprogress, shared)}
      {renderColumn('inreview', columns.inreview, shared)}
      {renderColumn('done', columns.done, shared)}
    </KanbanProvider>
  );
}

export default memo(TaskKanbanBoard);
