import { ArrowDown, FolderTree } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  findWorkspaceBranchOption,
  type WorkspaceBranchOption,
} from '@/lib/workspaceBranchOptions';

interface WorkspaceSelectorProps {
  options: WorkspaceBranchOption[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
  dropdownSide?: 'top' | 'bottom';
}

function getOptionDescription(option: WorkspaceBranchOption) {
  if (option.useWorktree) {
    return option.workspace?.name?.trim()
      ? `${option.workspace.name} · Git Worktree`
      : 'Git Worktree';
  }

  return option.isCurrentProjectBranch
    ? '当前项目目录分支'
    : '非 Worktree，选择后将先 checkout';
}

export function WorkspaceSelector({
  options,
  value,
  onChange,
  disabled,
  className = '',
  dropdownSide = 'bottom',
}: WorkspaceSelectorProps) {
  const selectedOption = findWorkspaceBranchOption(options, value);

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          id="session-create-workspace"
          variant="outline"
          size="sm"
          className={`h-9 w-full justify-between text-xs ${className}`}
          disabled={disabled || options.length === 0}
          aria-label="选择工作区分支"
          title={selectedOption ? selectedOption.branch : '请选择工作区分支'}
        >
          <div className="flex min-w-0 w-full items-center gap-1.5">
            <FolderTree className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">
              {selectedOption?.branch ?? '请选择工作区分支'}
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
        className="w-80"
      >
        {options.map((option) => (
          <DropdownMenuItem
            key={option.value}
            onSelect={() => onChange(option.value)}
            className={option.value === value ? 'bg-accent' : ''}
          >
            <div className="min-w-0 space-y-1">
              <div className="flex items-center gap-2">
                <div className="truncate text-xs font-medium">
                  {option.branch}
                </div>
                <span
                  className={
                    option.useWorktree
                      ? 'rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary'
                      : 'rounded-full bg-amber-500/12 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-300'
                  }
                >
                  {option.useWorktree ? 'Worktree' : 'Project'}
                </span>
              </div>
              <div className="truncate text-[10px] text-muted-foreground">
                {getOptionDescription(option)}
              </div>
            </div>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
