import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  Check,
  ChevronDown,
  Clipboard,
  Loader2,
  Pencil,
  RotateCcw,
  Wrench,
} from 'lucide-react';
import {
  type ConversationDelegationView,
  type MessageTurn,
  type TaskWithAttemptStatus,
} from 'shared/types';
import { ChatMessage, ChatMessageBubble } from '@astryxdesign/core/Chat';
import type { WorkspaceWithSession } from '@/types/attempt';
import { cn } from '@/lib/utils';
import { useTemporaryFlag } from '@/hooks/useTemporaryFlag';
import { writeClipboardViaBridge } from '@/vscode/bridge';
import { useExpandable } from '@/stores/useExpandableStore';
import { useOptionalUserSystem } from '@/components/ConfigProvider';
import {
  DEFAULT_COLLAPSE_PREFERENCES,
  resolveHideModelThinking,
} from '@/lib/conversationCollapsePreferences';
import { AstryxMarkdown } from './AstryxMarkdown';
import { UserMessageMarkdown } from './UserMessageMarkdown';
import { ThinkingEntry } from './ThinkingEntry';
import { ToolCardShell } from './tools/ToolCardShell';
import { ConversationPlanCard } from './ConversationPlanCard';
import { toConversationPlanItem } from './conversationPlan';
import { GeneratedImageCard } from './conversation/GeneratedImageCard';
import DisplayConversationEntry from './DisplayConversationEntry';
import { toolBlockToNormalizedEntry } from './messageTurnTool';
import {
  planTurnBlocks,
  type ToolResultBlock,
  type TurnRenderItem,
} from './messageTurnBlocks';
import { splitAssistantCommandOutput } from './conversation-entry-utils';
import {
  AssistantCommandOutputEntry,
  ContextCompactStatusEntry,
} from './MessageCard';
import type { ContextCompactStatusKind } from '@/lib/contextCompact';
import { groupTurnRenderItems } from './messageTurnAggregate';
import { collectHostDelegationPollResults } from './conversation/hostDelegation';
import { TurnToolCalls } from './TurnToolCalls';
import {
  STREAMING_ACTIVITY_INTERVAL_MS,
  STREAMING_ACTIVITY_VERBS,
  nextStreamingActivityVerb,
  shouldShowAssistantStreamingStatus,
} from './assistantStreamingActivity';

export interface MessageTurnContext {
  taskAttemptId?: string;
  taskId?: string;
  workspacePath?: string | null;
}

export interface ContextCompactPresentation {
  status: ContextCompactStatusKind;
  durationMs: number | null;
  contextTokens: number | null;
}

type MessageTurnPhase =
  | 'persisted'
  | 'optimistic'
  | 'streaming'
  | 'settled'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

function OrphanToolResultCard({
  result,
  context,
}: {
  result: ToolResultBlock | null;
  context: MessageTurnContext;
}) {
  const [expanded, setExpanded] = useState(false);
  const output = result?.output_preview ?? null;
  const isError = result?.is_error ?? false;
  return (
    <ToolCardShell
      icon={<Wrench className="h-3.5 w-3.5" />}
      label="tool result"
      statusClassName={isError ? 'conv-tool-card-error' : ''}
      statusDotClassName={isError ? 'conv-tool-dot conv-tool-dot-error' : ''}
      chatStatus={isError ? 'error' : 'complete'}
      expandable={Boolean(output)}
      expanded={expanded}
      onToggle={() => setExpanded((value) => !value)}
    >
      {output ? (
        <AstryxMarkdown
          value={output}
          taskAttemptId={context.taskAttemptId}
          taskId={context.taskId}
          workspacePath={context.workspacePath}
        />
      ) : null}
    </ToolCardShell>
  );
}

