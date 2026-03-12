import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { IDockviewPanelProps } from 'dockview-react';
import { Trash2 } from 'lucide-react';
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { useProject } from '@/contexts/ProjectContext';
import { useProjectTasks } from '@/hooks/useProjectTasks';
import { useTaskMutations } from '@/hooks/useTaskMutations';
import { paths } from '@/lib/paths';
import { openTaskForm } from '@/lib/openTaskForm';
import { DeleteTaskConfirmationDialog } from '@/components/dialogs/tasks/DeleteTaskConfirmationDialog';
import { useLayoutStore } from '@/stores/useLayoutStore';
import type { TaskWithAttemptStatus, TaskStatus } from 'shared/types';

const KANBAN_COLUMNS = [
  { key: 'todo' as TaskStatus, label: 'TODO', dotColor: '#EF4444' },
  { key: 'inprogress' as TaskStatus, label: 'IN PROGRESS', dotColor: '#22C55E' },
  { key: 'inreview' as TaskStatus, label: 'IN REVIEW', dotColor: '#EAB308' },
  { key: 'done' as TaskStatus, label: 'DONE', dotColor: '#9CA3AF' },
] as const;

/**
 * Shared KanbanBoard component used by both the dockview panel and the full-width overlay.
 * When onTaskClick navigates, it also switches to workspace tab.
 * Supports drag-and-drop to move tasks between status columns.
 */
