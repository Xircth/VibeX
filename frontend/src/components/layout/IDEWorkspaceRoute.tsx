import { WorkspaceLayout } from '@/components/layout/WorkspaceLayout';
import { Toolbar } from '@/components/layout/Toolbar';
import { RightPanelContent } from '@/components/layout/RightPanelContent';

/**
 * IDEWorkspaceRoute - Route layout component that wraps workspace pages
 * in the new IDE-style dockview layout.
 *
 * This replaces the NormalLayout for workspace routes (task pages).
 * Non-workspace routes (Projects list, Settings, etc.) continue to use NormalLayout.
 */
export function IDEWorkspaceRoute() {
  return (
    <div className="flex flex-col h-screen">
      <WorkspaceLayout
        toolbarContent={<Toolbar />}
        rightPanelContent={<RightPanelContent />}
      />
    </div>
  );
}
