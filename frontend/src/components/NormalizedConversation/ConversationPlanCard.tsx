import type { ReactNode } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Circle,
  Clock,
  ListChecks,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { useExpandable } from '@/stores/useExpandableStore';
import {
  formatPlanStepIndex,
  planProgress,
  type ConversationPlanItem,
  type PlanStatus,
} from './conversationPlan';

function StatusIcon({ status }: { status: PlanStatus }) {
  if (status === 'completed') {
    return <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />;
  }
  if (status === 'in_progress') {
    return <Clock className="h-3.5 w-3.5" aria-hidden="true" />;
  }
  return <Circle className="h-3.5 w-3.5" aria-hidden="true" />;
}

export function ConversationPlanCard({
  items,
  expansionKey,
  defaultExpanded = true,
  forceExpanded = false,
  awaitingConfirmation = false,
  isStreaming = false,
  fallback = null,
}: {
  items: ConversationPlanItem[];
  expansionKey: string;
  defaultExpanded?: boolean;
  forceExpanded?: boolean;
  awaitingConfirmation?: boolean;
  isStreaming?: boolean;
  fallback?: ReactNode;
}) {
  const { t } = useTranslation(['conversation', 'common']);
  const [expanded, toggle] = useExpandable(
    `conversation-plan:${expansionKey}`,
    defaultExpanded || awaitingConfirmation
  );
  const effectiveExpanded = forceExpanded || expanded;
  const progress = planProgress(items);

  if (items.length === 0 && !fallback) return null;

  return (
    <section
      className={cn(
        'conv-plan-card',
        effectiveExpanded ? 'is-expanded' : 'is-collapsed',
        awaitingConfirmation && 'is-awaiting'
      )}
      data-testid="conversation-plan-card"
      data-plan-state={
        awaitingConfirmation
          ? 'awaiting'
          : isStreaming
            ? 'updating'
            : progress.completed === progress.total && progress.total > 0
              ? 'complete'
              : 'idle'
      }
    >
      <button
        type="button"
        aria-expanded={effectiveExpanded}
        aria-label={
          effectiveExpanded ? t('planCard.collapse') : t('planCard.expand')
        }
        className="conv-plan-header"
        onClick={() => toggle()}
      >
        <ListChecks className="conv-plan-icon h-3.5 w-3.5 shrink-0" />
        <span className="conv-plan-title">{t('planCard.label')}</span>
        <ChevronRight className="conv-plan-chevron h-3.5 w-3.5 shrink-0" />
      </button>

      {effectiveExpanded ? (
        <div className="conv-plan-body">
          {progress.total > 0 ? (
            <div className="conv-plan-progress">
              <div
                className="conv-plan-progress-track"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={progress.total}
                aria-valuenow={progress.completed}
                aria-label={t('planCard.completedCount', {
                  completed: progress.completed,
                  total: progress.total,
                })}
              >
                {progress.completed > 0 ? (
                  <span
                    className="conv-plan-progress-seg is-done"
                    style={{
                      flexGrow: progress.completed,
                      flexBasis: 0,
                    }}
                  />
                ) : null}
                {progress.inProgress > 0 ? (
                  <span
                    className={cn(
                      'conv-plan-progress-seg is-active',
                      isStreaming && 'is-live'
                    )}
                    style={{
                      flexGrow: progress.inProgress,
                      flexBasis: 0,
                    }}
                  />
                ) : null}
                {progress.pending > 0 ? (
                  <span
                    className="conv-plan-progress-seg is-todo"
                    style={{
                      flexGrow: progress.pending,
                      flexBasis: 0,
                    }}
                  />
                ) : null}
              </div>
              <div className="conv-plan-progress-label">
                {t('planCard.completedCount', {
                  completed: progress.completed,
                  total: progress.total,
                })}
              </div>
            </div>
          ) : null}

          {items.length > 0 ? (
            <ol className="conv-plan-steps">
              {items.map((item, index) => (
                <li
                  key={`${item.status}:${item.content}:${index}`}
                  className={cn('conv-plan-step', `is-${item.status}`)}
                >
                  <span className="conv-plan-index">
                    {formatPlanStepIndex(index)}
                  </span>
                  <span className={cn('conv-plan-status', `is-${item.status}`)}>
                    <StatusIcon status={item.status} />
                    <span className="sr-only">
                      {t(`planCard.status.${item.status}`)}
                    </span>
                  </span>
                  <div className="conv-plan-step-body">
                    <div className="conv-plan-step-title">{item.content}</div>
                    {item.children.length > 0 ? (
                      <ul className="conv-plan-children">
                        {item.children.map((child, childIndex) => (
                          <li
                            key={`${child}:${childIndex}`}
                            className="conv-plan-child"
                          >
                            <Circle className="conv-plan-child-mark h-2 w-2 shrink-0" />
                            <span>{child}</span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <div className="conv-plan-fallback">{fallback}</div>
          )}

          {awaitingConfirmation ? (
            <div className="conv-plan-confirm" role="status">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span>{t('planCard.waitingConfirmation')}</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
