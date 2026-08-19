import { useState } from 'react';
import { Download, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ConversationNoticeAction } from 'shared/types';
import { toast } from '@/components/ui/toast';
import {
  agentManagementApi,
  agentManagementErrorMessage,
} from '@/features/agent-management';
import { useOpenLink } from '@/hooks/useOpenLink';

export function SessionNoticeActions({
  action,
}: {
  action: ConversationNoticeAction;
}) {
  const { t } = useTranslation(['conversation', 'settings']);
  const openLink = useOpenLink();
  const [busy, setBusy] = useState(false);

  if (action.kind === 'update_agent') {
    return (
      <button
        type="button"
        className="composer-status-action"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void agentManagementApi
            .applyUpdate(action.agent_id)
            .then(() => {
              toast.success(t('conversation:statusDock.updateStarted'));
            })
            .catch((error: unknown) => {
              toast.error(
                agentManagementErrorMessage(
                  error,
                  t('conversation:statusDock.updateFailed')
                )
              );
              if (action.fallback_url) {
                openLink(action.fallback_url);
              }
            })
            .finally(() => setBusy(false));
        }}
      >
        <Download className="h-3.5 w-3.5" />
        {busy
          ? t('conversation:statusDock.updating')
          : t('conversation:statusDock.updateAgent')}
      </button>
    );
  }

  return (
    <button
      type="button"
      className="composer-status-action"
      onClick={() => openLink(action.url)}
    >
      <ExternalLink className="h-3.5 w-3.5" />
      {action.label}
    </button>
  );
}
