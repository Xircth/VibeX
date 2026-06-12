import WYSIWYGEditor from '@/components/ui/wysiwyg';
import type { ToolResult } from 'shared/types';
import { renderJson } from '../conversation-entry-utils';

export function ToolResultView({
  result,
  taskAttemptId,
}: {
  result: ToolResult | null | undefined;
  taskAttemptId?: string;
}) {
  if (!result) return null;

  if (result.type.type === 'markdown' && result.value) {
    return (
      <WYSIWYGEditor
        value={result.value.toString()}
        disabled
        taskAttemptId={taskAttemptId}
      />
    );
  }

  if (result.type.type === 'json') {
    return renderJson(result.value);
  }

  return null;
}
