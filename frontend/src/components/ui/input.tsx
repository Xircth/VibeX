import * as React from 'react';
import { cn } from '@/lib/utils';
import { twMerge } from 'tailwind-merge';

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  onCommandEnter?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onCommandShiftEnter?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  (
    {
      className,
      type,
      onKeyDown,
      onCommandEnter,
      onCommandShiftEnter,
      ...props
    },
    ref
  ) => {
    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape') {
        e.currentTarget.blur();
      }
      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
        if (e.metaKey && e.shiftKey) {
          onCommandShiftEnter?.(e);
        } else {
          onCommandEnter?.(e);
        }
      }
      onKeyDown?.(e);
    };

    return (
      <input
        ref={ref}
        type={type}
        onKeyDown={handleKeyDown}
        className={twMerge(
          cn(
            'flex h-8 w-full rounded-[var(--_field-radius,var(--radius-element,var(--radius)))] border border-[var(--color-border-emphasized,hsl(var(--input)))] bg-[var(--color-background-surface,var(--surface-raised-control))] px-2.5 text-sm text-foreground shadow-none transition-[border-color,box-shadow] file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground hover:enabled:not(:focus-visible):[box-shadow:inset_0_0_0_2px_color-mix(in_srgb,var(--color-border-emphasized,hsl(var(--input)))_30%,transparent)] focus-visible:border-[var(--color-accent,hsl(var(--primary)))] focus-visible:outline-none focus-visible:[box-shadow:inset_0_0_0_2px_var(--color-accent-muted,hsl(var(--primary)/0.22))] disabled:cursor-not-allowed disabled:opacity-50',
            className
          )
        )}
        {...props}
      />
    );
  }
);

Input.displayName = 'Input';
export { Input };
