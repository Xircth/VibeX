import { KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { AgentPermissionRequest } from '@/features/agents/types';

export type PendingAgentPermission = {
  connectionId: string;
  request: AgentPermissionRequest;
};

type AgentPermissionPanelProps = {
  permissions: PendingAgentPermission[];
  respondingPermissionId: string | null;
  onRespond: (permission: PendingAgentPermission, optionId: string | null) => void;
};

export function AgentPermissionPanel({
  permissions,
  respondingPermissionId,
  onRespond,
}: AgentPermissionPanelProps) {
  if (permissions.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {permissions.map((permission) => {
        const disabled = respondingPermissionId === permission.request.id;
        return (
          <div
            key={permission.request.id}
            className="rounded-lg border bg-background px-4 py-3 shadow-sm"
          >
            <div className="flex items-start gap-3">
              <div className="mt-0.5 rounded-md border bg-muted/50 p-1.5 text-muted-foreground">
                <KeyRound className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-foreground">
                  {permission.request.title}
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {permission.request.options.map((option) => (
                    <Button
                      key={option.id}
                      type="button"
                      size="sm"
                      variant={
                        option.description?.includes('Reject')
                          ? 'outline'
                          : 'default'
                      }
                      disabled={disabled}
                      onClick={() => onRespond(permission, option.id)}
                    >
                      {option.label}
                    </Button>
                  ))}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => onRespond(permission, null)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
