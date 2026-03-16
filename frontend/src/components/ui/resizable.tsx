import { Group, Panel, Separator } from 'react-resizable-panels';
import type { GroupProps, PanelProps, SeparatorProps } from 'react-resizable-panels';
import { cn } from '@/lib/utils';

function ResizablePanelGroup({
  className,
  direction,
  ...props
}: Omit<GroupProps, 'orientation'> & { direction?: 'horizontal' | 'vertical' }) {
  return (
    <Group
      orientation={direction ?? 'horizontal'}
      className={cn(
        'flex h-full w-full data-[panel-group-direction=vertical]:flex-col',
        className
      )}
      {...props}
    />
  );
}

function ResizablePanel(props: PanelProps) {
  return <Panel {...props} />;
}

function ResizableHandle({
  withHandle,
  className,
  ...props
}: SeparatorProps & {
  withHandle?: boolean;
}) {
  void withHandle;
  return (
    <Separator
      className={cn(
        'relative z-20 flex w-px items-center justify-center overflow-visible',
        'after:absolute after:inset-y-0 after:left-1/2 after:w-3 after:-translate-x-1/2',
        'before:pointer-events-none before:absolute before:inset-y-0 before:left-1/2 before:h-full before:w-px before:-translate-x-1/2 before:bg-border before:transition-all before:duration-150',
        'data-[resize-handle-state=hover]:before:w-[3px] data-[resize-handle-state=hover]:before:bg-foreground/40',
        'data-[resize-handle-state=drag]:before:w-[3px] data-[resize-handle-state=drag]:before:bg-foreground/60',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1',
        'data-[panel-group-direction=vertical]:h-px data-[panel-group-direction=vertical]:w-full',
        className
      )}
      {...props}
    />
  );
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup };
