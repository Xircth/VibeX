'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, X } from 'lucide-react';

import { usePortalContainer } from '@/contexts/PortalContainerContext';
import { cn } from '@/lib/utils';

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
  /** Renders a trailing action (for example edit/delete) inside each option. */
  renderOptionAction?: (option: AstryxSelectOption) => React.ReactNode;
  className?: string;
}

interface MenuPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

const TRIGGER_GAP = 4;
const MENU_MAX_HEIGHT = 300;

function getMenuPosition(trigger: HTMLElement): MenuPosition {
  const rect = trigger.getBoundingClientRect();
  const spaceBelow = window.innerHeight - rect.bottom - TRIGGER_GAP;
  const spaceAbove = rect.top - TRIGGER_GAP;
  const openAbove = spaceBelow < 160 && spaceAbove > spaceBelow;
  const maxHeight = Math.min(
    MENU_MAX_HEIGHT,
    Math.max(spaceBelow, spaceAbove) - TRIGGER_GAP
  );
  return {
    top: openAbove
      ? rect.top - TRIGGER_GAP - maxHeight
      : rect.bottom + TRIGGER_GAP,
    left: rect.left,
    width: rect.width,
    maxHeight: Math.max(maxHeight, 64),
  };
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
  renderOptionAction,
  className,
}: AstryxSelectProps) {
  const container = usePortalContainer();
  const rootRef = React.useRef<HTMLSpanElement>(null);
  const triggerRef = React.useRef<HTMLDivElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const menuId = React.useId();
  const [open, setOpen] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(-1);
  const [position, setPosition] = React.useState<MenuPosition | null>(null);
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

  const reposition = React.useCallback(() => {
    if (triggerRef.current) setPosition(getMenuPosition(triggerRef.current));
  }, []);

  React.useEffect(() => {
    if (!open) return;
    reposition();
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open, reposition]);

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
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

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
      setOpen(false);
    },
    [onChange, options]
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
          setOpen(true);
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
          setOpen(true);
        }
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (open) {
          selectOption(activeIndex);
        } else {
          setOpen(true);
        }
        break;
      case 'Escape':
        if (open) {
          event.preventDefault();
          setOpen(false);
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
    <span ref={rootRef} className={cn('astryx-select', className)}>
      <div
        ref={triggerRef}
        id={id}
        role="button"
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
            setOpen(false);
          } else {
            setActiveIndex(selectedIndex);
            setOpen(true);
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
            tabIndex={-1}
            aria-label={ariaLabel ? `${ariaLabel}（清除）` : '清除'}
            className="astryx-select-clear"
            onClick={(event) => {
              event.stopPropagation();
              onChange('');
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
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
              className="astryx-select-menu tahoe-popover"
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
                setOpen(false);
                triggerRef.current?.focus();
              }}
            >
              {options.length === 0 ? (
                <div className="astryx-select-empty">{placeholder}</div>
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
                    <span className="astryx-select-option-label">
                      {option.label}
                    </span>
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
                          setOpen(false);
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
