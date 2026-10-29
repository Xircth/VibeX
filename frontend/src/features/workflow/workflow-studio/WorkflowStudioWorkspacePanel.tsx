import { X } from 'lucide-react';

import { Button } from '@/components/ui/button';

import type { WorkflowStudioView } from './useWorkflowStudio';

export function WorkflowStudioWorkspacePanel({
  studio,
}: {
  studio: WorkflowStudioView;
}) {
  const { workspaceOpen, workspaceConfig, t, setWorkspaceOpen } = studio;

  if (!(workspaceOpen && workspaceConfig)) return null;

  return (
    <aside
      data-testid="workflow-workspace-panel"
      className="workflow-workspace-panel absolute right-3 top-16 z-30 flex max-h-[calc(100%-76px)] w-[min(340px,calc(100%-24px))] flex-col overflow-hidden rounded-lg border bg-card shadow-xl"
    >
      <div className="flex items-center justify-between px-3.5 py-2.5">
        <span className="text-sm font-semibold">{t('studio.workspace')}</span>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          onClick={() => setWorkspaceOpen(false)}
          aria-label={t('studio.close')}
        >
          <X className="size-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-3.5 pb-3.5">
        {workspaceConfig}
      </div>
    </aside>
  );
}
