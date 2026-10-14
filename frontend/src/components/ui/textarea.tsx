import * as React from 'react';

import { cn } from '@/lib/utils';

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<'textarea'>
>(({ className, ...props }, ref) => {
  return (
    <textarea
      className={cn(
        'flex min-h-[80px] w-full rounded-[var(--_field-radius,var(--radius-element,var(--radius)))] border border-[var(--color-border-emphasized,hsl(var(--input)))] bg-[var(--color-background-surface,var(--surface-raised-control))] px-3 py-2 text-sm text-foreground shadow-none transition-[border-color,box-shadow] placeholder:text-muted-foreground hover:enabled:not(:focus-visible):[box-shadow:inset_0_0_0_2px_color-mix(in_srgb,var(--color-border-emphasized,hsl(var(--input)))_30%,transparent)] focus-visible:border-[var(--color-accent,hsl(var(--primary)))] focus-visible:outline-none focus-visible:[box-shadow:inset_0_0_0_2px_var(--color-accent-muted,hsl(var(--primary)/0.22))] disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      ref={ref}
      {...props}
    />
  );
});
Textarea.displayName = 'Textarea';

export { Textarea };
