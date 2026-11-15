import type { CSSProperties, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { DropdownMenu } from '@astryxdesign/core/DropdownMenu';
import { Icon } from '@astryxdesign/core/Icon';
import {
  HStack,
  Layout,
  LayoutContent,
  LayoutPanel,
} from '@astryxdesign/core/Layout';
import { ResizeHandle, useResizable } from '@astryxdesign/core/Resizable';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { Text } from '@astryxdesign/core/Text';
import { GitFork, Plus, Zap } from 'lucide-react';
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
  running: 'accent',
  testing: 'warning',
  publishing: 'accent',
  published: 'success',
  pending_test: 'warning',
  editing: 'neutral',
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
  const isPulsing =
    status === 'running' || status === 'testing' || status === 'publishing';

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
 * Unified "新建" (New) menu button combining "任务" (Task) and "工作流" (Workflow)
 * into a single control instead of rendering two separate buttons.
 */
export function NewAutomationMenuButton({
  onNewFastTask,
  onNewWorkflow,
  size = 'md',
  testId = 'automation-new-menu-btn',
}: {
  onNewFastTask: () => void;
  onNewWorkflow: () => void;
  size?: 'sm' | 'md' | 'lg';
  testId?: string;
}) {
  const { t } = useTranslation('panels');

  return (
    <DropdownMenu
      alignment="end"
      data-testid={testId}
      button={{
        label: t('pulseDeck.workbench.actions.newMenu'),
        variant: 'primary',
        size,
        icon: <Icon icon={Plus} size="sm" />,
      }}
      items={[
        {
          label: t('pulseDeck.workbench.actions.newTaskItem'),
          icon: Zap,
          onClick: onNewFastTask,
        },
        {
          label: t('pulseDeck.workbench.actions.newWorkflowItem'),
          icon: GitFork,
          onClick: onNewWorkflow,
        },
      ]}
    />
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
  defaultDetailSize = 500,
  minDetailSize = 380,
  maxDetailSize = 680,
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
