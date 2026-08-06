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
            'flex h-8 w-full rounded-lg border border-input bg-[var(--surface-control)] px-2.5 py-1 text-sm text-foreground shadow-none transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:border-primary/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-50',
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
