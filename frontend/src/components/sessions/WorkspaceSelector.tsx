import { FolderTree, ArrowDown } from 'lucide-react';
import type { Workspace } from 'shared/types';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface WorkspaceSelectorProps {
  workspaces: Workspace[];
  value: string;
  onChange: (workspaceId: string) => void;
  disabled?: boolean;
  className?: string;
  dropdownSide?: 'top' | 'bottom';
}

function getWorkspaceLabel(workspace: Workspace) {
  return workspace.name?.trim() || workspace.branch;
}

export function WorkspaceSelector({
  workspaces,
  value,
  onChange,
  disabled,
  className = '',
  dropdownSide = 'bottom',
}: WorkspaceSelectorProps) {
  const selectedWorkspace =
    workspaces.find((workspace) => workspace.id === value) ?? null;

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          id="session-create-workspace"
          variant="outline"
          size="sm"
          className={`w-full justify-between text-xs h-9 ${className}`}
          disabled={disabled || workspaces.length === 0}
          aria-label="选择工作区"
          title={
            selectedWorkspace
              ? getWorkspaceLabel(selectedWorkspace)
              : '请选择工作区'
          }
        >
          <div className="flex items-center gap-1.5 w-full min-w-0">
            <FolderTree className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">
              {selectedWorkspace
                ? getWorkspaceLabel(selectedWorkspace)
                : '请选择工作区'}
            </span>
          </div>
          <ArrowDown className="h-3 w-3 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side={dropdownSide}
        align="start"
        sideOffset={1}
        avoidCollisions={false}
        className="w-72"
      >
        {workspaces.map((workspace) => {
          const workspaceLabel = getWorkspaceLabel(workspace);
          return (
            <DropdownMenuItem
              key={workspace.id}
              onSelect={() => onChange(workspace.id)}
              className={workspace.id === value ? 'bg-accent' : ''}
            >
              <div className="min-w-0">
                <div className="truncate text-xs font-medium">
                  {workspaceLabel}
                </div>
                {workspace.name?.trim() ? (
                  <div className="truncate text-[10px] text-muted-foreground">
                    {workspace.branch}
                  </div>
                ) : null}
              </div>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
