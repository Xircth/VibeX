import { useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  BarChart3,
  ClipboardList,
  KeyRound,
  TerminalSquare,
  Wrench,
} from 'lucide-react';
import DisplayConversationEntry from './DisplayConversationEntry';
import { Markdown } from './Markdown';
import { ThinkingEntry } from './ThinkingEntry';
import {
  ToolCardShell,
  getToolStatusClassName,
  getToolStatusDotClassName,
} from './tools/ToolCardShell';
import type {
  AdaptedContentPart,
  AdaptedToolState,
} from '@/lib/conversation-rendering/adaptContentParts';
import type { WorkspaceWithSession } from '@/types/attempt';
import type { TaskWithAttemptStatus, ToolStatus } from 'shared/types';

type ContentPartsRendererProps = {
  parts: readonly AdaptedContentPart[];
  expansionKey: string;
  executionProcessId?: string;
  taskAttempt?: WorkspaceWithSession;
  task?: TaskWithAttemptStatus;
  workspacePath?: string | null;
};

function statusToToolStatus(state: AdaptedToolState): ToolStatus {
  switch (state) {
    case 'created':
    case 'running':
      return { status: 'created' };
    case 'success':
      return { status: 'success' };
    case 'failed':
      return { status: 'failed' };
    case 'denied':
      return { status: 'denied', reason: null };
    case 'pending_approval':
      return {
        status: 'pending_approval',
        approval_id: '',
        requested_at: '',
        timeout_at: '',
      };
    case 'timed_out':
      return { status: 'timed_out' };
  }
}

function formatUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function ExpandablePartShell({
  icon,
  label,
  detail,
  state,
  children,
}: {
  icon: ReactNode;
  label: string;
  detail?: ReactNode;
  state: AdaptedToolState;
  children?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const status = statusToToolStatus(state);
  return (
    <ToolCardShell
      icon={icon}
      label={label}
      detail={detail}
      statusClassName={getToolStatusClassName(status)}
      statusDotClassName={getToolStatusDotClassName(status)}
      expanded={expanded}
      expandable={Boolean(children)}
      onToggle={() => setExpanded((value) => !value)}
    >
      {children}
    </ToolCardShell>
  );
}

function PartDetails({
  sections,
}: {
  sections: Array<{ label: string; value: ReactNode }>;
}) {
  return (
    <>
      {sections.map((section) => (
        <div key={section.label}>
          <div className="conv-tool-details-section-label">{section.label}</div>
          <div className="conv-tool-details-content">{section.value}</div>
        </div>
      ))}
    </>
  );
}

function RenderPart({
  part,
  expansionKey,
  executionProcessId,
  taskAttempt,
  task,
  workspacePath,
}: {
  part: AdaptedContentPart;
  expansionKey: string;
  executionProcessId?: string;
  taskAttempt?: WorkspaceWithSession;
  task?: TaskWithAttemptStatus;
  workspacePath?: string | null;
}) {
  if ('normalizedEntry' in part && part.normalizedEntry) {
    return (
      <DisplayConversationEntry
        entry={part.normalizedEntry}
        expansionKey={expansionKey}
        executionProcessId={executionProcessId}
        taskAttempt={taskAttempt}
        task={task}
      />
    );
  }

  switch (part.type) {
    case 'text':
      return (
        <div className="conv-entry-item conv-assistant-msg conv-msg-hover group px-4 py-2 text-sm">
          <div className="relative">
            <Markdown
              value={part.text}
              softBreaks={part.softBreaks}
              taskAttemptId={taskAttempt?.id}
              taskId={task?.id ?? taskAttempt?.task_id}
              workspacePath={workspacePath ?? taskAttempt?.container_ref}
            />
          </div>
        </div>
      );
    case 'reasoning':
      return (
        <div className="conv-entry-item">
          <ThinkingEntry
            content={part.content}
            expansionKey={expansionKey}
            taskAttemptId={taskAttempt?.id}
            isStreaming={part.isStreaming}
            elapsedMs={part.elapsedMs}
          />
        </div>
      );
    case 'tool-call':
      return (
        <div className="conv-entry-item px-4 py-1 text-sm">
          <ExpandablePartShell
            icon={<Wrench className="h-3 w-3" />}
            label={part.toolName}
            detail={part.input}
            state={part.state}
          >
            <PartDetails
              sections={[
                ...(part.input ? [{ label: 'Input', value: part.input }] : []),
                ...(part.output
                  ? [{ label: 'Output', value: part.output }]
                  : []),
                ...(part.errorText
                  ? [{ label: 'Error', value: part.errorText }]
                  : []),
                ...(part.meta
                  ? [{ label: 'Meta', value: formatUnknown(part.meta) }]
                  : []),
              ]}
            />
          </ExpandablePartShell>
        </div>
      );
    case 'plan':
      return (
        <div className="conv-entry-item px-4 py-1 text-sm">
          <ExpandablePartShell
            icon={<ClipboardList className="h-3 w-3" />}
            label="Plan"
            detail={`${part.entries.length} items`}
            state={part.isStreaming ? 'running' : 'success'}
          >
            <ol className="list-decimal space-y-1 pl-4">
              {part.entries.map((entry, index) => (
                <li key={`${entry}-${index}`}>{entry}</li>
              ))}
            </ol>
          </ExpandablePartShell>
        </div>
      );
    case 'terminal':
      return (
        <div className="conv-entry-item px-4 py-1 text-sm">
          <ExpandablePartShell
            icon={<TerminalSquare className="h-3 w-3" />}
            label="Terminal"
            detail={part.command ?? part.terminalId}
            state={part.state}
          >
            <PartDetails
              sections={[
                ...(part.command
                  ? [{ label: 'Command', value: part.command }]
                  : []),
                ...(part.output
                  ? [{ label: 'Output', value: part.output }]
                  : []),
                ...(typeof part.exitStatus !== 'undefined'
                  ? [{ label: 'Exit', value: String(part.exitStatus) }]
                  : []),
              ]}
            />
          </ExpandablePartShell>
        </div>
      );
    case 'permission':
      return (
        <div className="conv-entry-item px-4 py-1 text-sm">
          <ToolCardShell
            icon={<KeyRound className="h-3 w-3" />}
            label="Permission"
            detail={part.title}
            statusClassName={
              part.state === 'requested' ? 'conv-tool-card-pending' : ''
            }
            statusDotClassName={
              part.state === 'requested'
                ? 'conv-tool-dot conv-tool-dot-pending'
                : ''
            }
          />
        </div>
      );
    case 'usage':
      return (
        <div className="conv-entry-item px-4 py-1 text-sm">
          <ToolCardShell
            icon={<BarChart3 className="h-3 w-3" />}
            label="Usage"
            detail={`${part.used}${part.limit ? ` / ${part.limit}` : ''}`}
          />
        </div>
      );
    case 'status':
      return (
        <div className="conv-entry-item px-4 py-1 text-sm">
          <ToolCardShell
            label={part.label}
            detail={part.message ?? part.state}
          />
        </div>
      );
    case 'error':
      return (
        <div className="conv-entry-item px-4 py-1 text-sm">
          <ToolCardShell
            icon={<AlertTriangle className="h-3 w-3" />}
            label="Error"
            detail={part.message}
            statusClassName="conv-tool-card-error"
            statusDotClassName="conv-tool-dot conv-tool-dot-error"
          />
        </div>
      );
  }
}

export function ContentPartsRenderer({
  parts,
  expansionKey,
  executionProcessId,
  taskAttempt,
  task,
  workspacePath,
}: ContentPartsRendererProps) {
  return (
    <>
      {parts.map((part) => (
        <RenderPart
          key={part.key}
          part={part}
          expansionKey={`${expansionKey}:${part.key}`}
          executionProcessId={executionProcessId}
          taskAttempt={taskAttempt}
          task={task}
          workspacePath={workspacePath}
        />
      ))}
    </>
  );
}
