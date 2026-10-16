'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import { SelectorOption } from '@astryxdesign/core/Selector';
import { Check, ChevronDown, X } from 'lucide-react';

import { usePortalContainer } from '@/contexts/PortalContainerContext';
import { NativeSurfaceOcclusionHold } from '@/contexts/WorkspaceOverlayContext';
import { cn } from '@/lib/utils';
import { useOptionMenuPlacement } from '@/components/ui/option-menu-position';

export { getMenuPosition } from '@/components/ui/option-menu-position';

export type SelectorOptionProps = React.ComponentProps<typeof SelectorOption>;
export { SelectorOption };

/**
 * Dropdown selector for choosing a single value from a list of options.
 *
 * Modeled after the Astryx `Selector` component (astryx.atmeta.com/components)
 * and adapted to React 18 + the VibeX Tahoe design tokens. It renders a
 * bordered input-style trigger, a portal-based listbox popover, keyboard
 * navigation, and an optional clear affordance, so forms no longer depend on
 * native OS-rendered `<select>` popups.
 */

export interface AstryxSelectOption {
  value: string;
  label: string;
  icon?: SelectorOptionProps['icon'];
  description?: React.ReactNode;
  endContent?: React.ReactNode;
  disabled?: boolean;
}

interface AstryxSelectProps {
  id?: string;
  value: string;
  options: AstryxSelectOption[];
  onChange: (value: string) => void;
  /** Placeholder shown when no value is selected. */
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  /** Shows a clear (×) button when a value is selected. */
  hasClear?: boolean;
  /** Custom option body renderer (for example `<SelectorOption ... />`). */
  renderOption?: (option: AstryxSelectOption) => React.ReactNode;
  /** Renders a trailing action (for example edit/delete) inside each option. */
  renderOptionAction?: (option: AstryxSelectOption) => React.ReactNode;
  /** `compact` shrinks the trigger to fit dense toolbar and tab-bar chrome. */
  size?: 'default' | 'compact';
  className?: string;
  /** Label shown in the open menu when `options` is empty. */
  emptyLabel?: string;
  onOpenChange?: (open: boolean) => void;
  /**
   * When false, opening the menu does not hide native CEF surfaces. Use for
   * chrome that stays outside the page.
   */
  occludeNativeSurface?: boolean;
  /** Prefer opening the menu above the trigger so it stays in HTML chrome. */
  preferAbove?: boolean;
}

