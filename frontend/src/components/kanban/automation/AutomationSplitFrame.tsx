import type { CSSProperties, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  HStack,
  Layout,
  LayoutContent,
  LayoutPanel,
} from '@astryxdesign/core/Layout';
import { ResizeHandle, useResizable } from '@astryxdesign/core/Resizable';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { Text } from '@astryxdesign/core/Text';

import type { AutomationTaskStatus } from './automationModels';

/**
 * Exact group-header cell style from `@astryxdesign/cli template table-grouped`.
 * Placed on the `colSpan` TableCell so the muted background spans the full row.
 */
export const groupHeaderCell: CSSProperties = {
  cursor: 'pointer',
  backgroundColor: 'var(--color-background-muted)',
  padding: 'var(--spacing-3) var(--spacing-4)',
};

export const selectedTableRowStyle: CSSProperties = {
  backgroundColor: 'var(--color-background-muted)',
};

export const interactiveRowStyle: CSSProperties = {
  cursor: 'pointer',
};

export const STATUS_DOT_VARIANT: Record<
  AutomationTaskStatus,
  'accent' | 'warning' | 'success' | 'neutral'
> = {
  awaiting_approval: 'warning',
  running: 'accent',
  active: 'success',
  paused: 'neutral',
  draft: 'warning',
};

export function TaskStatusBadge({
  status,
  testId,
}: {
  status: AutomationTaskStatus;
  testId?: string;
}) {
  const { t } = useTranslation('panels');
  const label = t(`pulseDeck.workbench.status.${status}`);
  const isPulsing = status === 'running' || status === 'awaiting_approval';

  return (
    <HStack gap={1.5} vAlign="center" data-testid={testId}>
      <StatusDot
        variant={STATUS_DOT_VARIANT[status]}
        label={label}
        isPulsing={isPulsing}
      />
      <Text type="supporting" color="secondary" maxLines={1}>
        {label}
      </Text>
    </HStack>
  );
}

/**
 * Astryx `table-grouped` content + collapsible resizable complementary panel shell.
 * When `detail` is null/undefined, `LayoutContent` fills 100% width with no side divider.
 */
export function AutomationSplitFrame({
  header,
  master,
  detail,
  defaultDetailSize = 480,
  minDetailSize = 360,
  maxDetailSize = 660,
  panelLabel,
  testId,
}: {
  header?: ReactNode;
  master: ReactNode;
  detail?: ReactNode | null;
  defaultDetailSize?: number;
  minDetailSize?: number;
  maxDetailSize?: number;
  panelLabel?: string;
  testId?: string;
}) {
  const { t } = useTranslation('panels');
  const detailPanel = useResizable({
    defaultSize: defaultDetailSize,
    minSizePx: minDetailSize,
    maxSizePx: maxDetailSize,
  });

  return (
    <div
      data-testid={testId}
      className="flex h-full min-h-0 flex-1 flex-col overflow-hidden"
    >
      <Layout
        height="fill"
        header={header}
        content={
          <LayoutContent
            role="main"
            padding={0}
            data-testid={testId ? `${testId}-master` : undefined}
          >
            {master}
          </LayoutContent>
        }
        end={
          detail ? (
            <>
              <ResizeHandle
                resizable={detailPanel.props}
                isReversed
                isAlwaysVisible={false}
              />
              <LayoutPanel
                hasDivider
                resizable={detailPanel.props}
                padding={4}
                role="complementary"
                label={panelLabel ?? t('pulseDeck.workbench.editor.panelAria')}
                data-testid={testId ? `${testId}-detail` : undefined}
              >
                {detail}
              </LayoutPanel>
            </>
          ) : undefined
        }
      />
    </div>
  );
}