export function KanbanBoard() {
  const { projectId } = useProject();
  const { tasksByStatus } = useProjectTasks(projectId ?? '');
  const { updateTask } = useTaskMutations(projectId);
  const navigate = useNavigate();
  const setActiveTab = useLayoutStore((s) => s.setActiveTab);

  const [activeTask, setActiveTask] = useState<TaskWithAttemptStatus | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    })
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const taskId = event.active.id as string;
      const status = event.active.data.current?.parent as TaskStatus | undefined;
      if (!status) return;
      const tasks = tasksByStatus[status] ?? [];
      const found = tasks.find((t) => t.id === taskId);
      setActiveTask(found ?? null);
    },
    [tasksByStatus],
  );

  const handleTaskClick = useCallback(
    (task: TaskWithAttemptStatus) => {
      if (!projectId) return;
      setActiveTab('workspace');
      navigate(`${paths.task(projectId, task.id)}/attempts/latest`);
    },
    [projectId, navigate, setActiveTab],
  );

  const handleCreateTask = useCallback(
    (status?: TaskStatus) => {
      if (!projectId) return;
      openTaskForm({ mode: 'create', projectId, initialStatus: status });
    },
    [projectId],
  );

  const handleDeleteTask = useCallback(
    async (e: React.MouseEvent, task: TaskWithAttemptStatus) => {
      e.stopPropagation();
      if (!projectId) return;
      try {
        await DeleteTaskConfirmationDialog.show({ task, projectId });
      } catch {
        // User cancelled
      }
    },
    [projectId],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveTask(null);
      const { active, over } = event;
      if (!over) return;

      const taskId = active.id as string;
      const sourceStatus = active.data.current?.parent as TaskStatus | undefined;
      const targetStatus = over.id as TaskStatus;

      if (!sourceStatus || sourceStatus === targetStatus) return;

      updateTask.mutate({
        taskId,
        data: {
          title: null,
          description: null,
          status: targetStatus,
          parent_workspace_id: null,
          image_ids: null,
        },
      });
    },
    [updateTask],
  );

  return (
    <div className="h-full w-full overflow-auto bg-background p-3" data-panel="kanban">
      <DndContext
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        sensors={sensors}
      >
        <div className="flex gap-3 h-full min-w-0">
          {KANBAN_COLUMNS.map((col) => {
            const tasks = tasksByStatus[col.key] ?? [];
            return (
              <KanbanColumn
                key={col.key}
                columnKey={col.key}
                label={col.label}
                dotColor={col.dotColor}
                tasks={tasks}
                onTaskClick={handleTaskClick}
                onCreateTask={() => handleCreateTask(col.key)}
                onDeleteTask={handleDeleteTask}
              />
            );
          })}
        </div>
        <DragOverlay dropAnimation={null}>
          {activeTask ? (
            <div className="w-[160px] p-2 rounded border border-primary bg-background shadow-lg">
              <div className="text-xs font-medium text-foreground line-clamp-2">
                {activeTask.title}
              </div>
              {activeTask.description && (
                <div className="text-[10px] text-muted-foreground mt-0.5 line-clamp-1">
                  {activeTask.description}
                </div>
              )}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

function DockviewKanbanPanel(_props: IDockviewPanelProps) {
  return <KanbanBoard />;
}

function KanbanColumn({
  columnKey,
  label,
  dotColor,
  tasks,
  onTaskClick,
  onCreateTask,
  onDeleteTask,
}: {
  columnKey: TaskStatus;
  label: string;
  dotColor: string;
  tasks: TaskWithAttemptStatus[];
  onTaskClick: (task: TaskWithAttemptStatus) => void;
  onCreateTask: () => void;
  onDeleteTask: (e: React.MouseEvent, task: TaskWithAttemptStatus) => void;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: columnKey });

  return (
    <div
      ref={setNodeRef}
      className={`flex-1 min-w-[160px] flex flex-col rounded-lg bg-muted/30 border transition-colors ${
        isOver ? 'border-primary bg-primary/5' : 'border-border'
      }`}
    >
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border shrink-0">
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{ backgroundColor: dotColor }}
        />
        <span className="text-xs font-semibold text-foreground tracking-wide">
          {label}
        </span>
        <span className="text-xs text-muted-foreground ml-auto">
          {tasks.length}
        </span>
        <button
          onClick={onCreateTask}
          className="text-muted-foreground hover:text-foreground transition-colors"
          title="新建任务"
        >
          <span className="text-sm leading-none">+</span>
        </button>
      </div>
      <div className="flex-1 p-2 space-y-1.5 overflow-auto">
        {tasks.map((task, index) => (
          <DraggableTaskCard
            key={task.id}
            task={task}
            index={index}
            columnKey={columnKey}
            onTaskClick={onTaskClick}
            onDeleteTask={onDeleteTask}
          />
        ))}
      </div>
    </div>
  );
}

function DraggableTaskCard({
  task,
  index,
  columnKey,
  onTaskClick,
  onDeleteTask,
}: {
  task: TaskWithAttemptStatus;
  index: number;
  columnKey: TaskStatus;
  onTaskClick: (task: TaskWithAttemptStatus) => void;
  onDeleteTask: (e: React.MouseEvent, task: TaskWithAttemptStatus) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({
      id: task.id,
      data: { index, parent: columnKey },
    });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={() => onTaskClick(task)}
      className={`group w-full text-left p-2 rounded border border-border bg-background hover:bg-accent/50 transition-colors relative cursor-grab ${
        isDragging ? 'opacity-0 cursor-grabbing' : ''
      }`}
      style={{
        transform: transform
          ? `translateX(${transform.x}px) translateY(${transform.y}px)`
          : undefined,
      }}
    >
      <div className="text-xs font-medium text-foreground line-clamp-2 pr-5">
        {task.title}
      </div>
      {task.description && (
        <div className="text-[10px] text-muted-foreground mt-0.5 line-clamp-1 pr-5">
          {task.description}
        </div>
      )}
      {task.executor && (
        <div className="text-[10px] text-muted-foreground mt-1 truncate pr-5">
          {task.executor}
        </div>
      )}
      <span
        role="button"
        tabIndex={0}
        onClick={(e) => onDeleteTask(e, task)}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            onDeleteTask(e as unknown as React.MouseEvent, task);
          }
        }}
        className="absolute top-1.5 right-1.5 p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-all"
        title="删除任务"
      >
        <Trash2 className="h-3 w-3" />
      </span>
    </div>
  );
}

export default DockviewKanbanPanel;
