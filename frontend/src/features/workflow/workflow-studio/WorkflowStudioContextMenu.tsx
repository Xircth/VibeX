import {
  Bell,
  Bot,
  Copy,
  GitBranch,
  ListTree,
  Plus,
  Send,
  ShieldCheck,
  Terminal,
  Trash2,
  Users,
  Zap,
} from 'lucide-react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import { resolveWorkflowAgentId } from '../workflowAgent';
import { StudioAgentIcon } from './StudioAgentIcon';
import type { WorkflowStudioView } from './useWorkflowStudio';

export function WorkflowStudioContextMenu({
  studio,
}: {
  studio: WorkflowStudioView;
}) {
  const {
    contextMenu,
    setContextMenu,
    t,
    addStep,
    agentOptions,
    config,
    copySelected,
    definition,
    removeStep,
    setLogStepId,
  } = studio;

  if (!contextMenu) return null;

  const addAndClose = (
    kind: Parameters<WorkflowStudioView['addStep']>[0]
  ) => {
    addStep(kind);
    setContextMenu(null);
  };

  return (
    <DropdownMenu
      open
      onOpenChange={(open) => {
        if (!open) setContextMenu(null);
      }}
    >
      <DropdownMenuTrigger asChild>
        <span
          className="pointer-events-none fixed size-0"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        {contextMenu.kind === 'pane' ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Plus className="size-4" /> {t('studio.addNode')}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="min-w-52">
              <DropdownMenuItem onSelect={() => addAndClose('trigger')}>
                <Zap className="size-4" /> Event Trigger
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => addAndClose('session')}>
                <Terminal className="size-4" /> Session Step (Fresh Context)
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => addAndClose('bot')}>
                <Bot className="size-4" /> Bot Step (Persistent Memory)
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => addAndClose('group_stage')}>
                <Users className="size-4" /> Group Stage
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => addAndClose('user_gate')}>
                <ShieldCheck className="size-4" /> User Gate
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => addAndClose('control')}>
                <GitBranch className="size-4" /> Flow Control
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => addAndClose('outbox_action')}>
                <Send className="size-4" /> Outbox Action
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => addAndClose('agent')}>
                <StudioAgentIcon
                  agentId={resolveWorkflowAgentId(
                    agentOptions,
                    config?.executor_profile?.executor
                  )}
                  agentOptions={agentOptions}
                  className="size-4"
                />
                {t('studio.agentStep')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => addAndClose('notify')}>
                <Bell className="size-4" /> {t('studio.notify')}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : (
          <>
            {contextMenu.confirmation ? null : (
              <>
                <DropdownMenuItem
                  onSelect={() => {
                    if (contextMenu.stepId) copySelected(contextMenu.stepId);
                    setContextMenu(null);
                  }}
                >
                  <Copy className="size-4" /> {t('studio.copyNode')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-destructive"
                  disabled={definition.steps.length === 1}
                  onSelect={() => {
                    if (contextMenu.stepId) removeStep(contextMenu.stepId);
                    setContextMenu(null);
                  }}
                >
                  <Trash2 className="size-4" /> {t('studio.deleteNode')}
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuItem
              onSelect={() => {
                if (contextMenu.stepId) setLogStepId(contextMenu.stepId);
                setContextMenu(null);
              }}
            >
              <ListTree className="size-4" /> {t('studio.showRecords')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
