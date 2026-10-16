'use client';

import * as React from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import { SelectorOption } from '@astryxdesign/core/Selector';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';

type SelectorOptionProps = React.ComponentProps<typeof SelectorOption>;

import { cn } from '@/lib/utils';
import {
  PRODUCT_MENU_CONTENT_CLASS,
  PRODUCT_MENU_SEPARATOR_CLASS,
  PRODUCT_OPTION_ITEM_CLASS,
} from '@/components/ui/product-menu-classes';
import { usePortalContainer } from '@/contexts/PortalContainerContext';
import {
  NativeSurfaceOcclusionHold,
  useRevealAfterOverlayReady,
} from '@/contexts/WorkspaceOverlayContext';

const Select = SelectPrimitive.Root;

const SelectGroup = SelectPrimitive.Group;

const SelectValue = SelectPrimitive.Value;

const SelectTrigger = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(
      'raised-control flex h-8 w-full items-center justify-between rounded-[var(--_field-radius,var(--radius-element,var(--radius)))] border border-[var(--color-border-emphasized,var(--border-content))] bg-[var(--color-background-surface,var(--surface-control))] px-2.5 py-1 text-xs text-foreground transition-[border-color,background-color,box-shadow] data-[placeholder]:text-muted-foreground hover:enabled:not(:focus-visible):[box-shadow:inset_0_0_0_2px_color-mix(in_srgb,var(--color-border-emphasized,var(--border-strong))_30%,transparent)] focus:outline-none focus-visible:border-[var(--color-accent,hsl(var(--primary)))] focus-visible:[box-shadow:inset_0_0_0_2px_var(--color-accent-muted,hsl(var(--primary)/0.22))] disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1',
      className
    )}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon asChild>
      <ChevronDown className="h-3.5 w-3.5 opacity-50" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
));
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName;

const SelectScrollUpButton = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.ScrollUpButton>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollUpButton>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollUpButton
    ref={ref}
    className={cn(
      'flex cursor-default items-center justify-center py-1',
      className
    )}
    {...props}
  >
    <ChevronUp className="h-4 w-4" />
  </SelectPrimitive.ScrollUpButton>
));
SelectScrollUpButton.displayName = SelectPrimitive.ScrollUpButton.displayName;

const SelectScrollDownButton = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.ScrollDownButton>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollDownButton>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollDownButton
    ref={ref}
    className={cn(
      'flex cursor-default items-center justify-center py-1',
      className
    )}
    {...props}
  >
    <ChevronDown className="h-4 w-4" />
  </SelectPrimitive.ScrollDownButton>
));
SelectScrollDownButton.displayName =
  SelectPrimitive.ScrollDownButton.displayName;

const SelectContent = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(
  (
    {
      className,
      children,
      position = 'popper',
      sideOffset = 4,
      collisionPadding = 8,
      ...props
    },
    ref
  ) => {
    const container = usePortalContainer();
    const revealed = useRevealAfterOverlayReady();
    // item-aligned pins the selected row on the trigger and clips the rest.
    const placement = position === 'item-aligned' ? 'popper' : position;
    return (
      <SelectPrimitive.Portal container={container}>
        <SelectPrimitive.Content
          ref={ref}
          data-floating-layer="popover"
          className={cn(
            PRODUCT_MENU_CONTENT_CLASS,
            'relative z-[10000] max-h-[--radix-select-content-available-height] min-w-[8rem] overflow-y-auto overflow-x-hidden p-0 outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-[--radix-select-content-transform-origin]',
            revealed ? null : 'invisible opacity-0',
            className
          )}
          position={placement}
          sideOffset={sideOffset}
          collisionPadding={collisionPadding}
          {...props}
        >
          <NativeSurfaceOcclusionHold />
          <SelectScrollUpButton />
          <SelectPrimitive.Viewport
            className={cn(
              'flex flex-col p-1.5',
              placement === 'popper' &&
                'w-full min-w-[var(--radix-select-trigger-width)]'
            )}
          >
            {children}
          </SelectPrimitive.Viewport>
          <SelectScrollDownButton />
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    );
  }
);
SelectContent.displayName = SelectPrimitive.Content.displayName;

const SelectLabel = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Label>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Label
    ref={ref}
    className={cn('px-2.5 py-1.5 text-xs font-semibold', className)}
    {...props}
  />
));
SelectLabel.displayName = SelectPrimitive.Label.displayName;

type SelectItemProps = React.ComponentPropsWithoutRef<
  typeof SelectPrimitive.Item
> &
  Partial<Pick<SelectorOptionProps, 'icon' | 'description' | 'endContent'>>;

const SelectItem = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Item>,
  SelectItemProps
>(({ className, children, icon, description, endContent, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      PRODUCT_OPTION_ITEM_CLASS,
      'astryx-select-option w-full cursor-default justify-between data-[state=checked]:font-medium',
      className
    )}
    {...props}
  >
    <SelectorOption
      icon={icon}
      label={<SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>}
      description={description}
      endContent={endContent}
      className="astryx-select-option-label"
    />

    <SelectPrimitive.ItemIndicator>
      <Check
        aria-hidden="true"
        className="astryx-select-option-check h-3.5 w-3.5"
      />
    </SelectPrimitive.ItemIndicator>
  </SelectPrimitive.Item>
));
SelectItem.displayName = SelectPrimitive.Item.displayName;

const SelectSeparator = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Separator
    ref={ref}
    className={cn(PRODUCT_MENU_SEPARATOR_CLASS, className)}
    {...props}
  />
));
SelectSeparator.displayName = SelectPrimitive.Separator.displayName;

export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectLabel,
  SelectItem,
  SelectSeparator,
  SelectScrollUpButton,
  SelectScrollDownButton,
  SelectorOption,
  type SelectorOptionProps,
};
