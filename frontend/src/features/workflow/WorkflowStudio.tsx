import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ConnectionMode,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './workflowStudio.css';
import {
  ArrowLeft,
  Bell,
  Check,
  ChevronDown,
  CirclePause,
  CirclePlay,
  Copy,
  GitFork,
  ListTree,
  MessageSquare,
  Plus,
  RotateCcw,
  SlidersHorizontal,
  Square,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import {
  SoundFile,
  type AgentSessionControlsSnapshot,
  type JsonValue,
  type WorkflowBinding,
  type WorkflowDefinition,
  type WorkflowEventRecord,
  type WorkflowRunView,
  type WorkflowStep,
  type WorkflowStepView,
  type WorkflowReviewDecision,
} from 'shared/types';

import { AstryxMarkdown } from '@/components/NormalizedConversation/AstryxMarkdown';
import { Button } from '@/components/ui/button';
import { useOptionalUserSystem } from '@/components/ConfigProvider';
import { deliverDesktopNotification } from '@/components/layout/sessionCompletionNotification';
import { AgentIcon } from '@/components/agents/AgentIcon';
import { configApi } from '@/lib/api/config';
import { showDesktopToast } from '@/lib/desktopToast';
import { SessionSettingsSummary } from '@/components/tasks/follow-up/SessionSettingsSummary';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { latestWorkflowStepAttempts } from './workflowProjection';
import { WorkflowStepConversation } from './WorkflowStepConversation';

type StudioMode = 'edit' | 'run';

const DEFAULT_OUTPUT_SCHEMA: JsonValue = {
  type: 'object',
  required: ['summary'],
  properties: { summary: { type: 'string' } },
};

type StudioNodeData = {
  step: WorkflowStep;
  confirmationFor?: string;
  stepRun?: WorkflowStepView;
  predecessorRuns: WorkflowStepView[];
  events: WorkflowEventRecord[];
  agentOptions: WorkflowStudioAgentOption[];
  selected: boolean;
  logExpanded: boolean;
  mode: StudioMode;
  onSelect: (stepId: string) => void;
  onToggleLog: (stepId: string) => void;
};

type StudioNode = Node<StudioNodeData, 'workflowStep'>;

export type WorkflowStudioAgentOption = {
  value: string;
  label: string;
  iconLight?: string | null;
  iconDark?: string | null;
  iconSvg?: string | null;
};

export type WorkflowStudioProps = {
  definition: WorkflowDefinition;
  onDefinitionChange?: (definition: WorkflowDefinition) => void;
  run?: WorkflowRunView | null;
  steps?: WorkflowStepView[];
  events?: WorkflowEventRecord[];
  dirty?: boolean;
  saving?: boolean;
  publishing?: boolean;
  onSave?: () => void;
  onPublish?: () => void;
  releaseVersion?: string;
  canUndo?: boolean;
  onUndo?: () => void;
  workspaceConfig?: ReactNode;
  workspaceSummary?: string;
  onBack?: () => void;
  editorName?: string;
  onEditorNameChange?: (name: string) => void;
  agentOptions?: WorkflowStudioAgentOption[];
  loadAgentSessionControls?: (
    agentId: string
  ) => Promise<AgentSessionControlsSnapshot | null>;
  onStopRun?: () => void;
  onTerminateRun?: () => void;
  onReset?: () => void;
  showStopActions?: boolean;
  stopActionsDisabled?: boolean;
  resetDisabled?: boolean;
  onPauseRun?: () => void;
  onResumeRun?: () => void;
  onTestNode?: (stepId: string) => void;
  onRerunFromNode?: (stepId: string) => void;
  onAcceptCandidate?: (stepId: string) => void;
  onPauseStep?: (stepId: string) => void;
  onSubmitStepInput?: (stepId: string, text: string) => Promise<void> | void;
  onDecideApproval?: (
    stepId: string,
    decision: JsonValue
  ) => Promise<void> | void;
  onReview?: (decision: WorkflowReviewDecision) => Promise<void> | void;
  activeWorktree?: { name: string; path: string } | null;
  notifyContext?: { projectId: string; workspaceId: string } | null;
  className?: string;
};

const CONFIRMATION_OFFSET = { x: 276, y: 23 };

function confirmationParentId(nodeId: string) {
  return nodeId.startsWith('confirmation:')
    ? nodeId.slice('confirmation:'.length)
    : null;
}

export function isWorkflowConnectionValid(connection: {
  source: string | null;
  target: string | null;
}) {
  if (!connection.source || !connection.target) return false;
  if (connection.source === connection.target) return false;
  const sourceParent =
    confirmationParentId(connection.source) ?? connection.source;
  const targetParent =
    confirmationParentId(connection.target) ?? connection.target;
  if (
    connection.target === `confirmation:${sourceParent}` ||
    connection.source === `confirmation:${targetParent}`
  ) {
    return true;
  }
  return sourceParent !== targetParent;
}

function WorkflowMetrics({
  nodeCount,
  agentCount,
  releaseVersion,
  dirty,
}: {
  nodeCount: number;
  agentCount: number;
  releaseVersion?: string;
  dirty: boolean;
}) {
  const { t } = useTranslation('workflow');
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      className="workflow-studio-floating-controls pointer-events-auto flex h-10 shrink-0 items-center gap-1.5 px-3 text-[10px] text-muted-foreground"
      aria-expanded={open}
      aria-label={t('studio.previewInformation')}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onClick={() => setOpen((current) => !current)}
    >
      <span>{t('studio.nodeCount', { count: nodeCount })}</span>
      {open ? (
        <>
          <span aria-hidden="true">·</span>
          <span>{t('studio.agentCount', { count: agentCount })}</span>
          <span aria-hidden="true">·</span>
          <span className="font-mono">v{releaseVersion ?? '0.1'}</span>
        </>
      ) : null}
      {dirty ? (
        <span
          className="size-1.5 rounded-full bg-amber-500"
          title={t('studio.unsaved')}
        />
      ) : null}
    </button>
  );
}

