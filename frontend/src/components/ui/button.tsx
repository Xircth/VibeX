import * as React from 'react';
import { twMerge } from 'tailwind-merge';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'astryx-button inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-[color,background-color,background-image,border-color,box-shadow,transform,opacity] duration-[var(--duration-fast,125ms)] ease-[var(--ease-standard,cubic-bezier(0.24,1,0.4,1))] motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] focus-visible:ring-offset-0 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      variant: {
        default:
          'primary-control border border-transparent bg-primary text-[var(--primary-control-foreground)] hover:bg-primary/90',
        primary:
          'primary-control border border-transparent bg-primary text-[var(--primary-control-foreground)] hover:bg-primary/90',
        destructive:
          'destructive-control border border-destructive bg-transparent text-destructive hover:bg-destructive/10',
        outline: 'raised-control',
        secondary: 'raised-control',
        ghost:
          'bg-transparent text-muted-foreground hover:bg-[var(--surface-control-hover)] hover:text-foreground',
        link: 'h-auto p-0 text-primary underline-offset-4 hover:underline',
        icon: 'bg-transparent p-0 text-muted-foreground hover:bg-[var(--surface-control-hover)] hover:text-foreground',
      },
      size: {
        default: 'h-8 px-3',
        md: 'h-8 px-3',
        xs: 'h-6 gap-1.5 px-2 text-xs',
        sm: 'h-7 gap-1.5 px-2.5 text-xs',
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

export type ButtonElevation = 'none' | 'low' | 'med' | 'high';

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  /** Accessible label for the button. Rendered when `children` is omitted, or used as `aria-label` when `isIconOnly` is true. */
  label?: string;
  /** Astryx-compatible alias for `disabled`. */
  isDisabled?: boolean;
  /** Shows a centered loading spinner while preserving button width. */
  isLoading?: boolean;
  /** Keeps the button interactive while `isLoading` or `clickAction` is pending. */
  isInterruptible?: boolean;
  /** Async click action that automatically enters loading state while pending. */
  clickAction?: (
    e: React.MouseEvent<HTMLButtonElement>
  ) => void | Promise<void>;
  /** Leading icon element rendered before the label. */
  icon?: React.ReactNode;
  /** Trailing content element rendered after the label (e.g. badge, chevron). */
  endContent?: React.ReactNode;
  /** Renders as a square icon-only button using `label` as `aria-label`. */
  isIconOnly?: boolean;
  /** Resting shadow elevation for floating buttons. */
  elevation?: ButtonElevation;
}

function resolveAstryxVariant(
  variant: ButtonProps['variant']
): 'primary' | 'secondary' | 'ghost' | 'destructive' | 'link' {
  switch (variant) {
    case 'outline':
    case 'secondary':
      return 'secondary';
    case 'ghost':
    case 'icon':
      return 'ghost';
    case 'destructive':
      return 'destructive';
    case 'link':
      return 'link';
    case 'default':
    case 'primary':
    default:
      return 'primary';
  }
}

function resolveAstryxSize(
  size: ButtonProps['size']
): 'xs' | 'sm' | 'md' | 'lg' {
  switch (size) {
    case 'xs':
      return 'xs';
    case 'sm':
      return 'sm';
    case 'lg':
      return 'lg';
    case 'default':
    case 'md':
    case 'icon':
    default:
      return 'md';
  }
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      asChild = false,
      label,
      disabled,
      isDisabled = false,
      isLoading = false,
      isInterruptible = false,
      clickAction,
      icon,
      endContent,
      isIconOnly = false,
      elevation = 'none',
      onClick,
      children,
      ...props
    },
    ref
  ) => {
    const [isPending, startTransition] = React.useTransition();
    const actionInFlightRef = React.useRef(false);
    const isLoadingState = Boolean(isLoading || isPending);
    const buttonDisabled = Boolean(
      disabled || isDisabled || (isLoadingState && !isInterruptible)
    );

    const dataVariant = resolveAstryxVariant(variant);
    const dataSize = resolveAstryxSize(size);
    const hasStructuredContent =
      !asChild &&
      (isLoadingState || icon != null || endContent != null || isIconOnly);

    const resolvedAriaLabel =
      props['aria-label'] ??
      (label && (isIconOnly || isLoadingState || children != null)
        ? label
        : undefined);

    const handleClick: React.MouseEventHandler<HTMLButtonElement> = (e) => {
      if (buttonDisabled || (actionInFlightRef.current && !isInterruptible)) {
        e.preventDefault();
        return;
      }
      onClick?.(e);
      if (clickAction && !e.defaultPrevented) {
        actionInFlightRef.current = true;
        startTransition(async () => {
          try {
            await clickAction(e);
          } finally {
            actionInFlightRef.current = false;
          }
        });
      }
    };

    const Comp = asChild ? Slot : 'button';

    return (
      <Comp
        className={twMerge(
          cn(
            buttonVariants({
              variant,
              size: isIconOnly && !size ? 'icon' : size,
              className,
            }),
            isIconOnly && 'aspect-square p-0'
          )
        )}
        ref={ref}
        disabled={asChild ? disabled : buttonDisabled}
        data-variant={dataVariant}
        data-size={dataSize}
        data-elevation={elevation !== 'none' ? elevation : undefined}
        data-astryx-pressable={
          dataVariant !== 'link' && !buttonDisabled ? '' : undefined
        }
        data-edge-comp={dataVariant === 'ghost' ? '' : undefined}
        data-icon-only={isIconOnly ? '' : undefined}
        aria-busy={isLoadingState || undefined}
        aria-label={resolvedAriaLabel}
        onClick={asChild ? onClick : handleClick}
        {...props}
      >
        {hasStructuredContent ? (
          <>
            {isLoadingState && (
              <span className="astryx-button__spinner" aria-hidden="true">
                <span className="astryx-button__spinner-ring" />
              </span>
            )}
            <span
              className="astryx-button__content"
              data-loading={isLoadingState ? 'true' : undefined}
              aria-hidden={isLoadingState || undefined}
            >
              {icon != null && (
                <span className="astryx-button__icon">{icon}</span>
              )}
              {!isIconOnly && (children ?? label) != null && (
                <span className="astryx-button__label">
                  {children ?? label}
                </span>
              )}
              {!isIconOnly && endContent != null && (
                <span className="astryx-button__end">{endContent}</span>
              )}
            </span>
          </>
        ) : (
          (children ?? label)
        )}
      </Comp>
    );
  }
);
Button.displayName = 'Button';

export { Button, buttonVariants };
