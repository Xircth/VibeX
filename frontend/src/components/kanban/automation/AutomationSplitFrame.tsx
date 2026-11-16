import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Layout,
  LayoutContent,
  LayoutPanel,
} from '@astryxdesign/core/Layout';
import { ResizeHandle, useResizable } from '@astryxdesign/core/Resizable';

/**
 * FilterTable master + collapsible resizable detail card split shell.
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
            <div className={detail ? 'pr-3' : undefined}>{master}</div>
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
                resizable={detailPanel.props}
                padding={0}
                role="complementary"
                label={panelLabel ?? t('pulseDeck.workbench.sources.panelAria')}
                data-testid={testId ? `${testId}-detail` : undefined}
              >
                <div className="automation-filter-table-card h-full overflow-y-auto p-4">
                  {detail}
                </div>
              </LayoutPanel>
            </>
          ) : undefined
        }
      />
    </div>
  );
}
