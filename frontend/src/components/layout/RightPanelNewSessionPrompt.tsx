import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function RightPanelNewSessionPrompt({
  onCreateSession,
  className,
}: {
  onCreateSession: () => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex h-full min-h-0 flex-col items-center justify-center gap-3 px-4 text-center',
        className
      )}
    >
      <p className="text-sm text-muted-foreground">
        当前工作区还没有会话
      </p>
      <Button className="gap-1.5" onClick={onCreateSession}>
        <Plus className="h-3.5 w-3.5" />
        新建会话
      </Button>
    </div>
  );
}
