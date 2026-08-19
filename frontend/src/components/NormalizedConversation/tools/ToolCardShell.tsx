import {
  createContext,
  useContext,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  ChatToolCalls,
  type ChatToolCallStatus,
} from '@astryxdesign/core/Chat';
import type { ToolStatus } from 'shared/types';
import { cn } from '@/lib/utils';
import { ToolCallTarget } from './ToolCallTarget';

type ToolCardShellProps = {
  icon?: ReactNode;
  label: string;
  detail?: ReactNode;
  actions?: ReactNode;
  statusClassName?: string;
  statusDotClassName?: string;
  status?: ToolStatus | null;
  chatStatus?: ChatToolCallStatus;
  expanded?: boolean;
  expandable?: boolean;
  onToggle?: () => void;
  children?: ReactNode;
};

const ToolCallResultDetailContext = createContext(false);

export function ToolCallResultDetail({ children }: { children: ReactNode }) {
  return (
    <ToolCallResultDetailContext.Provider value>
      {children}
    </ToolCallResultDetailContext.Provider>
  );
}

export function useToolCallResultDetail() {
  return useContext(ToolCallResultDetailContext);
}

export function getToolStatusClassName(status?: ToolStatus | null): string {
  if (!status) return '';

  if (
    status.status === 'failed' ||
    status.status === 'denied' ||
    status.status === 'timed_out'
  ) {
    return 'conv-tool-card-error';
  }

  if (status.status === 'created' || status.status === 'pending_approval') {
    return 'conv-tool-card-pending';
  }

  return '';
}

export function getToolStatusDotClassName(status?: ToolStatus | null): string {
  if (!status) return '';

  if (
    status.status === 'failed' ||
    status.status === 'denied' ||
    status.status === 'timed_out'
  ) {
    return 'conv-tool-dot conv-tool-dot-error';
  }

  if (status.status === 'created' || status.status === 'pending_approval') {
    return 'conv-tool-dot conv-tool-dot-pending';
  }

  return '';
}

function statusClassNameToChatStatus(
  statusClassName?: string
): ChatToolCallStatus {
  if (statusClassName?.includes('conv-tool-card-error')) return 'error';
  if (statusClassName?.includes('conv-tool-card-pending')) return 'pending';
  return 'complete';
}

export function getToolChatStatus(
  status?: ToolStatus | null
): ChatToolCallStatus {
  if (!status) return 'complete';
  switch (status.status) {
    case 'created':
      return 'running';
    case 'pending_approval':
      return 'pending';
    case 'failed':
    case 'denied':
    case 'timed_out':
      return 'error';
    case 'success':
      return 'complete';
  }
}

function handleRowKeyDown(
  event: KeyboardEvent<HTMLDivElement>,
  onToggle?: () => void
) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    onToggle?.();
  }
}

/**
 * Tool card shell rendered through Astryx ChatToolCalls.
 *
 * Card components keep passing their existing props. The shell renders a
 * single ChatToolCallItem row (label → name, string detail → target, domain
 * ToolStatus → ChatToolCallStatus) through ChatToolCalls, keeps actions visible
 * next to the row, and drives expansion under its own controlled `expanded`
 * state — ChatToolCalls row expansion is internal and cannot honor the
 * approval-forced expansion (`forceExpanded`) approval flows depend on.
 */
export function ToolCardShell({
  label,
  detail,
  actions,
  statusClassName,
  statusDotClassName,
  status,
  chatStatus,
  expanded = false,
  expandable = false,
  onToggle,
  children,
}: ToolCardShellProps) {
  const isResultDetail = useContext(ToolCallResultDetailContext);
  const stringDetail =
    typeof detail === 'string' || typeof detail === 'number'
      ? String(detail)
      : undefined;
  const detailNode =
    stringDetail != null ? (
      <ToolCallTarget text={stringDetail} />
    ) : detail ? (
      detail
    ) : undefined;
  const effectiveChatStatus =
    chatStatus ??
    (status
      ? getToolChatStatus(status)
      : statusClassNameToChatStatus(statusClassName));

  if (isResultDetail) {
    return (
      <div className="vibex-tool-call-result-detail">
        {actions ? (
          <div className="conv-tool-artifact-actions">{actions}</div>
        ) : null}
        {children}
      </div>
    );
  }

  return (
    <div
      className={cn('w-full', statusClassName, statusDotClassName)}
      data-tool-status={effectiveChatStatus}
      aria-busy={
        effectiveChatStatus === 'running' || effectiveChatStatus === 'pending'
      }
    >
      <div className="flex items-center">
        <div
          role={expandable ? 'button' : undefined}
          tabIndex={expandable ? 0 : undefined}
          aria-expanded={expandable ? expanded : undefined}
          aria-label={
            expandable
              ? [label, stringDetail].filter(Boolean).join(' ')
              : undefined
          }
          onClick={expandable ? () => onToggle?.() : undefined}
          onKeyDown={
            expandable
              ? (event) => handleRowKeyDown(event, onToggle)
              : undefined
          }
          className={cn('min-w-0 flex-1', expandable ? 'cursor-pointer' : '')}
        >
          <ChatToolCalls
            calls={[
              {
                name: label,
                status: effectiveChatStatus,
                stats: detailNode,
              },
            ]}
          />
        </div>
        {actions ? (
          <div className="flex shrink-0 items-center gap-1 pl-1">{actions}</div>
        ) : null}
      </div>
      {(expanded || !expandable) && children ? (
        <div className="conv-tool-artifact-host">{children}</div>
      ) : null}
    </div>
  );
}