function DraggableMiniMap() {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{
    x: number;
    y: number;
    ox: number;
    oy: number;
  } | null>(null);
  return (
    <div
      className="absolute bottom-16 right-3 z-10"
      style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
    >
      <div
        className="mb-1 flex h-5 cursor-grab items-center justify-center rounded-md bg-card/90 text-[9px] text-muted-foreground active:cursor-grabbing"
        onPointerDown={(event) => {
          event.preventDefault();
          drag.current = {
            x: event.clientX,
            y: event.clientY,
            ox: offset.x,
            oy: offset.y,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          setOffset({
            x: drag.current.ox + event.clientX - drag.current.x,
            y: drag.current.oy + event.clientY - drag.current.y,
          });
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
      >
        ∷
      </div>
      <MiniMap
        pannable
        zoomable
        className="!relative !bottom-auto !right-auto !m-0 !border !bg-card"
      />
    </div>
  );
}

function flameSpans(events: WorkflowEventRecord[]) {
  const sorted = [...events].sort(
    (left, right) => Number(left.sequence) - Number(right.sequence)
  );
  return sorted.map((event, index) => {
    const start = Date.parse(event.createdAt);
    const next = sorted[index + 1];
    const end = next ? Date.parse(next.createdAt) : start + 1;
    const duration = end - start;
    return {
      event,
      durationMs: Number.isFinite(duration) && duration > 0 ? duration : 1,
    };
  });
}

function previewMarkdown(output: string) {
  const trimmed = output.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return `\`\`\`json\n${trimmed}\n\`\`\``;
  }
  return trimmed;
}

function StudioAgentIcon({
  agentId,
  agentOptions,
  className,
}: {
  agentId: string;
  agentOptions: WorkflowStudioAgentOption[];
  className?: string;
}) {
  const icons = agentOptions.find((agent) => agent.value === agentId);
  return (
    <AgentIcon
      agent={agentId}
      className={className}
      iconLight={icons?.iconLight}
      iconDark={icons?.iconDark}
      iconSvg={icons?.iconSvg}
    />
  );
}

function statusClass(status?: string) {
  if (status === 'running' || status === 'claimed')
    return 'workflow-node-running';
  if (status === 'completed') return 'workflow-node-completed';
  if (status === 'failed' || status === 'cancelled')
    return 'workflow-node-failed';
  if (
    status === 'waiting_approval' ||
    status === 'needs_review' ||
    status === 'interrupted'
  ) {
    return 'workflow-node-waiting';
  }
  return '';
}

function statusDotClass(status?: string) {
  if (status === 'running' || status === 'claimed')
    return 'workflow-status-dot-running';
  if (status === 'completed') return 'workflow-status-dot-completed';
  if (status === 'failed' || status === 'cancelled')
    return 'workflow-status-dot-failed';
  if (
    status === 'waiting_approval' ||
    status === 'needs_review' ||
    status === 'interrupted' ||
    status === 'awaiting_acceptance' ||
    status === 'awaiting_input'
  ) {
    return 'workflow-status-dot-waiting';
  }
  return 'workflow-status-dot-standby';
}

function WorkflowStepNode({ data }: NodeProps<StudioNode>) {
  const { t } = useTranslation('workflow');
  const [logView, setLogView] = useState<'log' | 'preview'>('log');
  if (data.confirmationFor) {
    const waiting = data.stepRun?.awaitingAcceptance === true;
    const completed = data.stepRun?.status === 'completed';
    return (
      <article
        className={cn(
          'workflow-confirmation-node flex h-12 w-36 items-center gap-2 rounded-lg border bg-card px-3 text-left shadow-sm',
          data.selected && 'workflow-node-selected',
          waiting && 'workflow-confirmation-waiting',
          completed && 'workflow-node-completed'
        )}
      >
        <Handle
          id="target"
          type="target"
          position={Position.Left}
          isConnectable
          className="!size-3 !border-0"
        />
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => data.onSelect(data.confirmationFor!)}
          aria-label={
            waiting
              ? t('studio.confirmationRequired')
              : t('studio.confirmation')
          }
        >
          <Check className="size-4 shrink-0" />
          <span className="min-w-0 text-[11px] font-medium">
            {waiting
              ? t('studio.confirmationRequired')
              : completed
                ? t('studio.confirmed')
                : t('studio.confirmation')}
          </span>
        </button>
        <Handle
          id="source"
          type="source"
          position={Position.Right}
          isConnectable
          className="!size-3 !border-0"
        />
      </article>
    );
  }
  const agentStep = data.step.kind === 'agent' ? data.step : null;
  const notifyStep = data.step.kind === 'notify' ? data.step : null;
  const status = data.stepRun?.awaitingAcceptance
    ? 'awaiting_acceptance'
    : data.stepRun?.awaitingInput
      ? 'awaiting_input'
      : data.stepRun?.status;
  const statusLabel = status
    ? t(`status.${status}`, { defaultValue: status })
    : t('studio.standby');
  let agentLabel: string;
  if (data.step.kind === 'agent') {
    const agentId = data.step.agentId;
    agentLabel =
      data.agentOptions.find((agent) => agent.value === agentId)?.label ??
      agentId;
  } else if (data.step.kind === 'notify') {
    agentLabel = data.step.title.trim() || t('studio.notify');
  } else {
    agentLabel = data.step.title;
  }
  const logEvents = data.events.filter(
    (event) =>
      event.payloadJson.includes(`"step_id":"${data.step.id}"`) ||
      event.payloadJson.includes(`"stepId":"${data.step.id}"`)
  );
  return (
    <article
      className={cn(
        'workflow-studio-node group relative w-[248px] rounded-lg border bg-card text-left outline-none transition-[border-color,box-shadow,transform]',
        data.selected && 'workflow-node-selected',
        statusClass(data.stepRun?.status)
      )}
    >
      <Handle
        id="target"
        type="target"
        position={Position.Left}
        isConnectable
        className="!size-3 !border-0"
      />
      <button
        type="button"
        className="block !h-auto !min-h-[62px] w-full rounded-t-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
        onClick={() => data.onSelect(data.step.id)}
        aria-pressed={data.selected}
        aria-label={`${data.step.id} ${
          data.step.kind === 'agent' ? data.step.agentId : data.step.title
        }`}
      >
        <span className="flex items-start gap-3 p-3">
          <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border bg-muted/45 text-muted-foreground">
            {agentStep ? (
              <StudioAgentIcon
                agentId={agentStep.agentId}
                agentOptions={data.agentOptions}
                className="size-4"
              />
            ) : notifyStep ? (
              <Bell className="size-4" />
            ) : (
              <GitFork className="size-4" />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-semibold text-foreground">
              {data.step.id}
            </span>
            <span className="mt-1 inline-flex max-w-full items-center gap-1 rounded-full bg-muted/70 px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {agentStep ? (
                <StudioAgentIcon
                  agentId={agentStep.agentId}
                  agentOptions={data.agentOptions}
                  className="size-3"
                />
              ) : notifyStep ? (
                <Bell className="size-3" />
              ) : null}
              <span className="truncate">{agentLabel}</span>
            </span>
          </span>
          {data.stepRun?.status === 'completed' ? (
            <Check className="mt-1 size-3.5 text-emerald-600" />
          ) : null}
        </span>
      </button>
      <div className="flex min-h-8 items-center border-t px-2.5">
        <button
          type="button"
          className="nodrag inline-flex !h-6 items-center gap-1.5 rounded-full bg-muted/70 px-2 text-[10px] font-medium text-foreground hover:bg-muted"
          aria-expanded={data.logExpanded}
          onClick={(event) => {
            event.stopPropagation();
            data.onToggleLog(data.step.id);
          }}
        >
          <span
            className={cn('workflow-node-status-dot', statusDotClass(status))}
          />
          {statusLabel}
        </button>
      </div>
      {data.logExpanded ? (
        <div
          className="nodrag nowheel workflow-node-log absolute left-0 top-[calc(100%+8px)] z-30 w-[320px] rounded-lg border bg-card p-2.5 shadow-lg"
          data-testid={`workflow-node-log-${data.step.id}`}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold">
            <ListTree className="size-3.5" />
            {data.stepRun?.status === 'completed' ? (
              <div className="flex flex-1 items-center rounded-md bg-muted/65 p-0.5">
                {(['log', 'preview'] as const).map((view) => (
                  <button
                    type="button"
                    key={view}
                    className={cn(
                      'flex !h-6 flex-1 items-center justify-center rounded-md px-2 text-[10px] font-medium',
                      logView === view
                        ? 'bg-card text-foreground shadow-sm'
                        : 'text-muted-foreground'
                    )}
                    onClick={() => setLogView(view)}
                  >
                    {view === 'log'
                      ? t('studio.executionLog')
                      : t('studio.previewResult')}
                  </button>
                ))}
              </div>
            ) : (
              t('studio.executionLog')
            )}
          </div>
          {data.step.kind === 'notify' ? (
            <div className="space-y-2 text-[11px]">
              {data.predecessorRuns.length === 0 ? (
                <p className="text-[10px] text-muted-foreground">
                  {t('studio.noNotifyRecords')}
                </p>
              ) : (
                data.predecessorRuns.map((run) => (
                  <details
                    key={run.id}
                    className="rounded-md border bg-muted/20"
                    open
                  >
                    <summary className="cursor-pointer px-2 py-1.5 font-medium">
                      {t('studio.notifyRecord', {
                        step: run.stepId,
                        time: run.completedAt
                          ? new Date(run.completedAt).toLocaleString()
                          : t('studio.standby'),
                      })}
                    </summary>
                    <pre className="max-h-32 overflow-auto border-t p-2 text-[10px] leading-4">
                      {run.candidateOutputJson ??
                        run.outputJson ??
                        t('studio.noPreviewResult')}
                    </pre>
                  </details>
                ))
              )}
            </div>
          ) : data.stepRun?.status === 'completed' && logView === 'preview' ? (
            <div
              className="max-h-48 overflow-auto text-[11px] leading-5"
              data-testid={`workflow-node-preview-${data.step.id}`}
            >
              {data.stepRun.candidateOutputJson || data.stepRun.outputJson ? (
                <AstryxMarkdown
                  value={previewMarkdown(
                    data.stepRun.candidateOutputJson ??
                      data.stepRun.outputJson ??
                      ''
                  )}
                />
              ) : (
                <p className="text-[10px] text-muted-foreground">
                  {t('studio.noPreviewResult')}
                </p>
              )}
            </div>
          ) : logEvents.length === 0 ? (
            <p className="text-[10px] text-muted-foreground">
              {t('studio.noExecutionLog')}
            </p>
          ) : (
            <div className="space-y-2">
              <div
                className="workflow-flame"
                data-testid={`workflow-node-flame-${data.step.id}`}
                role="img"
                aria-label={t('studio.executionLog')}
              >
                {flameSpans(logEvents).map((span, index) => (
                  <div
                    key={span.event.id}
                    className="workflow-flame-span"
                    style={{
                      flexGrow: span.durationMs,
                      background: `hsl(${28 - Math.min(index, 8) * 3} 86% ${62 - Math.min(index, 8) * 4}%)`,
                    }}
                    title={`#${span.event.sequence.toString()} ${span.event.eventKind}`}
                  />
                ))}
              </div>
              <ol className="max-h-32 space-y-1 overflow-auto font-mono text-[10px]">
                {flameSpans(logEvents).map((span) => (
                  <li key={span.event.id} className="flex gap-2">
                    <span className="text-muted-foreground">
                      #{span.event.sequence.toString()}
                    </span>
                    <span className="truncate">{span.event.eventKind}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      ) : null}
      <Handle
        id="source"
        type="source"
        position={Position.Right}
        isConnectable
        className="!size-3 !border-0"
      />
    </article>
  );
}

const nodeTypes = { workflowStep: WorkflowStepNode };

function withoutStepOutputBindings(
  bindings: Record<string, WorkflowBinding | undefined>,
  removedStepIds: ReadonlySet<string>
) {
  return Object.fromEntries(
    Object.entries(bindings).filter(
      (entry): entry is [string, WorkflowBinding] => {
        const binding = entry[1];
        return Boolean(
          binding &&
            !(
              binding.source === 'step_output' &&
              removedStepIds.has(binding.step_id)
            )
        );
      }
    )
  );
}

function renameStepOutputBindings(
  bindings: Record<string, WorkflowBinding | undefined>,
  fromStepId: string,
  toStepId: string
) {
  return Object.fromEntries(
    Object.entries(bindings).flatMap(([name, binding]) => {
      if (!binding) return [];
      return [
        [
          name,
          binding.source === 'step_output' && binding.step_id === fromStepId
            ? { ...binding, step_id: toStepId }
            : binding,
        ],
      ];
    })
  ) as Record<string, WorkflowBinding | undefined>;
}
const EMPTY_STEPS: WorkflowStepView[] = [];
const EMPTY_EVENTS: WorkflowEventRecord[] = [];
const EMPTY_AGENT_OPTIONS: WorkflowStudioAgentOption[] = [];

function layoutNodes(
  definition: WorkflowDefinition,
  latest: Map<string, WorkflowStepView>,
  selectedStepId: string | null,
  mode: StudioMode,
  onSelect: (stepId: string) => void,
  events: WorkflowEventRecord[],
  agentOptions: WorkflowStudioAgentOption[],
  logStepId: string | null,
  onToggleLog: (stepId: string) => void
): StudioNode[] {
  const depths = new Map<string, number>();
  const depthOf = (step: WorkflowStep, seen = new Set<string>()): number => {
    const cached = depths.get(step.id);
    if (cached !== undefined) return cached;
    if (seen.has(step.id)) return 0;
    seen.add(step.id);
    const depth = step.dependsOn.reduce((maximum, dependency) => {
      const source = definition.steps.find(
        (candidate) => candidate.id === dependency
      );
      return source ? Math.max(maximum, depthOf(source, seen) + 1) : maximum;
    }, 0);
    depths.set(step.id, depth);
    return depth;
  };
  const rows = new Map<number, number>();
  const stepNodes: StudioNode[] = definition.steps.map((step) => {
    const depth = depthOf(step);
    const row = rows.get(depth) ?? 0;
    rows.set(depth, row + 1);
    return {
      id: step.id,
      type: 'workflowStep',
      position: { x: depth * 430 + 44, y: row * 160 + 76 },
      // The card has a fixed layout. Supplying its initial dimensions keeps
      // nodes visible in embedded WebViews where ResizeObserver may report a
      // frame late (React Flow hides unmeasured nodes by design).
      initialWidth: 248,
      initialHeight: 94,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      zIndex:
        selectedStepId === step.id ? 5 : logStepId === step.id ? 4 : undefined,
      handles: [
        {
          id: 'target',
          type: 'target',
          position: Position.Left,
          x: 0,
          y: 43,
          width: 8,
          height: 8,
        },
        {
          id: 'source',
          type: 'source',
          position: Position.Right,
          x: 240,
          y: 43,
          width: 8,
          height: 8,
        },
      ],
      style: { width: 248, height: 94 },
      data: {
        step,
        stepRun: latest.get(step.id),
        predecessorRuns: step.dependsOn.flatMap((id) => {
          const run = latest.get(id);
          return run ? [run] : [];
        }),
        events,
        agentOptions,
        selected: selectedStepId === step.id,
        logExpanded: logStepId === step.id,
        mode,
        onSelect,
        onToggleLog,
      },
    };
  });
  const confirmationNodes = definition.steps.flatMap((step) => {
    if (step.kind !== 'agent' || step.completionPolicy !== 'manual') return [];
    const owner = stepNodes.find((node) => node.id === step.id);
    if (!owner) return [];
    return [
      {
        id: `confirmation:${step.id}`,
        type: 'workflowStep' as const,
        position: (() => {
          const successor = definition.steps.find((candidate) =>
            candidate.dependsOn.includes(step.id)
          );
          const successorNode = successor
            ? stepNodes.find((node) => node.id === successor.id)
            : undefined;
          if (successorNode) {
            return {
              x: (owner.position.x + successorNode.position.x) / 2,
              y: (owner.position.y + successorNode.position.y) / 2,
            };
          }
          return {
            x: owner.position.x + CONFIRMATION_OFFSET.x,
            y: owner.position.y + CONFIRMATION_OFFSET.y,
          };
        })(),
        initialWidth: 144,
        initialHeight: 48,
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        selectable: true,
        handles: [
          {
            id: 'target',
            type: 'target',
            position: Position.Left,
            x: 0,
            y: 20,
            width: 8,
            height: 8,
          },
          {
            id: 'source',
            type: 'source',
            position: Position.Right,
            x: 136,
            y: 20,
            width: 8,
            height: 8,
          },
        ],
        style: { width: 144, height: 48 },
        data: {
          step,
          confirmationFor: step.id,
          stepRun: latest.get(step.id),
          predecessorRuns: [],
          events,
          agentOptions,
          selected: selectedStepId === step.id,
          logExpanded: false,
          mode,
          onSelect,
          onToggleLog,
        },
      } satisfies StudioNode,
    ];
  });
  return [...stepNodes, ...confirmationNodes];
}

function buildEdges(
  definition: WorkflowDefinition,
  latest: Map<string, WorkflowStepView>
) {
  const dependencyEdges = definition.steps.flatMap((step) =>
    step.dependsOn.map((sourceStepId) => {
      const sourceStep = definition.steps.find(
        (candidate) => candidate.id === sourceStepId
      );
      const source =
        sourceStep?.kind === 'agent' && sourceStep.completionPolicy === 'manual'
          ? `confirmation:${sourceStepId}`
          : sourceStepId;
      const sourceStatus = latest.get(sourceStepId)?.status;
      const targetStatus = latest.get(step.id)?.status;
      return {
        id: `${sourceStepId}->${step.id}`,
        source,
        target: step.id,
        sourceHandle: 'source',
        targetHandle: 'target',
        animated:
          sourceStatus === 'running' ||
          sourceStatus === 'claimed' ||
          targetStatus === 'running' ||
          targetStatus === 'claimed',
        className: cn(
          'workflow-studio-edge',
          sourceStatus === 'completed' && 'workflow-edge-completed'
        ),
      } satisfies Edge;
    })
  );
  const confirmationEdges = definition.steps.flatMap((step) =>
    step.kind === 'agent' && step.completionPolicy === 'manual'
      ? [
          {
            id: `${step.id}->confirmation:${step.id}`,
            source: step.id,
            target: `confirmation:${step.id}`,
            sourceHandle: 'source',
            targetHandle: 'target',
            deletable: false,
            reconnectable: false,
            focusable: false,
            animated:
              latest.get(step.id)?.awaitingAcceptance === true ||
              latest.get(step.id)?.status === 'running',
            className: cn(
              'workflow-studio-edge',
              latest.get(step.id)?.status === 'completed' &&
                'workflow-edge-completed'
            ),
          } satisfies Edge,
        ]
      : []
  );
  return [...dependencyEdges, ...confirmationEdges];
}

export function WorkflowStudio({
  definition,
  onDefinitionChange,
  run,
  steps = EMPTY_STEPS,
  events = EMPTY_EVENTS,
  dirty,
  saving,
  publishing,
  onSave,
  onPublish,
  releaseVersion,
  canUndo = false,
  onUndo,
  workspaceConfig,
  workspaceSummary,
  onBack,
  editorName,
  onEditorNameChange,
  agentOptions = EMPTY_AGENT_OPTIONS,
  loadAgentSessionControls,
  onStopRun,
  onTerminateRun,
  onReset,
  notifyContext,
  showStopActions = false,
  stopActionsDisabled = false,
  resetDisabled = false,
  onPauseRun,
  onResumeRun,
  onTestNode,
  onRerunFromNode,
  onAcceptCandidate,
  onPauseStep,
  onSubmitStepInput,
  onDecideApproval,
  onReview,
  activeWorktree,
  className,
}: WorkflowStudioProps) {
  const { t, i18n } = useTranslation('workflow');
  const mode: StudioMode = onDefinitionChange ? 'edit' : 'run';
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [inspectorTab, setInspectorTab] = useState<'info' | 'conversation'>(
    'info'
  );
  const [outputTab, setOutputTab] = useState<'brief' | 'strict'>('strict');
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    kind: 'pane' | 'node';
    stepId?: string;
    confirmation?: boolean;
  } | null>(null);
  const [logStepId, setLogStepId] = useState<string | null>(null);
  const [primaryStopAction, setPrimaryStopAction] = useState<
    'stop' | 'terminate'
  >('stop');
  const [decisionJson, setDecisionJson] = useState('{}');
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [unsavedStepIds, setUnsavedStepIds] = useState<Set<string>>(
    () => new Set()
  );
  const [agentControls, setAgentControls] =
    useState<AgentSessionControlsSnapshot | null>(null);
  const [agentControlsLoading, setAgentControlsLoading] = useState(false);
  const loadAgentSessionControlsRef = useRef(loadAgentSessionControls);
  loadAgentSessionControlsRef.current = loadAgentSessionControls;
  const latest = useMemo(
    () =>
      new Map(
        latestWorkflowStepAttempts(steps).map((step) => [step.stepId, step])
      ),
    [steps]
  );
  const notifiedRuns = useRef(new Set<string>());
  const { config } = useOptionalUserSystem() ?? {};
  useEffect(() => {
    const notifications = config?.notifications;
    if (!notifications) return;
    for (const step of latest.values()) {
      if (step.status !== 'completed' || notifiedRuns.current.has(step.id))
        continue;
      const spec = definition.steps.find((item) => item.id === step.stepId);
      if (spec?.kind !== 'notify') continue;
      notifiedRuns.current.add(step.id);
      const title = spec.title.trim() || spec.id;
      const predecessor = spec.dependsOn[0] ?? spec.id;
      void deliverDesktopNotification({
        windowFocused: document.hasFocus(),
        notifyWhen: notifications.notify_when ?? 'unfocused',
        soundEnabled: notifications.sound_enabled,
        soundFile: notifications.sound_file ?? SoundFile.ABSTRACT_SOUND1,
        pushEnabled: notifications.push_enabled,
        playSound: configApi.playNotificationSound,
        showPush: () =>
          notifyContext
            ? showDesktopToast({
                projectId: notifyContext.projectId,
                workspaceId: notifyContext.workspaceId,
                sessionId: run?.id ?? step.id,
                title,
                description: `${predecessor} · ${
                  step.completedAt
                    ? new Date(step.completedAt).toLocaleString()
                    : ''
                }`,
                kind: 'success',
                durationMs: 15000,
              })
            : Promise.resolve(),
      });
    }
  }, [config, definition.steps, latest, notifyContext, run?.id]);
  const toggleLog = useCallback((stepId: string) => {
    setLogStepId((current) => (current === stepId ? null : stepId));
  }, []);
  const layoutedNodes = useMemo(
    () =>
      layoutNodes(
        definition,
        latest,
        selectedStepId,
        mode,
        setSelectedStepId,
        events,
        agentOptions,
        logStepId,
        toggleLog
      ),
    [
      agentOptions,
      definition,
      events,
      latest,
      logStepId,
      mode,
      selectedStepId,
      toggleLog,
    ]
  );
  const [nodes, setNodes, onNodesChange] = useNodesState(layoutedNodes);
  useEffect(() => {
    setNodes((current) =>
      layoutedNodes.map((next) => {
        const existing = current.find((node) => node.id === next.id);
        return existing ? { ...next, position: existing.position } : next;
      })
    );
  }, [layoutedNodes, setNodes]);
  const derivedEdges = useMemo(
    () => buildEdges(definition, latest),
    [definition, latest]
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(derivedEdges);
  useEffect(() => {
    setEdges(derivedEdges);
  }, [derivedEdges, setEdges]);
  const selectedStep =
    definition.steps.find((step) => step.id === selectedStepId) ?? null;
  const selectedRun = selectedStepId ? latest.get(selectedStepId) : undefined;
  const selectedStepSaved = selectedStepId
    ? !unsavedStepIds.has(selectedStepId)
    : false;
  const selectedSuccessors = selectedStepId
    ? definition.steps
        .filter((step) => step.dependsOn.includes(selectedStepId))
        .map((step) => step.id)
    : [];
  const selectedAgentId =
    selectedStep?.kind === 'agent' ? selectedStep.agentId : null;
  const canLoadAgentSessionControls = Boolean(loadAgentSessionControls);
  useEffect(() => {
    const loadControls = loadAgentSessionControlsRef.current;
    if (!selectedAgentId || !loadControls) {
      setAgentControls(null);
      setAgentControlsLoading(false);
      return;
    }
    let active = true;
    setAgentControlsLoading(true);
    void loadControls(selectedAgentId)
      .then((controls) => {
        if (active) setAgentControls(controls);
      })
      .finally(() => {
        if (active) setAgentControlsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [canLoadAgentSessionControls, selectedAgentId]);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const inspectorRef = useRef<HTMLElement | null>(null);
  const [flowInstance, setFlowInstance] =
    useState<ReactFlowInstance<StudioNode> | null>(null);
  const [tetherPath, setTetherPath] = useState('');

  const revealSelectedNode = useCallback(() => {
    if (
      !selectedStepId ||
      !stageRef.current ||
      !inspectorRef.current ||
      !flowInstance
    ) {
      return;
    }
    const node = stageRef.current.querySelector<HTMLElement>(
      `.react-flow__node[data-id="${CSS.escape(selectedStepId)}"]`
    );
    if (!node) return;
    const nodeRect = node.getBoundingClientRect();
    const inspectorRect = inspectorRef.current.getBoundingClientRect();
    const overlap = nodeRect.right - (inspectorRect.left - 28);
    if (overlap <= 0) return;
    const viewport = flowInstance.getViewport();
    void flowInstance.setViewport(
      { ...viewport, x: viewport.x - overlap },
      { duration: 180 }
    );
  }, [flowInstance, selectedStepId]);

  const confirmationOffsets = useRef(
    new Map<string, { x: number; y: number }>()
  );
  const syncConfirmationDrag = useCallback(
    (node: StudioNode) => {
      const parentId = confirmationParentId(node.id);
      if (parentId) {
        setNodes((current) => {
          const owner = current.find((candidate) => candidate.id === parentId);
          if (owner) {
            confirmationOffsets.current.set(parentId, {
              x: node.position.x - owner.position.x,
              y: node.position.y - owner.position.y,
            });
          }
          return current;
        });
        return;
      }
      const offset =
        confirmationOffsets.current.get(node.id) ?? CONFIRMATION_OFFSET;
      setNodes((current) =>
        current.map((candidate) =>
          candidate.data.confirmationFor === node.id
            ? {
                ...candidate,
                position: {
                  x: node.position.x + offset.x,
                  y: node.position.y + offset.y,
                },
              }
            : candidate
        )
      );
    },
    [setNodes]
  );

  const updateTether = useCallback(() => {
    if (!selectedStepId || !stageRef.current || !inspectorRef.current) {
      setTetherPath('');
      return;
    }
    const stageRect = stageRef.current.getBoundingClientRect();
    const node = stageRef.current.querySelector<HTMLElement>(
      `.react-flow__node[data-id="${CSS.escape(selectedStepId)}"]`
    );
    if (!node) {
      setTetherPath('');
      return;
    }
    const nodeRect = node.getBoundingClientRect();
    const inspectorRect = inspectorRef.current.getBoundingClientRect();
    const startX = nodeRect.left - stageRect.left + nodeRect.width * 0.72;
    const startY = nodeRect.top - stageRect.top;
    const endX = inspectorRect.left - stageRect.left;
    const endY = inspectorRect.top - stageRect.top + 38;
    setTetherPath(`M ${startX} ${startY} V ${endY} H ${endX}`);
  }, [selectedStepId]);

  useEffect(() => {
    if (!selectedStepId) return;
    const frame = requestAnimationFrame(() => {
      revealSelectedNode();
      updateTether();
    });
    const observer = new ResizeObserver(updateTether);
    if (stageRef.current) observer.observe(stageRef.current);
    if (inspectorRef.current) observer.observe(inspectorRef.current);
    window.addEventListener('resize', updateTether);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', updateTether);
    };
  }, [revealSelectedNode, selectedStepId, updateTether]);

  const updateJson = useCallback(
    (value: string, apply: (parsed: JsonValue | null) => void) => {
      try {
        apply(value.trim() ? (JSON.parse(value) as JsonValue) : null);
        setJsonError(null);
      } catch {
        setJsonError(t('studio.invalidJson'));
      }
    },
    [t]
  );

  useEffect(() => {
    if (
      selectedStepId &&
      !definition.steps.some((step) => step.id === selectedStepId)
    ) {
      setSelectedStepId(null);
    }
  }, [definition.steps, selectedStepId]);

  const previousSelectedStepId = useRef<string | null>(null);
  useEffect(() => {
    if (previousSelectedStepId.current === selectedStepId) return;
    previousSelectedStepId.current = selectedStepId;
    const step = definition.steps.find((item) => item.id === selectedStepId);
    setOutputTab(
      step?.kind === 'agent' && step.outputDescription ? 'brief' : 'strict'
    );
  }, [definition.steps, selectedStepId]);

  const updateStep = useCallback(
    (stepId: string, update: (step: WorkflowStep) => WorkflowStep) => {
      setUnsavedStepIds((current) => new Set(current).add(stepId));
      onDefinitionChange?.({
        ...definition,
        steps: definition.steps.map((step) =>
          step.id === stepId ? update(step) : step
        ),
      });
    },
    [definition, onDefinitionChange]
  );

  const connect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target || !onDefinitionChange)
        return;
      if (!isWorkflowConnectionValid(connection)) return;
      const sourceId =
        confirmationParentId(connection.source) ?? connection.source;
      const targetId =
        confirmationParentId(connection.target) ?? connection.target;
      if (sourceId === targetId) return;
      const target = definition.steps.find((step) => step.id === targetId);
      if (!target || target.dependsOn.includes(sourceId)) return;
      onDefinitionChange({
        ...definition,
        steps: definition.steps.map((step) =>
          step.id === targetId
            ? { ...step, dependsOn: [...step.dependsOn, sourceId] }
            : step
        ),
      });
    },
    [definition, onDefinitionChange]
  );

  const isValidConnection = useCallback(
    (connection: Connection | Edge) => isWorkflowConnectionValid(connection),
    []
  );

  const removeEdges = useCallback(
    (deletedEdges: Edge[]) => {
      if (!onDefinitionChange) return;
      const deleted = new Set(
        deletedEdges
          .filter((edge) => !edge.id.includes('confirmation:'))
          .map((edge) => edge.id)
      );
      if (deleted.size === 0) return;
      onDefinitionChange({
        ...definition,
        steps: definition.steps.map((step) => {
          const removedSources = new Set(
            step.dependsOn.filter((source) =>
              deleted.has(`${source}->${step.id}`)
            )
          );
          return {
            ...step,
            dependsOn: step.dependsOn.filter(
              (source) => !removedSources.has(source)
            ),
            inputBindings: withoutStepOutputBindings(
              step.inputBindings,
              removedSources
            ),
          };
        }),
      });
    },
    [definition, onDefinitionChange]
  );

  const nextStepId = () => {
    let ordinal = definition.steps.length + 1;
    while (definition.steps.some((step) => step.id === `step-${ordinal}`))
      ordinal += 1;
    return `step-${ordinal}`;
  };

  const addStep = (kind: 'agent' | 'notify', dependsOn: string[] = []) => {
    if (!onDefinitionChange) return;
    const common = {
      id: nextStepId(),
      dependsOn:
        dependsOn.length > 0
          ? dependsOn
          : selectedStepId
            ? [selectedStepId]
            : [],
      phase: null,
      inputBindings: {},
    };
    const step: WorkflowStep =
      kind === 'agent'
        ? {
            ...common,
            kind: 'agent',
            agentId: agentOptions[0]?.value ?? 'codex',
            prompt: '',
            executorProfileId: null,
            modeOverride: null,
            configOverrides: {},
            outputLanguage: i18n.resolvedLanguage ?? i18n.language,
            outputDescription: null,
            outputSchema: DEFAULT_OUTPUT_SCHEMA,
            workspaceAccess: 'native',
            sideEffectClass: 'mutating_unknown',
            allowOneRepair: false,
            allowSkipOnReview: false,
            completionPolicy: 'automatic',
          }
        : {
            ...common,
            kind: 'notify',
            title: t('studio.newNotify'),
          };
    onDefinitionChange({ ...definition, steps: [...definition.steps, step] });
    setUnsavedStepIds((current) => new Set(current).add(step.id));
    setSelectedStepId(step.id);
    setInspectorTab('info');
  };

  const copySelected = (stepId: string) => {
    if (!onDefinitionChange) return;
    const source = definition.steps.find((step) => step.id === stepId);
    if (!source || source.kind === 'approval') return;
    const copy: WorkflowStep = { ...source, id: nextStepId() };
    onDefinitionChange({
      ...definition,
      steps: [...definition.steps, copy],
    });
    setUnsavedStepIds((current) => new Set(current).add(copy.id));
    setSelectedStepId(copy.id);
  };

  const removeStep = (stepId: string) => {
    if (!onDefinitionChange) return;
    onDefinitionChange({
      ...definition,
      steps: definition.steps
        .filter((step) => step.id !== stepId)
        .map((step) => ({
          ...step,
          dependsOn: step.dependsOn.filter(
            (dependency) => dependency !== stepId
          ),
          inputBindings: withoutStepOutputBindings(
            step.inputBindings,
            new Set([stepId])
          ),
        })),
    });
    setUnsavedStepIds((current) => {
      const next = new Set(current);
      next.delete(stepId);
      return next;
    });
    setSelectedStepId((current) => (current === stepId ? null : current));
  };

  const removeSelected = () => {
    if (selectedStep) removeStep(selectedStep.id);
  };

  return (
    <section
      className={cn(
        'workflow-studio flex min-h-0 flex-1 flex-col bg-background',
        className
      )}
    >
      <div
        ref={stageRef}
        className="workflow-studio-stage relative min-h-0 flex-1 overflow-hidden"
      >
        <div className="pointer-events-none absolute inset-x-3 top-3 z-40 flex items-start gap-2 overflow-x-auto pb-2">
          {onBack ? (
            <div className="workflow-studio-floating-controls pointer-events-auto flex shrink-0 items-center p-1">
              <Button
                size="icon"
                variant="ghost"
                className="size-7"
                onClick={onBack}
                aria-label={t('studio.back')}
              >
                <ArrowLeft className="size-3.5" />
              </Button>
            </div>
          ) : null}

          <div className="workflow-studio-floating-controls pointer-events-auto flex shrink-0 items-center p-1">
            {onDefinitionChange ? (
              <Input
                aria-label={t('studio.name')}
                className="h-8 w-40 border-transparent bg-transparent text-sm font-semibold"
                value={editorName ?? definition.name}
                onChange={(event) => onEditorNameChange?.(event.target.value)}
              />
            ) : (
              <span className="max-w-56 truncate px-2 text-sm font-semibold">
                {definition.name}
              </span>
            )}
          </div>

          <WorkflowMetrics
            nodeCount={definition.steps.length}
            agentCount={
              definition.steps.filter((step) => step.kind === 'agent').length
            }
            releaseVersion={releaseVersion}
            dirty={Boolean(dirty)}
          />

          <div className="workflow-studio-floating-controls pointer-events-auto ml-auto flex shrink-0 items-center gap-1 p-1">
            {onDefinitionChange ? (
              <>
                {workspaceConfig ? (
                  <Button
                    size="sm"
                    variant={workspaceOpen ? 'secondary' : 'ghost'}
                    aria-expanded={workspaceOpen}
                    onClick={() => {
                      setWorkspaceOpen((open) => !open);
                      setSelectedStepId(null);
                    }}
                  >
                    <SlidersHorizontal className="mr-1.5 size-3.5" />
                    {workspaceSummary ?? t('studio.workspace')}
                  </Button>
                ) : null}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="ghost">
                      <Plus className="mr-1 size-3.5" /> {t('studio.addNode')}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" sideOffset={8}>
                    <DropdownMenuItem onSelect={() => addStep('agent')}>
                      <AgentIcon agent="codex" className="size-4" />
                      {t('studio.agentStep')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => addStep('notify')}>
                      <Bell className="size-4" /> {t('studio.notify')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  onClick={onUndo}
                  disabled={!canUndo}
                  aria-label={t('studio.undo')}
                  title={t('studio.undo')}
                >
                  <Undo2 className="size-3.5" />
                </Button>
                {showStopActions || onStopRun || onTerminateRun ? (
                  <div className="raised-control inline-flex h-7 items-center overflow-hidden rounded-lg">
                    <button
                      type="button"
                      className="inline-flex h-7 items-center justify-center gap-1.5 px-2.5 text-xs font-medium leading-none disabled:cursor-not-allowed disabled:opacity-50"
                      aria-label={
                        primaryStopAction === 'stop'
                          ? t('studio.stop')
                          : t('studio.terminate')
                      }
                      disabled={
                        stopActionsDisabled ||
                        (primaryStopAction === 'stop'
                          ? !onStopRun
                          : !onTerminateRun)
                      }
                      onClick={
                        primaryStopAction === 'stop'
                          ? onStopRun
                          : onTerminateRun
                      }
                    >
                      <Square className="size-3.5" />
                      {primaryStopAction === 'stop'
                        ? t('studio.stop')
                        : t('studio.terminate')}
                    </button>
                    <span className="h-3.5 w-px bg-border" aria-hidden />
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className="inline-flex h-7 w-7 items-center justify-center text-muted-foreground hover:text-foreground"
                          aria-label={t('studio.chooseStopAction')}
                        >
                          <ChevronDown className="size-3.5" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onSelect={() => setPrimaryStopAction('stop')}
                        >
                          <CirclePause /> {t('studio.stop')}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-destructive"
                          onSelect={() => setPrimaryStopAction('terminate')}
                        >
                          <Square /> {t('studio.terminate')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                ) : null}
                {showStopActions || onReset ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={resetDisabled}
                    onClick={() => {
                      setSelectedStepId(null);
                      setLogStepId(null);
                      setWorkspaceOpen(false);
                      setDecisionJson('{}');
                      setDecisionError(null);
                      setJsonError(null);
                      onReset?.();
                    }}
                  >
                    <RotateCcw className="mr-1.5 size-3.5" />
                    {t('studio.reset')}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onSave}
                  disabled={!dirty || saving || unsavedStepIds.size > 0}
                >
                  {saving ? t('studio.saving') : t('studio.save')}
                </Button>
                <Button
                  size="sm"
                  onClick={onPublish}
                  disabled={publishing || unsavedStepIds.size > 0}
                >
                  {publishing ? t('studio.publishing') : t('studio.publish')}
                </Button>
              </>
            ) : run && run.controlState === 'active' ? (
              <Button size="sm" variant="outline" onClick={onPauseRun}>
                <CirclePause className="mr-1.5 size-3.5" /> {t('studio.pause')}
              </Button>
            ) : run ? (
              <Button size="sm" variant="outline" onClick={onResumeRun}>
                <CirclePlay className="mr-1.5 size-3.5" /> {t('studio.resume')}
              </Button>
            ) : null}
          </div>
        </div>
        <ReactFlow<StudioNode>
          onInit={setFlowInstance}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={(_, node) => {
            setSelectedStepId(node.data.confirmationFor ?? node.id);
            if (node.data.confirmationFor) setInspectorTab('conversation');
            setWorkspaceOpen(false);
          }}
          onNodeDrag={(_, node) => {
            syncConfirmationDrag(node);
            requestAnimationFrame(updateTether);
          }}
          onNodeDragStop={(_, node) => syncConfirmationDrag(node)}
          onPaneClick={() => {
            setSelectedStepId(null);
            setContextMenu(null);
          }}
          onNodeContextMenu={(event, node) => {
            event.preventDefault();
            setContextMenu({
              x: event.clientX,
              y: event.clientY,
              kind: 'node',
              stepId: node.data.confirmationFor ?? node.id,
              confirmation: Boolean(node.data.confirmationFor),
            });
          }}
          onPaneContextMenu={(event) => {
            event.preventDefault();
            setContextMenu({
              x: event.clientX,
              y: event.clientY,
              kind: 'pane',
            });
          }}
          onMove={() => requestAnimationFrame(updateTether)}
          onConnect={connect}
          isValidConnection={isValidConnection}
          connectionMode={ConnectionMode.Loose}
          onEdgesDelete={removeEdges}
          onEdgeDoubleClick={(event, edge) => {
            event.stopPropagation();
            if (edge.id.includes('confirmation:')) return;
            removeEdges([edge]);
          }}
          edgesReconnectable={false}
          nodesDraggable={Boolean(onDefinitionChange)}
          nodesConnectable={Boolean(onDefinitionChange)}
          proOptions={{ hideAttribution: true }}
          fitView
          fitViewOptions={{ padding: 0.24, maxZoom: 1.1 }}
          minZoom={0.35}
          maxZoom={1.65}
          colorMode="system"
        >
          <Background gap={22} size={1} color="var(--border)" />
          <Controls
            showInteractive={false}
            fitViewOptions={{ padding: 0.24, maxZoom: 1.1 }}
          />
          <DraggableMiniMap />
        </ReactFlow>
        {contextMenu ? (
          <DropdownMenu
            open
            onOpenChange={(open) => {
              if (!open) setContextMenu(null);
            }}
          >
            <DropdownMenuTrigger asChild>
              <span
                className="pointer-events-none fixed size-0"
                style={{ left: contextMenu.x, top: contextMenu.y }}
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-40">
              {contextMenu.kind === 'pane' ? (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <Plus className="size-4" /> {t('studio.addNode')}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <DropdownMenuItem
                      onSelect={() => {
                        addStep('agent');
                        setContextMenu(null);
                      }}
                    >
                      <AgentIcon agent="codex" className="size-4" />
                      {t('studio.agentStep')}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => {
                        addStep('notify');
                        setContextMenu(null);
                      }}
                    >
                      <Bell className="size-4" /> {t('studio.notify')}
                    </DropdownMenuItem>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              ) : (
                <>
                  {contextMenu.confirmation ? null : (
                    <>
                      <DropdownMenuItem
                        onSelect={() => {
                          if (contextMenu.stepId)
                            copySelected(contextMenu.stepId);
                          setContextMenu(null);
                        }}
                      >
                        <Copy className="size-4" /> {t('studio.copyNode')}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-destructive"
                        disabled={definition.steps.length === 1}
                        onSelect={() => {
                          if (contextMenu.stepId)
                            removeStep(contextMenu.stepId);
                          setContextMenu(null);
                        }}
                      >
                        <Trash2 className="size-4" /> {t('studio.deleteNode')}
                      </DropdownMenuItem>
                    </>
                  )}
                  <DropdownMenuItem
                    onSelect={() => {
                      if (contextMenu.stepId) setLogStepId(contextMenu.stepId);
                      setContextMenu(null);
                    }}
                  >
                    <ListTree className="size-4" /> {t('studio.showRecords')}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {activeWorktree ? (
          <div
            className="workflow-studio-floating-controls pointer-events-none absolute bottom-3 right-3 z-20 max-w-[220px] px-2.5 py-1.5"
            data-testid="workflow-active-worktree"
          >
            <div className="truncate text-[11px] font-medium">
              {activeWorktree.name}
            </div>
            <div className="truncate font-mono text-[10px] text-muted-foreground">
              {activeWorktree.path}
            </div>
          </div>
        ) : null}

        {selectedStep ? (
          <svg
            className="workflow-inspector-tether pointer-events-none absolute inset-0 z-10 size-full overflow-visible"
            data-testid="workflow-inspector-tether"
            aria-hidden="true"
          >
            <path d={tetherPath} fill="none" />
          </svg>
        ) : null}

        {workspaceOpen && workspaceConfig ? (
          <aside
            data-testid="workflow-workspace-panel"
            className="workflow-workspace-panel absolute right-3 top-16 z-30 flex max-h-[calc(100%-76px)] w-[min(340px,calc(100%-24px))] flex-col overflow-hidden rounded-lg border bg-card shadow-xl"
          >
            <div className="flex items-center justify-between px-3.5 py-2.5">
              <span className="text-sm font-semibold">
                {t('studio.workspace')}
              </span>
              <Button
                size="icon"
                variant="ghost"
                className="size-7"
                onClick={() => setWorkspaceOpen(false)}
                aria-label={t('studio.close')}
              >
                <X className="size-3.5" />
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto px-3.5 pb-3.5">
              {workspaceConfig}
            </div>
          </aside>
        ) : null}

        {selectedStep ? (
          <aside
            ref={inspectorRef}
            className="workflow-node-inspector absolute right-3 top-16 z-20 flex w-[min(430px,calc(100%-24px))] flex-col overflow-hidden rounded-lg border bg-card shadow-xl"
          >
            <div className="flex items-center gap-2 px-3.5 py-2.5">
              <Input
                aria-label={t('studio.nodeName')}
                className="h-8 min-w-0 flex-1 border-transparent bg-transparent px-1 text-sm font-semibold"
                value={selectedStep.id}
                disabled={!onDefinitionChange}
                onChange={(event) => {
                  const nextId = event.target.value;
                  if (
                    !nextId ||
                    definition.steps.some(
                      (step) =>
                        step.id === nextId && step.id !== selectedStep.id
                    )
                  )
                    return;
                  onDefinitionChange?.({
                    ...definition,
                    steps: definition.steps.map((step) => ({
                      ...step,
                      id: step.id === selectedStep.id ? nextId : step.id,
                      dependsOn: step.dependsOn.map((dependency) =>
                        dependency === selectedStep.id ? nextId : dependency
                      ),
                      inputBindings: renameStepOutputBindings(
                        step.inputBindings,
                        selectedStep.id,
                        nextId
                      ),
                    })),
                  });
                  setUnsavedStepIds((current) => {
                    const next = new Set(current);
                    next.delete(selectedStep.id);
                    next.add(nextId);
                    return next;
                  });
                  setSelectedStepId(nextId);
                }}
              />
              <div className="flex shrink-0 items-center rounded-lg bg-muted/65 p-0.5">
                {(['info', 'conversation'] as const).map((tab) => (
                  <button
                    type="button"
                    key={tab}
                    className={cn(
                      'flex !h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium',
                      inspectorTab === tab
                        ? 'bg-card text-foreground shadow-sm'
                        : 'text-muted-foreground'
                    )}
                    onClick={() => setInspectorTab(tab)}
                  >
                    {tab === 'info' ? (
                      <GitFork className="size-3.5" />
                    ) : (
                      <MessageSquare className="size-3.5" />
                    )}
                    {tab === 'info'
                      ? t('studio.node')
                      : t('studio.conversation')}
                  </button>
                ))}
              </div>
              <Button
                size="icon"
                variant="ghost"
                className="size-7"
                onClick={() => {
                  setSelectedStepId(null);
                }}
                aria-label={t('studio.close')}
              >
                <X className="size-3.5" />
              </Button>
            </div>
            <div
              className={cn(
                'min-h-0 flex-1 p-3.5 pt-1',
                inspectorTab === 'conversation'
                  ? 'overflow-hidden'
                  : 'overflow-auto'
              )}
            >
              {inspectorTab === 'conversation' ? (
                <WorkflowStepConversation
                  stepRun={selectedRun}
                  saved={!unsavedStepIds.has(selectedStep.id)}
                  workspacePath={activeWorktree?.path}
                  onPause={() => onPauseStep?.(selectedStep.id)}
                  onSubmit={(text) =>
                    onSubmitStepInput?.(selectedStep.id, text)
                  }
                  onConfirm={
                    selectedRun?.awaitingAcceptance
                      ? () => onAcceptCandidate?.(selectedStep.id)
                      : undefined
                  }
                />
              ) : (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    {[
                      {
                        label: t('studio.predecessors'),
                        values: selectedStep.dependsOn,
                      },
                      {
                        label: t('studio.successors'),
                        values: selectedSuccessors,
                      },
                    ].map((relation) => (
                      <div key={relation.label} className="space-y-1.5">
                        <Label>{relation.label}</Label>
                        <div className="flex min-h-8 flex-wrap items-center gap-1 rounded-lg bg-muted/55 px-2 py-1.5">
                          {relation.values.length === 0 ? (
                            <span className="text-[11px] text-muted-foreground">
                              {t('studio.none')}
                            </span>
                          ) : (
                            relation.values.map((value) => (
                              <span
                                key={value}
                                className="rounded-full bg-card px-2 py-0.5 font-mono text-[10px] shadow-sm"
                              >
                                {value}
                              </span>
                            ))
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                  {selectedStep.kind === 'notify' ? (
                    <>
                      <div className="space-y-1.5">
                        <Label htmlFor="workflow-notify-title">
                          {t('studio.title')}
                        </Label>
                        <Input
                          id="workflow-notify-title"
                          value={selectedStep.title}
                          disabled={!onDefinitionChange}
                          onChange={(event) =>
                            updateStep(selectedStep.id, (step) => ({
                              ...step,
                              title: event.target.value,
                            }))
                          }
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label>{t('studio.notifyRecords')}</Label>
                        <div className="space-y-2">
                          {definition.steps
                            .filter((step) =>
                              selectedStep.dependsOn.includes(step.id)
                            )
                            .map((step) => {
                              const run = latest.get(step.id);
                              return (
                                <details
                                  key={step.id}
                                  className="rounded-lg border bg-muted/20"
                                  open
                                >
                                  <summary className="cursor-pointer px-3 py-2 text-xs font-medium">
                                    {t('studio.notifyRecord', {
                                      step: step.id,
                                      time: run?.completedAt
                                        ? new Date(
                                            run.completedAt
                                          ).toLocaleString()
                                        : t('studio.standby'),
                                    })}
                                  </summary>
                                  <pre className="max-h-40 overflow-auto border-t p-3 text-[11px] leading-5">
                                    {run?.candidateOutputJson ??
                                      run?.outputJson ??
                                      t('studio.noPreviewResult')}
                                  </pre>
                                </details>
                              );
                            })}
                        </div>
                      </div>
                    </>
                  ) : selectedStep.kind === 'agent' ? (
                    <>
                      <div className="space-y-1.5">
                        <Label>{t('studio.agent')}</Label>
                        <Select
                          value={selectedStep.agentId}
                          disabled={!onDefinitionChange}
                          onValueChange={(agentId) =>
                            updateStep(selectedStep.id, (step) =>
                              step.kind === 'agent'
                                ? {
                                    ...step,
                                    agentId,
                                    executorProfileId: {
                                      executor: agentId,
                                      variant: null,
                                    },
                                    modeOverride: null,
                                    configOverrides: {},
                                  }
                                : step
                            )
                          }
                        >
                          <SelectTrigger>
                            <SelectValue>
                              <span className="flex items-center gap-2">
                                <StudioAgentIcon
                                  agentId={selectedStep.agentId}
                                  agentOptions={agentOptions}
                                  className="size-4"
                                />
                                {agentOptions.find(
                                  (agent) =>
                                    agent.value === selectedStep.agentId
                                )?.label ?? selectedStep.agentId}
                              </span>
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            {(agentOptions.some(
                              (agent) => agent.value === selectedStep.agentId
                            )
                              ? agentOptions
                              : [
                                  ...agentOptions,
                                  {
                                    value: selectedStep.agentId,
                                    label: selectedStep.agentId,
                                  },
                                ]
                            ).map((agent) => (
                              <SelectItem key={agent.value} value={agent.value}>
                                <span className="flex items-center gap-2">
                                  <StudioAgentIcon
                                    agentId={agent.value}
                                    agentOptions={agentOptions}
                                    className="size-4"
                                  />
                                  {agent.label}
                                </span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1.5">
                        {agentControls ? (
                          <SessionSettingsSummary
                            sessionModes={{
                              current: agentControls.current_mode ?? null,
                              modes: agentControls.modes,
                            }}
                            selectedMode={selectedStep.modeOverride}
                            onSelectMode={(modeOverride) =>
                              updateStep(selectedStep.id, (step) =>
                                step.kind === 'agent'
                                  ? { ...step, modeOverride }
                                  : step
                              )
                            }
                            options={agentControls.config_options}
                            pending={Object.fromEntries(
                              Object.entries(
                                selectedStep.configOverrides
                              ).filter(
                                (entry): entry is [string, string] =>
                                  typeof entry[1] === 'string'
                              )
                            )}
                            onSelectConfigOption={(key, value) =>
                              updateStep(selectedStep.id, (step) =>
                                step.kind === 'agent'
                                  ? {
                                      ...step,
                                      configOverrides: {
                                        ...step.configOverrides,
                                        [key]: value,
                                      },
                                    }
                                  : step
                              )
                            }
                            disabled={!onDefinitionChange}
                            dropdownSide="bottom"
                          />
                        ) : (
                          <div className="flex min-h-9 items-center rounded-lg bg-muted/55 px-3 text-xs text-muted-foreground">
                            {agentControlsLoading
                              ? t('studio.sessionConfigurationLoading')
                              : t('studio.sessionConfigurationUnavailable')}
                          </div>
                        )}
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="workflow-prompt">
                          {t('studio.prompt')}
                        </Label>
                        <textarea
                          id="workflow-prompt"
                          className="min-h-32 w-full resize-y rounded-md border bg-background px-3 py-2 text-sm leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-70"
                          value={selectedStep.prompt}
                          disabled={!onDefinitionChange}
                          onChange={(event) =>
                            updateStep(selectedStep.id, (step) => ({
                              ...step,
                              prompt: event.target.value,
                            }))
                          }
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label>{t('studio.afterCompletion')}</Label>
                        <Select
                          value={selectedStep.completionPolicy}
                          disabled={!onDefinitionChange}
                          onValueChange={(
                            completionPolicy: 'automatic' | 'manual'
                          ) =>
                            updateStep(selectedStep.id, (step) => ({
                              ...step,
                              completionPolicy,
                            }))
                          }
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="automatic">
                              {t('studio.continueAutomatically')}
                            </SelectItem>
                            <SelectItem value="manual">
                              {t('studio.requireConfirmation')}
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1.5">
                        <Label
                          htmlFor={
                            outputTab === 'brief'
                              ? 'workflow-output-description'
                              : 'workflow-output-schema'
                          }
                        >
                          {t('studio.outputRequirement')}
                        </Label>
                        <div className="flex shrink-0 items-center rounded-lg bg-muted/65 p-0.5">
                          {(['brief', 'strict'] as const).map((tab) => (
                            <button
                              type="button"
                              key={tab}
                              className={cn(
                                'flex !h-7 flex-1 items-center justify-center gap-1.5 rounded-lg px-2.5 text-xs font-medium',
                                outputTab === tab
                                  ? 'bg-card text-foreground shadow-sm'
                                  : 'text-muted-foreground'
                              )}
                              onClick={() => {
                                setOutputTab(tab);
                                if (!onDefinitionChange) return;
                                if (tab === 'brief') {
                                  updateStep(selectedStep.id, (step) => ({
                                    ...step,
                                    outputSchema: null,
                                  }));
                                  return;
                                }
                                updateStep(selectedStep.id, (step) => ({
                                  ...step,
                                  outputDescription: null,
                                  outputSchema:
                                    step.kind === 'agent' && step.outputSchema
                                      ? step.outputSchema
                                      : DEFAULT_OUTPUT_SCHEMA,
                                }));
                              }}
                            >
                              {tab === 'brief'
                                ? t('studio.outputBrief')
                                : t('studio.outputStrict')}
                            </button>
                          ))}
                        </div>
                        {outputTab === 'brief' ? (
                          <textarea
                            id="workflow-output-description"
                            key={`${selectedStep.id}-description`}
                            defaultValue={selectedStep.outputDescription ?? ''}
                            disabled={!onDefinitionChange}
                            onBlur={(event) =>
                              updateStep(selectedStep.id, (step) => ({
                                ...step,
                                outputDescription: event.target.value.trim()
                                  ? event.target.value.trim()
                                  : null,
                                outputSchema: null,
                              }))
                            }
                            className="min-h-28 w-full resize-y rounded-md border bg-background px-3 py-2 text-sm leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-70"
                          />
                        ) : (
                          <textarea
                            id="workflow-output-schema"
                            key={`${selectedStep.id}-schema`}
                            defaultValue={
                              selectedStep.outputSchema
                                ? JSON.stringify(
                                    selectedStep.outputSchema,
                                    null,
                                    2
                                  )
                                : ''
                            }
                            disabled={!onDefinitionChange}
                            onBlur={(event) =>
                              updateJson(event.target.value, (outputSchema) =>
                                updateStep(selectedStep.id, (step) => ({
                                  ...step,
                                  outputDescription: null,
                                  outputSchema,
                                }))
                              )
                            }
                            className="min-h-28 w-full resize-y rounded-md border bg-background px-3 py-2 font-mono text-[13px] leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-70"
                          />
                        )}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="space-y-1.5">
                        <Label htmlFor="workflow-approval-title">
                          {t('studio.title')}
                        </Label>
                        <Input
                          id="workflow-approval-title"
                          value={selectedStep.title}
                          disabled={!onDefinitionChange}
                          onChange={(event) =>
                            updateStep(selectedStep.id, (step) => ({
                              ...step,
                              title: event.target.value,
                            }))
                          }
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="workflow-approver-scope">
                          {t('studio.approverScope')}
                        </Label>
                        <Input
                          id="workflow-approver-scope"
                          value={selectedStep.approverScope}
                          disabled={!onDefinitionChange}
                          onChange={(event) =>
                            updateStep(selectedStep.id, (step) => ({
                              ...step,
                              approverScope: event.target.value,
                            }))
                          }
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="workflow-decision-schema">
                          {t('studio.decisionSchema')}
                        </Label>
                        <textarea
                          id="workflow-decision-schema"
                          key={`${selectedStep.id}-decision-schema`}
                          defaultValue={JSON.stringify(
                            selectedStep.decisionSchema,
                            null,
                            2
                          )}
                          disabled={!onDefinitionChange}
                          onBlur={(event) =>
                            updateJson(event.target.value, (decisionSchema) => {
                              if (decisionSchema)
                                updateStep(selectedStep.id, (step) => ({
                                  ...step,
                                  decisionSchema,
                                }));
                            })
                          }
                          className="min-h-28 w-full resize-y rounded-md border bg-background px-3 py-2 font-mono text-[11px] leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-70"
                        />
                      </div>
                    </>
                  )}
                  {jsonError ? (
                    <p role="alert" className="text-xs text-destructive">
                      {jsonError}
                    </p>
                  ) : null}
                  {onDefinitionChange ? (
                    <div className="grid grid-cols-2 gap-2 pt-3">
                      <Button
                        variant="outline"
                        disabled={
                          selectedStepSaved ||
                          (selectedStep.kind === 'agent'
                            ? !selectedStep.prompt.trim()
                            : !selectedStep.title.trim())
                        }
                        onClick={() =>
                          setUnsavedStepIds((current) => {
                            const next = new Set(current);
                            next.delete(selectedStep.id);
                            return next;
                          })
                        }
                      >
                        <Check className="mr-1.5 size-3.5" />
                        {t('studio.saveNode')}
                      </Button>
                      {selectedStep.kind === 'agent' ? (
                        <Button
                          disabled={!selectedStepSaved || !onTestNode}
                          onClick={() => {
                            setInspectorTab('conversation');
                            onTestNode?.(selectedStep.id);
                          }}
                        >
                          <CirclePlay className="mr-1.5 size-3.5" />
                          {t('studio.testNode')}
                        </Button>
                      ) : (
                        <span />
                      )}
                    </div>
                  ) : null}
                  {selectedRun?.awaitingAcceptance ? (
                    <Button
                      className="w-full"
                      onClick={() => onAcceptCandidate?.(selectedStep.id)}
                    >
                      <Check className="mr-1.5 size-3.5" />{' '}
                      {t('studio.acceptCandidate')}
                    </Button>
                  ) : null}
                  {selectedStep.kind === 'approval' &&
                  selectedRun?.status === 'waiting_approval' ? (
                    <div className="space-y-2 rounded-lg border border-amber-500/35 bg-amber-500/[0.06] p-3">
                      <Label htmlFor="workflow-approval-decision">
                        {t('studio.decisionJson')}
                      </Label>
                      <textarea
                        id="workflow-approval-decision"
                        value={decisionJson}
                        onChange={(event) =>
                          setDecisionJson(event.target.value)
                        }
                        className="min-h-24 w-full resize-y rounded-md border bg-background px-3 py-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      />
                      {decisionError ? (
                        <p role="alert" className="text-xs text-destructive">
                          {decisionError}
                        </p>
                      ) : null}
                      <Button
                        className="w-full"
                        onClick={() => {
                          try {
                            const decision = JSON.parse(
                              decisionJson
                            ) as JsonValue;
                            setDecisionError(null);
                            void onDecideApproval?.(selectedStep.id, decision);
                          } catch {
                            setDecisionError(t('invalidDecision'));
                          }
                        }}
                      >
                        {t('submitDecision')}
                      </Button>
                    </div>
                  ) : null}
                  {selectedRun?.status === 'needs_review' &&
                  selectedStep.kind === 'agent' ? (
                    <div className="grid grid-cols-3 gap-2 rounded-lg border border-amber-500/35 bg-amber-500/[0.06] p-3">
                      <Button
                        size="sm"
                        onClick={() =>
                          void onReview?.({
                            kind: 'retry',
                            step_id: selectedStep.id,
                          })
                        }
                      >
                        {t('studio.retry')}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          void onReview?.({
                            kind: 'accept',
                            step_id: selectedStep.id,
                            output: null,
                          })
                        }
                      >
                        {t('studio.accept')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!selectedStep.allowSkipOnReview}
                        onClick={() =>
                          void onReview?.({
                            kind: 'skip',
                            step_id: selectedStep.id,
                          })
                        }
                      >
                        {t('studio.skip')}
                      </Button>
                    </div>
                  ) : null}
                  {run &&
                  !onDefinitionChange &&
                  selectedStep.kind === 'agent' ? (
                    <div className="grid grid-cols-2 gap-2">
                      <Button
                        variant="outline"
                        onClick={() => onTestNode?.(selectedStep.id)}
                      >
                        {t('studio.testNode')}
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => onRerunFromNode?.(selectedStep.id)}
                      >
                        {t('studio.rerunDownstream')}
                      </Button>
                    </div>
                  ) : null}
                  {onDefinitionChange ? (
                    <Button
                      variant="destructive"
                      className="w-full"
                      onClick={removeSelected}
                      disabled={definition.steps.length === 1}
                    >
                      <Trash2 className="mr-1.5 size-3.5" />{' '}
                      {t('studio.deleteNode')}
                    </Button>
                  ) : null}
                  {selectedRun?.resolvedInputJson ? (
                    <details className="rounded-lg border bg-muted/20">
                      <summary className="cursor-pointer px-3 py-2 text-xs font-medium">
                        {t('resolvedInput')}
                      </summary>
                      <pre className="max-h-56 overflow-auto border-t p-3 text-[11px] leading-5">
                        {selectedRun.resolvedInputJson}
                      </pre>
                    </details>
                  ) : null}
                  {selectedRun?.outputJson ||
                  selectedRun?.candidateOutputJson ? (
                    <details className="rounded-lg border bg-muted/20" open>
                      <summary className="cursor-pointer px-3 py-2 text-xs font-medium">
                        {selectedRun.awaitingAcceptance
                          ? t('studio.candidateOutput')
                          : t('output')}
                      </summary>
                      <pre className="max-h-56 overflow-auto border-t p-3 text-[11px] leading-5">
                        {selectedRun.candidateOutputJson ??
                          selectedRun.outputJson}
                      </pre>
                    </details>
                  ) : null}
                  {selectedRun?.executionEvidenceJson ? (
                    <details className="rounded-lg border bg-muted/20">
                      <summary className="cursor-pointer px-3 py-2 text-xs font-medium">
                        {t('executionEvidence')}
                      </summary>
                      <pre className="max-h-56 overflow-auto border-t p-3 text-[11px] leading-5">
                        {selectedRun.executionEvidenceJson}
                      </pre>
                    </details>
                  ) : null}
                </div>
              )}
            </div>
            {events.length ? (
              <div className="border-t px-3.5 py-2 text-[10px] text-muted-foreground">
                {t('studio.eventSequence', {
                  count: events.length,
                  sequence: String(events.at(-1)?.sequence ?? 0),
                })}
              </div>
            ) : null}
          </aside>
        ) : null}
      </div>
    </section>
  );
}
