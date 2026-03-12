import * as React from 'react';
import { cn } from '@/lib/utils';

interface KbdProps extends React.HTMLAttributes<HTMLElement> {
  children: React.ReactNode;
}

const Kbd = React.forwardRef<HTMLElement, KbdProps>(
  ({ className, children, ...props }, ref) => (
    <kbd
      ref={ref}
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-muted px-1 font-mono text-[10px] font-medium text-muted-foreground',
        '[&_svg]:h-3 [&_svg]:w-3',
        className
      )}
      {...props}
    >
      {children}
    </kbd>
  )
);
Kbd.displayName = 'Kbd';

interface KbdGroupProps extends React.HTMLAttributes<HTMLSpanElement> {
  children: React.ReactNode;
}

const KbdGroup = React.forwardRef<HTMLSpanElement, KbdGroupProps>(
  ({ className, children, ...props }, ref) => (
    <span
      ref={ref}
      className={cn('inline-flex items-center gap-0.5', className)}
      {...props}
    >
      {children}
    </span>
  )
);
KbdGroup.displayName = 'KbdGroup';

export { Kbd, KbdGroup };
