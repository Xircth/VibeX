import { useEffect, useId, useState, type ReactNode } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@/components/ui/button';
import {
  ConversationStatusDetailsContent,
  ConversationStatusDetailsTrigger,
} from '@/components/NormalizedConversation/conversation/ConversationStatusDetails';
import { openAgentDiagnostics } from '@/features/agent-management/agentSettingsFocus';
import {
  invokeErrorText,
  isAgentInstallLaunchError,
  splitLaunchError,
} from '@/features/agents/sessionControlsError';

export function SessionCreationStatusCard({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string | null;
  action?: ReactNode;
}) {
  const { t } = useTranslation('conversation');
  const detailsId = useId();
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setExpanded(false);
  }, [detail]);

  return (
    <div
      className="composer-status-surface rounded-[var(--radius-composer,0.75rem)]"
      data-testid="session-creation-status-card"
    >
      <div
        className="composer-status-row text-xs"
        data-tone="error"
        role="alert"
      >
        <div className="composer-status-header">
          <div className="composer-status-heading">
            <p className="composer-status-title whitespace-normal text-foreground [overflow-wrap:anywhere]">
              {title}
            </p>
            <Badge
              className="composer-status-badge"
              variant="error"
              label={t('statusDock.errorBadge')}
            />
          </div>
          {detail || action ? (
            <div className="flex shrink-0 items-center gap-1.5">
              {detail ? (
                <ConversationStatusDetailsTrigger
                  title={title}
                  label={t('statusDock.showDetails')}
                  accessibleLabel={t('statusDock.showDetailsFor', { title })}
                  expanded={expanded}
                  controlsId={detailsId}
                  onToggle={() => setExpanded((current) => !current)}
                />
              ) : null}
              {action}
            </div>
          ) : null}
        </div>
        {detail && expanded ? (
          <ConversationStatusDetailsContent id={detailsId} mono>
            <p className="whitespace-pre-wrap break-words">{detail}</p>
          </ConversationStatusDetailsContent>
        ) : null}
      </div>
    </div>
  );
}

export function formatSessionControlsError(
  t: TFunction,
  agent: string | null,
  error: unknown
): {
  title: string;
  detail: string | null;
  showDiagnosticsLink: boolean;
} {
  const raw = invokeErrorText(error);
  if (isAgentInstallLaunchError(raw)) {
    const { detail } = splitLaunchError(raw);
    return {
      title: t('sessionCreation.agentNotInstalled'),
      detail,
      showDiagnosticsLink: true,
    };
  }
  return {
    title: t('sessionCreation.controlsPrepareFailed', { agent }),
    detail: raw || null,
    showDiagnosticsLink: false,
  };
}

export function AgentSessionControlsErrorCard({
  agentId,
  error,
}: {
  agentId: string | null;
  error: unknown;
}) {
  const { t } = useTranslation('tasks');
  const normalizedAgent = agentId?.trim() || null;
  const formatted = formatSessionControlsError(t, normalizedAgent, error);
  return (
    <SessionCreationStatusCard
      title={formatted.title}
      detail={formatted.detail}
      action={
        formatted.showDiagnosticsLink && normalizedAgent ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => openAgentDiagnostics(normalizedAgent)}
          >
            {t('sessionCreation.viewDiagnostics')}
          </Button>
        ) : null
      }
    />
  );
}
