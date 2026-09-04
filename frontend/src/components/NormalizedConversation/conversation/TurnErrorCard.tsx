import { useState } from 'react';
import { Badge } from '@astryxdesign/core/Badge';
import { Ban, RefreshCw, ShieldAlert, TriangleAlert, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type {
  AgentPlanUsage,
  ConversationError,
  ConversationTurnErrorKind,
} from 'shared/types';
import { describeReset } from '@/components/kanban/planUsageFormat';
import { Button } from '@/components/ui/button';
import { ConversationStatusDetails } from './ConversationStatusDetails';
import { cn } from '@/lib/utils';

/**
 * Turn-failure surface, keyed on the agent's *real* ACP error code so each
 * failure reads as what it actually is — an expired session, an auth prompt, a
 * user cancellation, or a generic error — and offers the matching recovery
 * instead of a single flat "something went wrong" banner. Codes come straight
 * from `ConversationError.code` (mapped from the ACP/JSON-RPC error); nothing is
 * inferred from message text.
 */
export function TurnErrorCard({
  error,
  onReload,
  onRebind,
  onDismiss,
  dismissLabel,
  placement = 'timeline',
}: {
  error: ConversationError;
  onReload?: () => void | Promise<unknown>;
  onRebind?: () => void | Promise<unknown>;
  onDismiss?: () => void;
  dismissLabel?: string;
  placement?: 'timeline' | 'composer';
}) {
  const { t } = useTranslation(['conversation', 'common']);
  const [reloading, setReloading] = useState(false);
  const view = describeError(error, t);
  const showRebind = view.tone === 'error' && view.canRebind && onRebind;
  const showReload =
    view.tone === 'error' && !showRebind && view.canReload && onReload;

  const handleReload = () => {
    const action = showRebind ? onRebind : onReload;
    if (!action) return;
    setReloading(true);
    void Promise.resolve(action()).finally(() => setReloading(false));
  };

  if (placement === 'composer') {
    return (
      <div
        role={view.tone === 'error' ? 'alert' : 'status'}
        data-tone={view.tone}
        className="composer-status-row text-xs text-foreground"
      >
        <div className="composer-status-header">
          <div className="composer-status-heading">
            <div className="composer-status-title">{view.title}</div>
            <Badge
              className="composer-status-badge"
              variant={view.tone === 'error' ? 'error' : 'neutral'}
              label={
                view.tone === 'error'
                  ? t('statusDock.errorBadge')
                  : t('statusDock.infoBadge')
              }
            />
          </div>
          {showRebind || showReload || onDismiss ? (
            <div className="composer-status-action-slot">
              {showRebind || showReload ? (
                <button
                  type="button"
                  className="composer-status-action"
                  disabled={reloading}
                  onClick={handleReload}
                >
                  <RefreshCw
                    className={cn('h-3.5 w-3.5', reloading && 'animate-spin')}
                  />
                  {showRebind
                    ? t('turnErrorCard.rebindSession')
                    : t('turnErrorCard.reloadSession')}
                </button>
              ) : null}
              {onDismiss ? (
                <ComposerDismissButton
                  label={dismissLabel ?? t('statusDock.dismiss')}
                  onClick={onDismiss}
                />
              ) : null}
            </div>
          ) : null}
        </div>
        {view.detail ? (
          <ConversationStatusDetails
            key={view.detail}
            title={view.title}
            label={t('statusDock.showDetails')}
            accessibleLabel={t('statusDock.showDetailsFor', {
              title: view.title,
            })}
            mono={view.tone === 'error'}
          >
            <div className="whitespace-pre-wrap break-words">{view.detail}</div>
          </ConversationStatusDetails>
        ) : null}
        <PlanUsageAside usage={error.plan_usage} />
      </div>
    );
  }

  return (
    <div
      role={view.tone === 'error' ? 'alert' : 'status'}
      data-tone={view.tone}
      className={cn(
        'conv-entry-item mb-2 rounded-lg border px-3 py-2.5 text-sm',
        view.tone === 'neutral'
          ? 'border-border bg-muted/40 text-muted-foreground'
          : 'border-destructive/40 bg-destructive/10 text-destructive'
      )}
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 shrink-0">{view.icon}</span>
        <div className="min-w-0 flex-1">
          <div className="font-medium">{view.title}</div>
          {view.detail ? (
            <div className="mt-0.5 whitespace-pre-wrap break-words leading-5 opacity-90">
              {view.detail}
            </div>
          ) : null}
          <PlanUsageAside usage={error.plan_usage} />
          {showRebind || showReload ? (
            <div className="mt-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={reloading}
                onClick={handleReload}
              >
                <RefreshCw
                  className={cn(
                    'mr-1 h-3.5 w-3.5',
                    reloading && 'animate-spin'
                  )}
                />
                {showRebind
                  ? t('turnErrorCard.rebindSession')
                  : t('turnErrorCard.reloadSession')}
              </Button>
            </div>
          ) : null}
        </div>
        {onDismiss ? (
          <button
            type="button"
            className={cn(
              'shrink-0 rounded-md p-1 opacity-70 transition-opacity hover:opacity-100',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
            )}
            onClick={onDismiss}
            title={dismissLabel ?? t('statusDock.dismiss')}
            aria-label={dismissLabel ?? t('statusDock.dismiss')}
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ComposerDismissButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="composer-status-dismiss"
      onClick={onClick}
      title={label}
      aria-label={label}
    >
      <X className="h-4 w-4" />
    </button>
  );
}

type ErrorTone = 'neutral' | 'error';

type ErrorView = {
  title: string;
  detail: string | null;
  tone: ErrorTone;
  icon: React.ReactNode;
  canReload: boolean;
  canRebind: boolean;
};

function describeError(error: ConversationError, t: TFunction): ErrorView {
  const message = error.message?.trim() || null;
  switch (errorKind(error)) {
    case 'cancelled':
      return {
        title: t('turnErrorCard.cancelledTitle'),
        detail: message,
        tone: 'neutral',
        icon: <Ban className="h-4 w-4" />,
        canReload: false,
        canRebind: false,
      };
    case 'resource_not_found':
      return {
        title: t('turnErrorCard.resourceNotFoundTitle'),
        detail: message ?? t('turnErrorCard.resourceNotFoundDetail'),
        tone: 'error',
        icon: <TriangleAlert className="h-4 w-4" />,
        canReload: false,
        canRebind: true,
      };
    case 'session_resume_unsupported':
      return {
        title: t('turnErrorCard.sessionResumeUnsupportedTitle'),
        detail: message ?? t('turnErrorCard.sessionResumeUnsupportedDetail'),
        tone: 'error',
        icon: <TriangleAlert className="h-4 w-4" />,
        canReload: false,
        canRebind: true,
      };
    case 'session_load_failed':
      return {
        title: t('turnErrorCard.sessionLoadFailedTitle'),
        detail: message,
        tone: 'error',
        icon: <TriangleAlert className="h-4 w-4" />,
        canReload: false,
        canRebind: true,
      };
    case 'idle_timeout':
      return {
        title: t('turnErrorCard.idleTimeoutTitle'),
        detail: t('turnErrorCard.idleTimeoutDetail'),
        tone: 'error',
        icon: <TriangleAlert className="h-4 w-4" />,
        canReload: true,
        canRebind: false,
      };
    case 'connection_closed':
      return {
        title: t('turnErrorCard.connectionClosedTitle'),
        detail: message ?? t('turnErrorCard.connectionClosedDetail'),
        tone: 'error',
        icon: <TriangleAlert className="h-4 w-4" />,
        canReload: true,
        canRebind: false,
      };
    case 'auth_required':
      return {
        title: t('turnErrorCard.authRequiredTitle'),
        detail: message ?? t('turnErrorCard.authRequiredDetail'),
        tone: 'error',
        icon: <ShieldAlert className="h-4 w-4" />,
        canReload: false,
        canRebind: true,
      };
    case 'rejected':
      return {
        title: t('turnErrorCard.rejectedTitle'),
        detail: errorDetail(
          message ?? t('turnErrorCard.rejectedDetail'),
          error.code,
          t
        ),
        tone: 'error',
        icon: <Ban className="h-4 w-4" />,
        canReload: false,
        canRebind: true,
      };
    case 'service_error':
      return {
        title: t('turnErrorCard.serviceErrorTitle'),
        detail: errorDetail(message, error.code, t),
        tone: 'error',
        icon: <TriangleAlert className="h-4 w-4" />,
        canReload: true,
        canRebind: false,
      };
    case 'rate_limited':
      return {
        title: t('turnErrorCard.rateLimitedTitle'),
        detail: errorDetail(message, error.code, t),
        tone: 'error',
        icon: <TriangleAlert className="h-4 w-4" />,
        canReload: true,
        canRebind: false,
      };
    case 'prompt_conflict':
    case 'unknown':
      return {
        title: t('turnErrorCard.defaultTitle'),
        detail: errorDetail(message, error.code, t),
        tone: 'error',
        icon: <TriangleAlert className="h-4 w-4" />,
        canReload: true,
        canRebind: false,
      };
  }
}

function errorKind(error: ConversationError): ConversationTurnErrorKind {
  if (error.kind) {
    return error.kind;
  }
  switch (error.code) {
    case 'invalid_request':
    case 'invalid_params':
      return 'rejected';
    case 'internal_error':
      return 'service_error';
    case 'request_cancelled':
    case 'cancelled':
      return 'cancelled';
    case 'auth_required':
      return 'auth_required';
    case 'resource_not_found':
      return 'resource_not_found';
    case 'session_resume_unsupported':
      return 'session_resume_unsupported';
    case 'session_load_failed':
      return 'session_load_failed';
    case 'idle_timeout':
      return 'idle_timeout';
    case 'connection_closed':
      return 'connection_closed';
    case 'prompt_conflict':
      return 'prompt_conflict';
    default:
      return 'unknown';
  }
}

function PlanUsageAside({ usage }: { usage?: AgentPlanUsage | null }) {
  const { t } = useTranslation(['conversation']);
  const window = usage?.windows.find(
    (item) => item.usedPercent != null || item.resetsAtMs != null
  );
  if (!window) return null;
  const percent =
    typeof window.usedPercent === 'number'
      ? Math.round(window.usedPercent)
      : null;
  const reset = describeReset(window.resetsAtMs, Date.now());
  const resetLabel = !reset
    ? null
    : reset.kind === 'soon'
      ? t('turnErrorCard.planUsageResetSoon')
      : t(`turnErrorCard.planUsageReset_${reset.kind}`, {
          count: reset.count,
        });
  return (
    <div className="mt-1 text-xs opacity-80">
      {percent != null && resetLabel
        ? t('turnErrorCard.planUsageAside', { percent, reset: resetLabel })
        : percent != null
          ? t('turnErrorCard.planUsagePercent', { percent })
          : resetLabel
            ? t('turnErrorCard.planUsageResetOnly', { reset: resetLabel })
            : null}
    </div>
  );
}

function errorDetail(
  message: string | null,
  code: string | null | undefined,
  t: TFunction
): string | null {
  if (message && code)
    return t('turnErrorCard.detailWithCode', { message, code });
  if (message) return message;
  if (code) return code;
  return null;
}
