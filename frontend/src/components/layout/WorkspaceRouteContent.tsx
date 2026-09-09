import { WorkspaceLayout } from '@/components/layout/WorkspaceLayout';
import { Toolbar } from '@/components/layout/Toolbar';
import { RightPanelContent } from '@/components/layout/RightPanelContent';

export function WorkspaceRouteContent() {
  return (
    <WorkspaceLayout
      toolbarContent={<Toolbar />}
      rightPanelContent={<RightPanelContent />}
    />
  );
}
