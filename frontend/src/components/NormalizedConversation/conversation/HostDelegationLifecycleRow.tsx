import { useTranslation } from 'react-i18next';
import type { ChatToolCallStatus } from '@astryxdesign/core/Chat';
import { ToolCardShell } from '../tools/ToolCardShell';
import type { ToolResultBlock, ToolUseBlock } from '../messageTurnBlocks';
import {
  hostDelegationLifecycleKind,
  hostDelegationLifecycleStatus,
} from './hostDelegation';

export function HostDelegationLifecycleRow({
  use,
  result,
}: {
  use: ToolUseBlock;
  result: ToolResultBlock | null;
}) {
  const { t } = useTranslation(['conversation', 'app']);
  const kind = hostDelegationLifecycleKind(use);
  const status = hostDelegationLifecycleStatus(result);
  const label =
    kind === 'cancel'
      ? t('delegationCard.cancel')
      : t('app:entryUtils.subagentStatus');
  const statusLabel =
    status === 'running'
      ? t('delegationCard.running')
      : status === 'completed'
        ? t('delegationCard.completed')
        : status === 'failed'
          ? t('delegationCard.failed')
          : t('delegationCard.canceled');
  const chatStatus: ChatToolCallStatus =
    status === 'running'
      ? 'running'
      : status === 'failed'
        ? 'error'
        : 'complete';

  return (
    <div data-testid="host-delegation-status-row">
      <ToolCardShell
        label={label}
        detail={statusLabel}
        chatStatus={chatStatus}
        expandable={false}
      />
    </div>
  );
}