export function AstryxSelect({
  id,
  value,
  options,
  onChange,
  placeholder,
  ariaLabel,
  disabled = false,
  hasClear = false,
  renderOption,
  renderOptionAction,
  size = 'default',
  className,
  emptyLabel,
  onOpenChange,
  occludeNativeSurface = true,
  preferAbove = false,
}: AstryxSelectProps) {
  const container = usePortalContainer();
  const rootRef = React.useRef<HTMLSpanElement>(null);
  const triggerRef = React.useRef<HTMLDivElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const menuId = React.useId();
  const [open, setOpen] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(-1);
  const position = useOptionMenuPlacement(
    open,
    triggerRef,
    menuRef,
    preferAbove
  );
  const typeAheadRef = React.useRef({ text: '', at: 0 });

  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  const selectableIndices = React.useMemo(
    () =>
      options
        .map((option, index) => (option.disabled ? -1 : index))
        .filter((index) => index >= 0),
    [options]
  );

  const closeMenu = React.useCallback(() => {
    setOpen(false);
    onOpenChange?.(false);
  }, [onOpenChange]);

  const openMenu = React.useCallback(() => {
    setOpen(true);
    onOpenChange?.(true);
  }, [onOpenChange]);

  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        rootRef.current?.contains(target) ||
        menuRef.current?.contains(target)
      ) {
        return;
      }
      closeMenu();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [closeMenu, open]);

  React.useEffect(() => {
    if (!open) return;
    const active = menuRef.current?.querySelector<HTMLElement>(
      '[data-active="true"]'
    );
    active?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, open]);

  const moveActive = React.useCallback(
    (delta: number) => {
      setActiveIndex((current) => {
        if (selectableIndices.length === 0) return -1;
        if (current < 0) {
          return delta > 0
            ? selectableIndices[0]
            : selectableIndices[selectableIndices.length - 1];
        }
        const positionInList = selectableIndices.indexOf(current);
        const next = positionInList + delta;
        if (next < 0) return selectableIndices[selectableIndices.length - 1];
        if (next >= selectableIndices.length) return selectableIndices[0];
        return selectableIndices[next];
      });
    },
    [selectableIndices]
  );

  const selectOption = React.useCallback(
    (index: number) => {
      const option = options[index];
      if (!option || option.disabled) return;
      onChange(option.value);
      closeMenu();
    },
    [closeMenu, onChange, options]
  );

  const handleTriggerKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (open) {
          moveActive(1);
        } else {
          const index = selectableIndices.indexOf(selectedIndex);
          setActiveIndex(
            selectableIndices[(index + 1) % selectableIndices.length]
          );
          openMenu();
        }
        break;
      case 'ArrowUp':
        event.preventDefault();
        if (open) {
          moveActive(-1);
        } else {
          const index = selectableIndices.indexOf(selectedIndex);
          setActiveIndex(
            selectableIndices[
              (index - 1 + selectableIndices.length) % selectableIndices.length
            ]
          );
          openMenu();
        }
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (open) {
          selectOption(activeIndex);
        } else {
          openMenu();
        }
        break;
      case 'Escape':
        if (open) {
          event.preventDefault();
          closeMenu();
        }
        break;
      case 'Home':
        if (open) {
          event.preventDefault();
          if (selectableIndices.length > 0)
            setActiveIndex(selectableIndices[0]);
        }
        break;
      case 'End':
        if (open) {
          event.preventDefault();
          if (selectableIndices.length > 0) {
            setActiveIndex(selectableIndices[selectableIndices.length - 1]);
          }
        }
        break;
      default:
        if (open && event.key.length === 1) {
          const now = Date.now();
          const buffer =
            now - typeAheadRef.current.at < 500
              ? typeAheadRef.current.text
              : '';
          const text = buffer + event.key.toLowerCase();
          typeAheadRef.current = { text, at: now };
          const match = options.findIndex((option) =>
            option.label.toLowerCase().startsWith(text)
          );
          if (match >= 0) setActiveIndex(match);
        }
    }
  };

  return (
    <span
      ref={rootRef}
      className={cn(
        'astryx-select',
        size === 'compact' && 'astryx-select--compact',
        className
      )}
    >
      <div
        ref={triggerRef}
        id={id}
        role="combobox"
        tabIndex={disabled ? -1 : 0}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        aria-disabled={disabled || undefined}
        className={cn('astryx-select-trigger', open && 'is-open')}
        onClick={() => {
          if (disabled) return;
          if (open) {
            closeMenu();
          } else {
            setActiveIndex(selectedIndex);
            openMenu();
          }
        }}
        onKeyDown={(event) => {
          if (disabled) return;
          handleTriggerKeyDown(event);
        }}
      >
        <span
          className={cn(
            'astryx-select-trigger-label',
            !selected && 'is-placeholder'
          )}
        >
          {selected ? selected.label : placeholder}
        </span>
        {hasClear && selected ? (
          <span
            role="button"
            tabIndex={disabled ? -1 : 0}
            aria-label={ariaLabel ? `${ariaLabel}（清除）` : '清除'}
            className="astryx-select-clear"
            onClick={(event) => {
              event.stopPropagation();
              onChange('');
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                event.stopPropagation();
                onChange('');
              }
            }}
          >
            <X aria-hidden="true" />
          </span>
        ) : null}
        <ChevronDown aria-hidden="true" className="astryx-select-chevron" />
      </div>
      {open && position
        ? createPortal(
            <div
              ref={menuRef}
              id={menuId}
              role="listbox"
              aria-label={ariaLabel}
              data-floating-layer="popover"
              className="astryx-select-menu product-context-menu border border-border bg-white font-sans text-[13px] leading-5 text-popover-foreground shadow-none dark:bg-popover"
              style={{
                top: position.top,
                left: position.left,
                width: position.width,
                maxHeight: position.maxHeight,
              }}
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return;
                event.preventDefault();
                closeMenu();
                triggerRef.current?.focus();
              }}
            >
              {occludeNativeSurface ? <NativeSurfaceOcclusionHold /> : null}
              {options.length === 0 ? (
                <div className="astryx-select-empty">
                  {emptyLabel ?? placeholder}
                </div>
              ) : (
                options.map((option, index) => (
                  <div
                    key={option.value}
                    role="option"
                    aria-selected={option.value === value}
                    data-active={activeIndex === index ? 'true' : undefined}
                    data-disabled={option.disabled ? 'true' : undefined}
                    className="astryx-select-option"
                    onClick={() => selectOption(index)}
                    onMouseEnter={() => {
                      if (!option.disabled) setActiveIndex(index);
                    }}
                  >
                    {renderOption ? (
                      renderOption(option)
                    ) : (
                      <SelectorOption
                        icon={option.icon}
                        label={option.label}
                        description={option.description}
                        endContent={option.endContent}
                        className="astryx-select-option-label"
                      />
                    )}
                    {option.value === value ? (
                      <Check
                        aria-hidden="true"
                        className="astryx-select-option-check"
                      />
                    ) : null}
                    {renderOptionAction ? (
                      <span
                        className="astryx-select-option-action"
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation();
                          closeMenu();
                        }}
                      >
                        {renderOptionAction(option)}
                      </span>
                    ) : null}
                  </div>
                ))
              )}
            </div>,
            container ?? document.body
          )
        : null}
    </span>
  );
}
