import * as React from 'react';
import { twMerge } from 'tailwind-merge';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] focus-visible:ring-offset-0 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      variant: {
        default:
          'border border-transparent bg-primary text-primary-foreground shadow-none hover:bg-primary/90',
        destructive:
          'border border-destructive bg-transparent text-destructive hover:bg-destructive/10',
        outline:
          'border border-border bg-transparent text-foreground hover:bg-[var(--surface-control-hover)]',
        secondary:
          'border border-border bg-[var(--surface-control)] text-foreground hover:bg-[var(--surface-control-hover)]',
        ghost:
          'bg-transparent text-muted-foreground hover:bg-[var(--surface-control-hover)] hover:text-foreground',
        link: 'h-auto p-0 text-primary underline-offset-4 hover:underline',
        icon: 'bg-transparent p-0 text-muted-foreground hover:bg-[var(--surface-control-hover)] hover:text-foreground',
      },
      size: {
        default: 'h-8 px-3',
        xs: 'h-6 px-2 text-xs',
        sm: 'h-7 px-2.5 text-xs',
        lg: 'h-9 px-4',
        icon: 'h-8 w-8 p-0',
      },
    },
    compoundVariants: [{ variant: 'icon', class: 'h-8 w-8 p-0' }],
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        className={twMerge(cn(buttonVariants({ variant, size, className })))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = 'Button';

export { Button, buttonVariants };
