import { Outlet } from 'react-router-dom';
import { BranchInfoHeader } from '@/components/layout/BranchInfoHeader';
import { RightPanelSidebar } from '@/components/layout/RightPanelSidebar';

export function RightPanelContent() {
  return (
    <div className="h-full flex overflow-hidden bg-background">
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        <BranchInfoHeader />
        <div className="flex-1 min-h-0 overflow-hidden">
          <Outlet />
        </div>
      </div>
      <RightPanelSidebar />
    </div>
  );
}
