import { TerminalSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { NormalizedEntry, ToolStatus } from 'shared/types';
import { useExpandable } from '@/stores/useExpandableStore';
import { getToolExitStatus, getToolSummary } from '../conversation-entry-utils';
import { ToolTerminal } from './ToolArtifact';
import {
  ToolCardShell,
  getToolStatusClassName,
  getToolStatusDotClassName,
} from './ToolCardShell';

function getCommandStatusClassName(
  exitStatus: ReturnType<typeof getToolExitStatus>,
  status: ToolStatus | undefined
) {
  if (
    status?.status === 'failed' ||
    status?.status === 'denied' ||
    status?.status === 'timed_out'
  ) {
    return 'conv-tool-card-error';
  }

  if (exitStatus === 'success') return 'conv-tool-card-success';
  if (exitStatus === 'error') return 'conv-tool-card-error';
  if (exitStatus === 'pending') return 'conv-tool-card-pending';

  return getToolStatusClassName(status);
}

function getCommandStatusDotClassName(
  exitStatus: ReturnType<typeof getToolExitStatus>,
  status: ToolStatus | undefined
) {
  if (
    status?.status === 'failed' ||
    status?.status === 'denied' ||
    status?.status === 'timed_out'
  ) {
    return 'conv-tool-dot conv-tool-dot-error';
  }

  if (exitStatus === 'success') return 'conv-tool-dot conv-tool-dot-success';
  if (exitStatus === 'error') return 'conv-tool-dot conv-tool-dot-error';
  if (exitStatus === 'pending') return 'conv-tool-dot conv-tool-dot-pending';

  return getToolStatusDotClassName(status);
}

export function CommandToolCard({
  entry,
  expansionKey,
  forceExpanded = false,
  defaultExpanded = false,
  linkifyUrls = false,
  hideLabel = false,
}: {
  entry: NormalizedEntry;
  expansionKey: string;
  forceExpanded?: boolean;
  defaultExpanded?: boolean;
  linkifyUrls?: boolean;
  hideLabel?: boolean;
}) {
  const { t } = useTranslation('app');
  const toolEntry =
    entry.entry_type.type === 'tool_use' ? entry.entry_type : undefined;
  const actionType =
    toolEntry?.action_type.action === 'command_run'
      ? toolEntry.action_type
      : null;
  const [expanded, toggle] = useExpandable(
    `command-tool-entry:${expansionKey}`,
    defaultExpanded
  );
  const effectiveExpanded = forceExpanded || expanded;
  const inlineText = entry.content.trim();
  const summary = getToolSummary(toolEntry, inlineText);
  const command = (actionType?.command || inlineText).trim();
  const output = actionType?.result?.output ?? null;
  const hasDetails = Boolean(command || output);
  const exitStatus = toolEntry ? getToolExitStatus(toolEntry) : null;
  const statusDotClass = getCommandStatusDotClassName(
    exitStatus,
    toolEntry?.status
  );
  const statusClass = getCommandStatusClassName(exitStatus, toolEntry?.status);

  if (!toolEntry || !actionType) return null;

  return (
    <ToolCardShell
      icon={<TerminalSquare className="h-3 w-3" />}
      label={hideLabel ? '' : t('entryUtils.terminal')}
      detail={summary.detail || command}
      statusClassName={statusClass}
      statusDotClassName={statusDotClass}
      status={toolEntry.status}
      chatStatus={
        statusClass.includes('conv-tool-card-error')
          ? 'error'
          : toolEntry.status.status === 'created'
            ? 'running'
            : toolEntry.status.status === 'pending_approval'
              ? 'pending'
              : statusClass.includes('conv-tool-card-pending')
                ? 'running'
                : 'complete'
      }
      expanded={effectiveExpanded}
      expandable={hasDetails}
      onToggle={toggle}
    >
      <ToolTerminal
        command={command}
        output={output}
        exitStatus={actionType.result?.exit_status}
        linkifyUrls={linkifyUrls}
      />
    </ToolCardShell>
  );
}