function renderItem(
  item: TurnRenderItem,
  key: string,
  context: MessageTurnContext,
  isStreaming: boolean
): ReactNode {
  switch (item.kind) {
    case 'markdown':
      return (
        <AstryxMarkdown
          key={key}
          value={item.text}
          taskAttemptId={context.taskAttemptId}
          taskId={context.taskId}
          workspacePath={context.workspacePath}
          isStreaming={isStreaming}
        />
      );
    case 'thinking':
      return (
        <ThinkingEntry
          key={key}
          content={item.text}
          expansionKey={key}
          taskAttemptId={context.taskAttemptId}
        />
      );
    case 'image':
      return (
        <img
          key={key}
          className="conv-image"
          src={item.uri ?? `data:${item.mimeType};base64,${item.data}`}
          alt=""
        />
      );
    case 'image_generation':
      return (
        <GeneratedImageCard
          key={key}
          image={item.image}
          revisedPrompt={item.revisedPrompt}
        />
      );
    case 'plan':
      return (
        <ConversationPlanCard
          key={key}
          items={item.entries.map(toConversationPlanItem)}
          expansionKey={key}
        />
      );
    case 'resource':
      return (
        <div
          key={key}
          className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
        >
          <div className="font-medium text-foreground">
            {item.title ?? item.uri}
          </div>
          {item.title ? <div className="mt-1 break-all">{item.uri}</div> : null}
        </div>
      );
    case 'protocol':
      return (
        <div
          key={key}
          className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
        >
          {item.label}
        </div>
      );
    case 'tool':
      return (
        <OrphanToolResultCard
          key={key}
          result={item.result}
          context={context}
        />
      );
  }
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function AssistantStreamingStatus({ hasContent }: { hasContent: boolean }) {
  const { t } = useTranslation(['conversation', 'common']);
  const statusLabel = t('messageTurnView.streamingStatus');
  const [verb, setVerb] = useState(() =>
    nextStreamingActivityVerb(STREAMING_ACTIVITY_VERBS)
  );

  useEffect(() => {
    if (prefersReducedMotion()) return;
    const timer = window.setInterval(() => {
      setVerb((current) =>
        nextStreamingActivityVerb(STREAMING_ACTIVITY_VERBS, current)
      );
    }, STREAMING_ACTIVITY_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div
      className={cn(
        'conv-thinking-placeholder',
        hasContent && 'conv-streaming-status-tail'
      )}
      role="status"
      aria-live="polite"
      aria-label={statusLabel}
    >
      <span className="conv-spinner" aria-hidden="true" />
      <span className="conv-shimmer-text">{`${verb}…`}</span>
    </div>
  );
}

/**
 * Hover-revealed action rail anchored to the left of a user bubble. Copy is
 * always available (client-side); Retry re-sends this turn, optionally
 * restoring workspace files first. Mirrors the pre-ACP user-message controls.
 */
function UserMessageActions({
  text,
  onRetry,
  onEdit,
}: {
  text: string;
  onRetry?: () => void;
  onEdit?: () => void;
}) {
  const { t } = useTranslation(['conversation', 'common']);
  const [copied, triggerCopied] = useTemporaryFlag(1600);

  const handleCopy = useCallback(async () => {
    if (!text) return;
    try {
      await writeClipboardViaBridge(text);
      triggerCopied();
    } catch {
      // Clipboard can be unavailable in embedded webviews — ignore.
    }
  }, [text, triggerCopied]);

  if (!text && !onRetry && !onEdit) return null;

  return (
    <div className="conv-user-actions">
      {text ? (
        <button
          type="button"
          onClick={handleCopy}
          className="conv-user-action-btn"
          title={
            copied
              ? t('messageTurnView.copied')
              : t('messageTurnView.copyMessage')
          }
          aria-label={
            copied
              ? t('messageTurnView.copied')
              : t('messageTurnView.copyMessage')
          }
        >
          {copied ? (
            <Check className="h-3.5 w-3.5" />
          ) : (
            <Clipboard className="h-3.5 w-3.5" />
          )}
        </button>
      ) : null}
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="conv-user-action-btn"
          title={t('messageTurnView.resendHint')}
          aria-label={t('messageTurnView.resend')}
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
      ) : null}
      {onEdit ? (
        <button
          type="button"
          onClick={onEdit}
          className="conv-user-action-btn"
          title={t('messageTurnView.edit')}
          aria-label={t('messageTurnView.edit')}
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}

function UserMessageEditor({
  initialText,
  onCancel,
  onSubmit,
}: {
  initialText: string;
  onCancel: () => void;
  onSubmit: (text: string) => Promise<boolean>;
}) {
  const { t } = useTranslation(['conversation', 'common']);
  const [text, setText] = useState(initialText);
  const [submitting, setSubmitting] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);

  const resizeEditor = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.style.height = '0px';
    editor.style.height = `${Math.max(88, editor.scrollHeight)}px`;
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
    resizeEditor();
  }, [resizeEditor]);

  const handleSubmit = async () => {
    const next = text.trim();
    if (!next || submitting) return;
    setSubmitting(true);
    try {
      if (await onSubmit(next)) onCancel();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="conv-user-edit-panel">
      <textarea
        ref={editorRef}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          window.requestAnimationFrame(resizeEditor);
        }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault();
            void handleSubmit();
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
        disabled={submitting}
        aria-label={t('messageTurnView.editInput')}
      />
      <div className="conv-user-edit-actions">
        <button type="button" onClick={onCancel} disabled={submitting}>
          {t('common:cancel')}
        </button>
        <button
          type="button"
          className="is-primary"
          onClick={() => void handleSubmit()}
          disabled={!text.trim() || submitting}
        >
          {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {t('messageTurnView.sendEdited')}
        </button>
      </div>
    </div>
  );
}

/**
 * Terminal "因重启中断" (interrupted-by-restart) treatment for a turn the host
 * crashed mid-flight (ADR-0001). Rendered on the turn's user row (always present,
 * and carrying the prompt the resend re-sends). The resend is strictly
 * click-driven — never automatic — because the interrupted agent may already have
 * produced side effects only the user can judge.
 */
function InterruptedTurnNotice({ onResend }: { onResend?: () => void }) {
  const { t } = useTranslation(['conversation', 'common']);
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      <span className="font-medium text-foreground">
        {t('messageTurnView.interruptedTitle')}
      </span>
      <span>{t('messageTurnView.interruptedDescription')}</span>
      {onResend ? (
        <button
          type="button"
          onClick={onResend}
          className="raised-control ml-auto inline-flex items-center gap-1 px-2 py-0.5 font-medium"
          title={t('messageTurnView.resendHint')}
          aria-label={t('messageTurnView.resend')}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          {t('messageTurnView.resend')}
        </button>
      ) : null}
    </div>
  );
}

function CollapsedProcessGroup({
  turnId,
  items,
  renderUnits,
}: {
  turnId: string;
  items: TurnRenderItem[];
  renderUnits: (list: TurnRenderItem[], offset: number) => ReactNode[];
}) {
  const { t } = useTranslation(['conversation', 'common']);
  const [expanded, toggle] = useExpandable(`process:${turnId}`, false);
  return (
    <div className="conv-collapsed-process px-1 py-1">
      <button
        type="button"
        onClick={() => toggle()}
        className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"
        aria-expanded={expanded}
      >
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 transition-transform',
            expanded ? '' : '-rotate-90'
          )}
        />
        <span>
          {t('messageTurnView.collapsedMessages', { count: items.length })}
        </span>
      </button>
      {expanded ? (
        <div className="conv-assistant-body mt-1">{renderUnits(items, 0)}</div>
      ) : null}
    </div>
  );
}

