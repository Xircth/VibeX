import { TerminalSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { NormalizedEntry, ToolStatus } from 'shared/types';
import RawLogText from '@/components/common/RawLogText';
import { useExpandable } from '@/stores/useExpandableStore';
import {
  getCompactVerboseErrorText,
  getToolExitStatus,
  getToolSummary,
} from '../conversation-entry-utils';
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
  const { t } = useTranslation(['conversation', 'common']);
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
  const compactOutput = output ? getCompactVerboseErrorText(output) : null;
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
      label={hideLabel ? '' : 'Terminal'}
      detail={summary.detail || command}
      statusClassName={statusClass}
      statusDotClassName={statusDotClass}
      expanded={effectiveExpanded}
      expandable={hasDetails}
      onToggle={toggle}
    >
      {command ? (
        <>
          <div className="conv-tool-details-section-label">
            {t('commandTool.commandLabel')}
          </div>
          <div className="conv-tool-details-content">{command}</div>
        </>
      ) : null}
      {output ? (
        <>
          <div className="conv-tool-details-section-label">
            {t('commandTool.outputLabel')}
          </div>
          {compactOutput ? (
            <details className="conv-output-details">
              <summary className="conv-compact-output" title={output}>
                {compactOutput}
              </summary>
              <div className="conv-terminal-output">
                <RawLogText content={output} linkifyUrls={linkifyUrls} />
              </div>
            </details>
          ) : (
            <div className="conv-terminal-output">
              <RawLogText content={output} linkifyUrls={linkifyUrls} />
            </div>
          )}
        </>
      ) : null}
    </ToolCardShell>
  );
}
