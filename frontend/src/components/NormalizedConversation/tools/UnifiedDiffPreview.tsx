import type { FileChange } from 'shared/types';
import EditDiffRenderer from '../EditDiffRenderer';
import FileChangeRenderer from '../FileChangeRenderer';

export function UnifiedDiffPreview({
  path,
  change,
  expansionKey,
  defaultExpanded = false,
  statusAppearance = 'default',
  forceExpanded = false,
  containerRef,
}: {
  path: string;
  change: FileChange;
  expansionKey: string;
  defaultExpanded?: boolean;
  statusAppearance?: 'default' | 'denied' | 'timed_out';
  forceExpanded?: boolean;
  containerRef?: string | null;
}) {
  if (change.action === 'edit') {
    return (
      <EditDiffRenderer
        path={path}
        unifiedDiff={change.unified_diff}
        hasLineNumbers={change.has_line_numbers}
        expansionKey={expansionKey}
        defaultExpanded={defaultExpanded}
        statusAppearance={statusAppearance}
        forceExpanded={forceExpanded}
        containerRef={containerRef}
      />
    );
  }

  return (
    <FileChangeRenderer
      path={path}
      change={change}
      expansionKey={expansionKey}
      defaultExpanded={defaultExpanded}
      statusAppearance={statusAppearance}
      forceExpanded={forceExpanded}
      containerRef={containerRef}
    />
  );
}
