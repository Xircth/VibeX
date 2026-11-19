import { Badge } from '@astryxdesign/core/Badge';
import { ChevronDown, X } from 'lucide-react';
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AsyncTaskRecord,
  ConversationSessionGoal,
  GoalControlReceipt,
} from 'shared/types';
import {
  ConversationStatusDetailsContent,
  ConversationStatusDetailsTrigger,
} from '@/components/NormalizedConversation/conversation/ConversationStatusDetails';
import { SessionAsyncTaskBar } from '@/components/NormalizedConversation/conversation/SessionAsyncTaskBar';
import {
  resolveSessionGoal,
  SessionGoalBar,
} from '@/components/NormalizedConversation/conversation/SessionGoalBar';
import type { ConversationStatusNotice } from '@/contexts/ConversationStatusContext';
import {
  ConversationChildrenRows,
  useConversationChildrenSummary,
} from '@/features/conversation/ConversationChildrenSummary';
import {
  rememberVisibleSessionAnnouncements,
  useConversationStatusDismissal,
} from '@/features/conversation/conversationStatusDismissal';
import { getConversationSessionNoticeCopy } from '@/features/conversation/sessionNoticeCopy';
import { liveAsyncTasks } from '@/lib/asyncTasks';
import type { CodexGoalState } from '@/lib/codexGoalState';
import { isLimitedGoalStatus } from '@/lib/sessionGoal';
import { cn } from '@/lib/utils';
import { MessageQueueIndicator } from './MessageQueueIndicator';
import { SessionNoticeActions } from './SessionNoticeActions';
import type { QueuedMessage } from './sessionComposerQueue';
import type { ComposerSteerChannel } from './sessionComposerSteering';

export type ComposerCockpitTabId =
  | 'queue'
  | 'children'
  | 'asyncTasks'
  | 'goal'
  | 'notice';

export function isPriorityStatusNotice(
  notice: ConversationStatusNotice
): boolean {
  if (notice.kind === 'turn-error' || notice.kind === 'interrupted-turn') {
    return true;
  }
  if (notice.kind === 'session-notice') {
    return Boolean(
      notice.notice.connection_status ||
        notice.notice.request_status ||
        notice.notice.severity === 'error' ||
        notice.onReload ||
        notice.onRebind ||
        notice.onNewConversation
    );
  }
  return false;
}

export function splitConversationStatusNotices(
  notices: ConversationStatusNotice[]
): {
  priorityNotices: ConversationStatusNotice[];
  tabNotices: ConversationStatusNotice[];
} {
  const priorityNotices: ConversationStatusNotice[] = [];
  const tabNotices: ConversationStatusNotice[] = [];
  for (const notice of notices) {
    if (isPriorityStatusNotice(notice)) {
      priorityNotices.push(notice);
    } else {
      tabNotices.push(notice);
    }
  }
  return { priorityNotices, tabNotices };
}

export interface ComposerTabDockProps {
  dismissalScope?: string | null;
  // Message queue
  isQueued?: boolean;
  queuedMessages?: QueuedMessage[];
  delayedMessages?: QueuedMessage[];
  canSteerQueued?: boolean;
  steerChannel?: ComposerSteerChannel | null;
  steeringQueued?: boolean;
  onSteerQueuedMessage?: (message: QueuedMessage) => void;
  onEditQueuedMessage?: (message: QueuedMessage) => void;
  onDeleteQueuedMessage?: (message: QueuedMessage) => void;
  onMoveQueuedMessage?: (message: QueuedMessage, direction: -1 | 1) => void;
  onDelayQueuedMessage?: (message: QueuedMessage, delaySeconds: number) => void;
  // Child sessions
  childrenDock?: {
    conversationId: string;
    onOpenChild?: (conversationId: string, workspaceId?: string) => void;
  } | null;
  // Async background tasks
  asyncTasks?: readonly AsyncTaskRecord[];
  sessionBindReady?: boolean;
  onStopAsyncTask?: (taskId: string) => Promise<boolean>;
  // Session goal
  sessionGoal?: ConversationSessionGoal | null;
  fallbackGoal?: CodexGoalState | null;
  onGoalControl?: (action: 'pause' | 'clear') => Promise<GoalControlReceipt>;
  onSelectGoal?: () => void;
  // Non-blocking session notices
  notices?: ConversationStatusNotice[];
}

interface TabDescriptor {
  id: ComposerCockpitTabId;
  label: string;
  count: string;
  dot: 'live' | 'warn' | 'info' | 'success';
  onDismiss?: () => void;
  renderPanel: () => ReactNode;
}

