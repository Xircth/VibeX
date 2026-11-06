import { type ReactNode } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@/components/ui/button';
import { ConversationStatusDetails } from '@/components/NormalizedConversation/conversation/ConversationStatusDetails';
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
  return (
    <div
      className="composer-status-surface rounded-lg"
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
          {action ? (
            <div className="flex shrink-0 items-center gap-1">{action}</div>
          ) : null}
        </div>
        {detail ? (
          <ConversationStatusDetails
            key={detail}
            title={title}
            label={t('statusDock.showDetails')}
            accessibleLabel={t('statusDock.showDetailsFor', { title })}
            mono
          >
            <p className="whitespace-pre-wrap break-words">{detail}</p>
          </ConversationStatusDetails>
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