export const MessageTurnView = memo(function MessageTurnView({
  turn,
  phase = 'persisted',
  attempt,
  task,
  onRetry,
  onEditRetry,
  collapseProcess = DEFAULT_COLLAPSE_PREFERENCES.aiMessagesCollapsed,
  workspacePath,
  showInterruptedNotice = true,
  contextCompact,
  hasTurnError = false,
  delegations = [],
  onOpenChild,
}: {
  turn: MessageTurn;
  phase?: MessageTurnPhase;
  attempt: WorkspaceWithSession;
  task: TaskWithAttemptStatus | null;
  onRetry?: () => void;
  onEditRetry?: (text: string) => Promise<boolean>;
  collapseProcess?: boolean;
  workspacePath?: string | null;
  showInterruptedNotice?: boolean;
  contextCompact?: ContextCompactPresentation | null;
  hasTurnError?: boolean;
  delegations?: ConversationDelegationView[];
  onOpenChild?: (childConversationId: string) => void;
}) {
  const { t } = useTranslation(['conversation', 'common', 'app']);
  const { config } = useOptionalUserSystem() ?? {};
  const hideThinking = resolveHideModelThinking(config);
  const [editing, setEditing] = useState(false);
  // Prefer the resolved absolute root (caller may supply the repo path when the
  // workspace has no container_ref) so clickable file paths open a real file.
  const resolvedWorkspacePath = workspacePath ?? attempt.container_ref;
  const context = useMemo<MessageTurnContext>(
    () => ({
      taskAttemptId: attempt.id,
      taskId: task?.id ?? attempt.task_id ?? undefined,
      workspacePath: resolvedWorkspacePath,
    }),
    [resolvedWorkspacePath, attempt.id, attempt.task_id, task?.id]
  );

  if (turn.role === 'user') {
    const text = turn.blocks
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n\n');
    if (editing && onEditRetry) {
      return (
        <div className="conv-entry-item conv-user-turn conv-user-turn-editing">
          <UserMessageEditor
            initialText={text}
            onCancel={() => setEditing(false)}
            onSubmit={onEditRetry}
          />
        </div>
      );
    }
    return (
      <div className="conv-entry-item conv-user-turn group">
        <div className="conv-user-bubble-wrap">
          <UserMessageActions
            text={text}
            onRetry={onRetry}
            onEdit={onEditRetry ? () => setEditing(true) : undefined}
          />
          <ChatMessage
            sender="user"
            density="compact"
            className="vibex-user-message"
          >
            <ChatMessageBubble
              className="conv-user-bubble"
              data-testid="user-message-bubble"
            >
              <UserMessageMarkdown
                value={text}
                workspacePath={resolvedWorkspacePath}
              />
            </ChatMessageBubble>
          </ChatMessage>
        </div>
        {phase === 'interrupted' && showInterruptedNotice ? (
          <InterruptedTurnNotice onResend={onRetry} />
        ) : null}
      </div>
    );
  }

  if (contextCompact) {
    return (
      <div className="conv-entry-item px-4 py-2">
        <ContextCompactStatusEntry
          content={t(`app:contextCompact.${contextCompact.status}`)}
          status={contextCompact.status}
          durationMs={contextCompact.durationMs}
          contextTokens={contextCompact.contextTokens}
        />
      </div>
    );
  }

  const renderTurnItem = (
    item: TurnRenderItem,
    key: string,
    hideToolLabel = false
  ): ReactNode => {
    if (item.kind === 'markdown' && collapseProcess) {
      const commandOutput = splitAssistantCommandOutput(item.text);
      if (commandOutput) {
        return (
          <AssistantCommandOutputEntry
            key={key}
            prefix={commandOutput.prefix}
            output={commandOutput.output}
            expansionKey={key}
            markdownContext={context}
          />
        );
      }
    }
    if (item.kind === 'tool' && item.use) {
      return (
        <DisplayConversationEntry
          key={key}
          entry={toolBlockToNormalizedEntry(
            item.use,
            item.result,
            turn.timestamp
          )}
          expansionKey={key}
          taskAttempt={attempt}
          task={task ?? undefined}
          hideToolLabel={hideToolLabel}
        />
      );
    }
    return renderItem(item, key, context, phase === 'streaming');
  };

  // Every uninterrupted run uses Astryx's aggregate, including runs of one.
  const renderUnits = (list: TurnRenderItem[], offset: number): ReactNode[] => {
    const pollResults = collectHostDelegationPollResults(list);
    return groupTurnRenderItems(list).map((unit) => {
      if (unit.kind === 'single') {
        return renderTurnItem(unit.item, `${turn.id}-${offset + unit.index}`);
      }
      const startIndex = offset + unit.items[0].index;
      return (
        <TurnToolCalls
          key={`${turn.id}-toolgroup-${startIndex}`}
          turnId={turn.id}
          timestamp={turn.timestamp}
          offset={offset}
          items={unit.items}
          attempt={attempt}
          task={task}
          workspacePath={resolvedWorkspacePath}
          delegations={delegations}
          pollResults={pollResults}
          onOpenChild={onOpenChild}
        />
      );
    });
  };

  const plannedItems = planTurnBlocks(turn.blocks);
  const items = hideThinking
    ? plannedItems.filter((item) => item.kind !== 'thinking')
    : plannedItems;
  const showStreamingStatus = shouldShowAssistantStreamingStatus({
    phase,
    hasTurnError,
  });
  if (showStreamingStatus && items.length === 0) {
    return (
      <div className="conv-entry-item conv-assistant-msg conv-msg-hover group px-4 py-2 text-sm">
        <AssistantStreamingStatus hasContent={false} />
      </div>
    );
  }

  let body: ReactNode[];

  if (collapseProcess) {
    const lastTextIndex = items.reduce(
      (acc, item, index) => (item.kind === 'markdown' ? index : acc),
      -1
    );
    const collapsibleEnd = lastTextIndex >= 0 ? lastTextIndex : items.length;
    const prelude = items.slice(0, collapsibleEnd);
    const rest = items.slice(collapsibleEnd);
    body = [
      ...(prelude.length > 0
        ? [
            <CollapsedProcessGroup
              key={`${turn.id}-collapsed`}
              turnId={turn.id}
              items={prelude}
              renderUnits={renderUnits}
            />,
          ]
        : []),
      ...renderUnits(rest, collapsibleEnd),
    ];
  } else {
    body = renderUnits(items, 0);
  }

  return (
    <div className="conv-entry-item conv-assistant-msg conv-msg-hover group px-4 py-2 text-sm">
      <div className="conv-assistant-body">
        {body}
        {showStreamingStatus ? (
          <AssistantStreamingStatus hasContent={items.length > 0} />
        ) : null}
      </div>
    </div>
  );
});
