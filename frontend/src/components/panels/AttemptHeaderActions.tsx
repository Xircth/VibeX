import { Eye, FileDiff, X } from 'lucide-react';
import { Button } from '../ui/button';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../ui/tooltip';
type LayoutMode = 'preview' | 'diffs' | null;
import type { TaskWithAttemptStatus } from 'shared/types';
import { ActionsDropdown } from '../ui/actions-dropdown';
import { WorkspaceWithSession } from '@/types/attempt';

interface AttemptHeaderActionsProps {
  onClose: () => void;
  mode?: LayoutMode;
  onModeChange?: (mode: LayoutMode) => void;
  task: TaskWithAttemptStatus;
  attempt?: WorkspaceWithSession | null;
}

export const AttemptHeaderActions = ({
  onClose,
  mode,
  onModeChange,
  task,
  attempt,
}: AttemptHeaderActionsProps) => {
  return (
    <>
      {typeof mode !== 'undefined' && onModeChange && (
        <TooltipProvider>
          <ToggleGroup
            type="single"
            value={mode ?? ''}
            onValueChange={(v) => {
              const newMode = (v as LayoutMode) || null;
              onModeChange(newMode);
            }}
            className="inline-flex gap-4"
            aria-label="Layout mode"
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <ToggleGroupItem
                  value="preview"
                  aria-label="Preview"
                  active={mode === 'preview'}
                >
                  <Eye className="h-4 w-4" />
                </ToggleGroupItem>
              </TooltipTrigger>
              <TooltipContent side="bottom">{'预览'}</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <ToggleGroupItem
                  value="diffs"
                  aria-label="Diffs"
                  active={mode === 'diffs'}
                >
                  <FileDiff className="h-4 w-4" />
                </ToggleGroupItem>
              </TooltipTrigger>
              <TooltipContent side="bottom">{'差异'}</TooltipContent>
            </Tooltip>
            {/* {attempt?.id && (
              <>
                <div className="h-4 w-px bg-border" />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Link
                      to={`/workspaces/${attempt.id}`}
                      className="inline-flex items-center justify-center text-primary-foreground/70 hover:text-accent-foreground"
                      aria-label="Try the new UI"
                    >
                      <Sparkles className="h-4 w-4" />
                    </Link>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {'试用新界面'}
                  </TooltipContent>
                </Tooltip>
              </>
            )} */}
          </ToggleGroup>
        </TooltipProvider>
      )}
      {typeof mode !== 'undefined' && onModeChange && (
        <div className="h-4 w-px bg-border" />
      )}
      <ActionsDropdown task={task} attempt={attempt} />
      <Button variant="icon" aria-label="Close" onClick={onClose}>
        <X size={16} />
      </Button>
    </>
  );
};
