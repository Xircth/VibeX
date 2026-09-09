import { lazy, Suspense } from 'react';

const WorkspaceRouteContent = lazy(() =>
  import('./WorkspaceRouteContent').then((module) => ({
    default: module.WorkspaceRouteContent,
  }))
);

function WorkspaceShellFallback() {
  return (
    <div
      className="workspace-shell relative flex h-full w-full flex-col"
      aria-busy="true"
    >
      <div className="workspace-divider-bottom z-10 shrink-0">
        <div className="workspace-topbar window-chrome relative w-full px-1.5">
          <div data-tauri-drag-region className="absolute inset-0" />
          <div className="relative z-10 flex h-9 items-center gap-0.5" />
        </div>
      </div>
      <div className="flex min-h-0 flex-1" />
      <div className="workspace-divider-top h-6 shrink-0" />
    </div>
  );
}

export function IDEWorkspaceRoute() {
  return (
    <div className="flex h-screen flex-col" data-testid="workspace-route-shell">
      <Suspense fallback={<WorkspaceShellFallback />}>
        <WorkspaceRouteContent />
      </Suspense>
    </div>
  );
}