export function ComposerTabDock({
  dismissalScope = null,
  isQueued,
  queuedMessages = [],
  delayedMessages = [],
  canSteerQueued = false,
  steerChannel = null,
  steeringQueued = false,
  onSteerQueuedMessage,
  onEditQueuedMessage,
  onDeleteQueuedMessage,
  onMoveQueuedMessage,
  onDelayQueuedMessage,
  childrenDock = null,
  asyncTasks = [],
  sessionBindReady = true,
  onStopAsyncTask,
  sessionGoal = null,
  fallbackGoal = null,
  onGoalControl,
  onSelectGoal,
  notices = [],
}: ComposerTabDockProps) {
  const { t } = useTranslation('conversation');
  const dockRef = useRef<HTMLDivElement | null>(null);
  const [activeTab, setActiveTab] = useState<ComposerCockpitTabId | null>(null);
  const [dismissedChildrenKey, setDismissedChildrenKey] = useState<
    string | null
  >(null);
  const [dismissedAsyncTasksKey, setDismissedAsyncTasksKey] = useState<
    string | null
  >(null);
  const [dismissedGoalKey, setDismissedGoalKey] = useState<string | null>(null);

  // 1. Queue
  const hasNormalQueue =
    (isQueued ?? queuedMessages.length > 0) && queuedMessages.length > 0;
  const hasDelayedQueue = delayedMessages.length > 0;
  const hasQueue = hasNormalQueue || hasDelayedQueue;
  const queueTotalCount =
    (hasNormalQueue ? queuedMessages.length : 0) + delayedMessages.length;

  // 2. Child sessions
  const childrenSummary = useConversationChildrenSummary(
    childrenDock?.conversationId
  );
  const childrenScopeKey =
    childrenDock?.conversationId && childrenSummary.signature
      ? `${childrenDock.conversationId}:${childrenSummary.signature}`
      : null;
  const showChildrenTab = Boolean(
    childrenDock &&
      childrenSummary.children.length > 0 &&
      childrenScopeKey !== dismissedChildrenKey
  );

  // 3. Background async tasks
  const liveTasks = useMemo(() => liveAsyncTasks(asyncTasks), [asyncTasks]);
  const asyncTasksKey =
    liveTasks.length > 0
      ? `${dismissalScope ?? ''}::${liveTasks.map((item) => item.id).join('|')}`
      : null;
  const showAsyncTasksTab = Boolean(
    liveTasks.length > 0 && asyncTasksKey !== dismissedAsyncTasksKey
  );

  // 4. Session goal
  const parsedGoal = resolveSessionGoal(
    sessionGoal,
    fallbackGoal,
    sessionBindReady,
    Boolean(onGoalControl)
  );
  const goalKey =
    parsedGoal && parsedGoal.isLiveBarVisible
      ? `${dismissalScope ?? ''}::${parsedGoal.status}::${parsedGoal.objective}`
      : null;
  const showGoalTab = Boolean(
    parsedGoal && parsedGoal.isLiveBarVisible && goalKey !== dismissedGoalKey
  );

  // 5. Non-blocking notices
  const { dismiss: dismissNotice, isDismissed } =
    useConversationStatusDismissal(dismissalScope);
  const visibleNotices = useMemo(
    () => notices.filter((notice) => !isDismissed(notice)),
    [isDismissed, notices]
  );
  useEffect(() => {
    rememberVisibleSessionAnnouncements(dismissalScope, visibleNotices);
  }, [dismissalScope, visibleNotices]);

  const tabs: TabDescriptor[] = [];

  if (hasQueue) {
    tabs.push({
      id: 'queue',
      label: t('statusDock.queueTab'),
      count: String(queueTotalCount),
      dot: hasNormalQueue ? 'warn' : 'info',
      renderPanel: () => (
        <MessageQueueIndicator
          embedded
          isQueued={isQueued}
          queuedMessages={queuedMessages}
          delayedMessages={delayedMessages}
          canSteerQueued={canSteerQueued}
          steerChannel={steerChannel}
          steeringQueued={steeringQueued}
          onSteerQueuedMessage={onSteerQueuedMessage}
          onEditQueuedMessage={onEditQueuedMessage}
          onDeleteQueuedMessage={onDeleteQueuedMessage}
          onMoveQueuedMessage={onMoveQueuedMessage}
          onDelayQueuedMessage={onDelayQueuedMessage}
        />
      ),
    });
  }

  if (showChildrenTab) {
    tabs.push({
      id: 'children',
      label: t('children.tabLabel'),
      count: String(childrenSummary.children.length),
      dot: childrenSummary.activeCount > 0 ? 'live' : 'success',
      onDismiss: () => {
        setDismissedChildrenKey(childrenScopeKey);
        if (activeTab === 'children') {
          setActiveTab(null);
        }
      },
      renderPanel: () => (
        <div data-testid="conversation-children-summary">
          <ConversationChildrenRows
            childrenList={childrenSummary.children}
            activeCount={childrenSummary.activeCount}
            waitingCount={childrenSummary.waitingCount}
            budget={childrenSummary.budget}
            onOpenChild={childrenDock?.onOpenChild}
          />
        </div>
      ),
    });
  }

  if (showAsyncTasksTab) {
    tabs.push({
      id: 'asyncTasks',
      label: t('statusDock.asyncTasksTab'),
      count: String(liveTasks.length),
      dot: 'live',
      onDismiss: () => {
        setDismissedAsyncTasksKey(asyncTasksKey);
        if (activeTab === 'asyncTasks') {
          setActiveTab(null);
        }
      },
      renderPanel: () => (
        <SessionAsyncTaskBar
          embedded
          tasks={liveTasks}
          sessionBindReady={sessionBindReady}
          onStopTask={onStopAsyncTask}
        />
      ),
    });
  }

  if (showGoalTab && parsedGoal) {
    const goalStatusLabel =
      parsedGoal.status === 'active'
        ? t('sessionGoal.status.active')
        : parsedGoal.status === 'paused'
          ? t('sessionGoal.status.paused')
          : parsedGoal.status === 'completed'
            ? t('sessionGoal.status.completed')
            : isLimitedGoalStatus(parsedGoal.status)
              ? t('sessionGoal.status.limited')
              : t('sessionGoal.status.failed');
    tabs.push({
      id: 'goal',
      label: t('statusDock.goalTab'),
      count: goalStatusLabel,
      dot:
        parsedGoal.status === 'active'
          ? 'live'
          : parsedGoal.status === 'paused'
            ? 'warn'
            : 'info',
      onDismiss: () => {
        setDismissedGoalKey(goalKey);
        if (activeTab === 'goal') {
          setActiveTab(null);
        }
      },
      renderPanel: () => (
        <SessionGoalBar
          embedded
          sessionGoal={sessionGoal}
          fallbackGoal={fallbackGoal}
          sessionBindReady={sessionBindReady}
          onGoalControl={onGoalControl}
          onSelectGoal={onSelectGoal}
        />
      ),
    });
  }

  if (visibleNotices.length > 0) {
    const hasWarningNotice = visibleNotices.some(
      (item) =>
        item.kind === 'session-notice' && item.notice.severity === 'warning'
    );
    tabs.push({
      id: 'notice',
      label: t('statusDock.noticeTab'),
      count: String(visibleNotices.length),
      dot: hasWarningNotice ? 'warn' : 'info',
      onDismiss: () => {
        visibleNotices.forEach((notice) => dismissNotice(notice));
        if (activeTab === 'notice') {
          setActiveTab(null);
        }
      },
      renderPanel: () => (
        <div className="composer-cockpit-notice-list">
          {visibleNotices.map((notice) => {
            if (notice.kind !== 'session-notice') return null;
            const copy = getConversationSessionNoticeCopy(notice.notice, t);
            return (
              <ComposerCockpitNoticeRow
                key={`${notice.id}:${copy.message ?? ''}`}
                notice={notice}
                title={copy.title}
                message={copy.message}
                onDismiss={() => dismissNotice(notice)}
              />
            );
          })}
        </div>
      ),
    });
  }

  // Collapse automatically if the currently active tab disappears.
  const resolvedActiveTab = tabs.find((tab) => tab.id === activeTab) ?? null;
  const isPanelOpen = resolvedActiveTab !== null;
  useEffect(() => {
    if (activeTab && !isPanelOpen) {
      setActiveTab(null);
    }
  }, [activeTab, isPanelOpen]);

  // Collapse when clicking outside the dock card without shifting layout before the click completes.
  useEffect(() => {
    if (!isPanelOpen) return;

    let pointerStartedInside = false;

    const isTargetInsideDock = (target: EventTarget | null) =>
      target instanceof Node && Boolean(dockRef.current?.contains(target));

    const handlePointerDown = (event: PointerEvent) => {
      pointerStartedInside = isTargetInsideDock(event.target);
    };

    const handleClick = (event: MouseEvent) => {
      const startedInside = pointerStartedInside;
      pointerStartedInside = false;
      if (startedInside || isTargetInsideDock(event.target)) {
        return;
      }
      setActiveTab(null);
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('click', handleClick, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('click', handleClick, true);
    };
  }, [isPanelOpen]);

  if (tabs.length === 0) {
    return null;
  }

  return (
    <div
      ref={dockRef}
      className="composer-cockpit-dock"
      data-testid="composer-tab-dock"
      role="region"
      aria-label={t('statusDock.regionLabel')}
    >
      <div
        className="composer-cockpit-tabbar"
        role="tablist"
        aria-orientation="horizontal"
        aria-label={t('statusDock.regionLabel')}
      >
        <div className="composer-cockpit-tabs">
          {tabs.map((tab) => {
            const isActive = resolvedActiveTab?.id === tab.id;
            return (
              <div
                key={tab.id}
                className={cn(
                  'composer-cockpit-tab-wrap',
                  isActive && 'is-active'
                )}
                data-active={isActive ? 'true' : undefined}
                data-tab-id={tab.id}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  aria-controls={
                    isActive ? `composer-cockpit-panel-${tab.id}` : undefined
                  }
                  className="composer-cockpit-tab"
                  onClick={() =>
                    setActiveTab((prev) => (prev === tab.id ? null : tab.id))
                  }
                >
                  <span
                    className={cn('composer-cockpit-dot', `is-${tab.dot}`)}
                    aria-hidden="true"
                  />
                  <span>{tab.label}</span>
                  <span className="composer-cockpit-count tabular-nums">
                    {tab.count}
                  </span>
                </button>
                {tab.onDismiss ? (
                  <button
                    type="button"
                    className="composer-cockpit-tab-x"
                    onClick={(event) => {
                      event.stopPropagation();
                      tab.onDismiss?.();
                    }}
                    title={t('statusDock.dismissTab', { label: tab.label })}
                    aria-label={t('statusDock.dismissTab', {
                      label: tab.label,
                    })}
                    data-testid={`composer-tab-dismiss-${tab.id}`}
                  >
                    <X className="h-3 w-3" aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
        {resolvedActiveTab ? (
          <button
            type="button"
            className="composer-cockpit-collapse"
            onClick={() => setActiveTab(null)}
            data-testid="composer-tab-collapse"
          >
            <span>{t('statusDock.collapsePanel')}</span>
            <ChevronDown className="h-3 w-3" aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {resolvedActiveTab ? (
        <div
          id={`composer-cockpit-panel-${resolvedActiveTab.id}`}
          role="tabpanel"
          data-testid={`composer-tab-panel-${resolvedActiveTab.id}`}
          className="composer-cockpit-panel"
        >
          {resolvedActiveTab.renderPanel()}
        </div>
      ) : null}
    </div>
  );
}

function ComposerCockpitNoticeRow({
  notice,
  title,
  message,
  onDismiss,
}: {
  notice: Extract<ConversationStatusNotice, { kind: 'session-notice' }>;
  title: string;
  message: string | null;
  onDismiss: () => void;
}) {
  const { t } = useTranslation('conversation');
  const detailsId = useId();
  const [expanded, setExpanded] = useState(false);
  const tone = notice.notice.severity === 'warning' ? 'warning' : 'info';

  return (
    <div
      className="composer-cockpit-row flex-col items-stretch gap-1.5"
      data-tone={tone}
      role="status"
    >
      <div className="flex min-w-0 items-center gap-2">
        <Badge
          className="composer-status-badge shrink-0"
          variant={tone}
          label={t(`statusDock.${tone}Badge`)}
        />
        <span className="composer-cockpit-notice-title min-w-0 flex-1 truncate text-[13px] font-medium leading-5 text-foreground">
          {title}
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          {notice.notice.action ? (
            <SessionNoticeActions action={notice.notice.action} />
          ) : null}
          {message ? (
            <ConversationStatusDetailsTrigger
              title={title}
              label={t('statusDock.showDetails')}
              accessibleLabel={t('statusDock.showDetailsFor', { title })}
              expanded={expanded}
              controlsId={detailsId}
              onToggle={() => setExpanded((current) => !current)}
            />
          ) : null}
          <button
            type="button"
            className="composer-cockpit-mini-x"
            onClick={onDismiss}
            title={t('statusDock.dismiss')}
            aria-label={t('statusDock.dismiss')}
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>
      {message && expanded ? (
        <ConversationStatusDetailsContent id={detailsId} mono={tone !== 'info'}>
          <p className="whitespace-pre-wrap break-words">{message}</p>
        </ConversationStatusDetailsContent>
      ) : null}
    </div>
  );
}
