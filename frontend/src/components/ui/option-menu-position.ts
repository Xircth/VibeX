import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import type { RefObject } from 'react';

/**
 * Place a whole option list on the side of the trigger that can show it.
 * The menu is never shifted so the selected row sits on the trigger: that
 * anchor clips the rows on the other side when the trigger is near a window
 * edge.
 */
export const OPTION_MENU_GAP = 4;
export const OPTION_MENU_VIEWPORT_PAD = 8;
export const OPTION_MENU_MAX_HEIGHT = 320;

export interface OptionMenuPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

export function getMenuPosition(
  triggerRect: Pick<DOMRect, 'top' | 'bottom' | 'left' | 'width'>,
  preferAbove = false,
  viewportHeight = typeof window === 'undefined' ? 0 : window.innerHeight,
  contentHeight = 0,
  viewportWidth = typeof window === 'undefined' ? 0 : window.innerWidth,
  contentWidth = triggerRect.width
): OptionMenuPosition {
  const spaceBelow = Math.max(
    0,
    viewportHeight -
      triggerRect.bottom -
      OPTION_MENU_GAP -
      OPTION_MENU_VIEWPORT_PAD
  );
  const spaceAbove = Math.max(
    0,
    triggerRect.top - OPTION_MENU_GAP - OPTION_MENU_VIEWPORT_PAD
  );
  const knownHeight =
    contentHeight > 0 ? contentHeight : OPTION_MENU_MAX_HEIGHT;
  const fitsBelow = knownHeight <= spaceBelow;
  const fitsAbove = knownHeight <= spaceAbove;

  let openAbove: boolean;
  if (fitsBelow && fitsAbove) {
    openAbove = preferAbove;
  } else if (fitsBelow) {
    openAbove = false;
  } else if (fitsAbove) {
    openAbove = true;
  } else {
    openAbove = spaceAbove > spaceBelow;
  }

  const available = openAbove ? spaceAbove : spaceBelow;
  let maxHeight = Math.min(knownHeight, available);
  const viewportBudget = Math.max(
    0,
    viewportHeight - OPTION_MENU_VIEWPORT_PAD * 2
  );
  if (maxHeight < Math.min(knownHeight, viewportBudget)) {
    // Neither side can hold the list. Cover the viewport and scroll.
    maxHeight = Math.min(knownHeight, viewportBudget);
  }

  const unclampedTop =
    openAbove && maxHeight <= spaceAbove
      ? triggerRect.top - OPTION_MENU_GAP - maxHeight
      : openAbove
        ? OPTION_MENU_VIEWPORT_PAD
        : triggerRect.bottom + OPTION_MENU_GAP;
  const top = clamp(
    unclampedTop,
    OPTION_MENU_VIEWPORT_PAD,
    Math.max(
      OPTION_MENU_VIEWPORT_PAD,
      viewportHeight - OPTION_MENU_VIEWPORT_PAD - maxHeight
    )
  );

  const width = Math.min(
    Math.max(contentWidth, triggerRect.width),
    Math.max(0, viewportWidth - OPTION_MENU_VIEWPORT_PAD * 2)
  );
  const left = clamp(
    triggerRect.left,
    OPTION_MENU_VIEWPORT_PAD,
    Math.max(
      OPTION_MENU_VIEWPORT_PAD,
      viewportWidth - OPTION_MENU_VIEWPORT_PAD - width
    )
  );

  return { top, left, width, maxHeight };
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

function samePosition(
  current: OptionMenuPosition | null,
  next: OptionMenuPosition
): boolean {
  return (
    current !== null &&
    Math.abs(current.top - next.top) < 1 &&
    Math.abs(current.left - next.left) < 1 &&
    Math.abs(current.width - next.width) < 1 &&
    Math.abs(current.maxHeight - next.maxHeight) < 1
  );
}

/** Keep an open option menu inside the viewport as the trigger moves. */
export function useOptionMenuPlacement(
  open: boolean,
  triggerRef: RefObject<HTMLElement | null>,
  menuRef: RefObject<HTMLElement | null>,
  preferAbove = false
): OptionMenuPosition | null {
  const [position, setPosition] = useState<OptionMenuPosition | null>(null);

  const reposition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const menu = menuRef.current;
    const triggerRect = trigger.getBoundingClientRect();
    const next = getMenuPosition(
      triggerRect,
      preferAbove,
      window.innerHeight,
      menu?.scrollHeight ?? 0,
      window.innerWidth,
      menu && menu.offsetWidth > 0 ? menu.offsetWidth : triggerRect.width
    );
    setPosition((current) => (samePosition(current, next) ? current : next));
  }, [menuRef, preferAbove, triggerRef]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    reposition();
  }, [open, reposition]);

  useLayoutEffect(() => {
    if (!open || !position) return;
    reposition();
  }, [open, position, reposition]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener('scroll', reposition, {
      capture: true,
      passive: true,
    });
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open, reposition]);

  return open ? position : null;
}

/**
 * Pull an anchored listbox popover fully into the viewport. Astryx Selector
 * shifts the popover with a negative margin so the selected row covers the
 * trigger; that margin is replaced here with a block placement.
 */
export function fitOptionMenuElement(popover: HTMLElement): void {
  const listbox = popover.querySelector<HTMLElement>('[role="listbox"]');
  // Composer trigger menus use aria-selected as the keyboard highlight and
  // open above the caret. They are not a persisted option list.
  if (!listbox || listbox.classList.contains('astryx-trigger-menu')) return;
  const listboxId = listbox.id;
  if (!listboxId) return;
  const trigger = document.querySelector<HTMLElement>(
    `[aria-controls="${CSS.escape(listboxId)}"]`
  );
  if (!trigger) return;

  popover.style.setProperty('max-height', 'none', 'important');
  const contentHeight = popover.scrollHeight;
  const triggerRect = trigger.getBoundingClientRect();
  const position = getMenuPosition(
    triggerRect,
    false,
    window.innerHeight,
    contentHeight,
    window.innerWidth,
    Math.max(popover.offsetWidth, triggerRect.width)
  );

  popover.style.setProperty('position', 'fixed', 'important');
  popover.style.setProperty('top', `${position.top}px`, 'important');
  popover.style.setProperty('left', `${position.left}px`, 'important');
  popover.style.setProperty('right', 'auto', 'important');
  popover.style.setProperty('bottom', 'auto', 'important');
  popover.style.setProperty('margin', '0', 'important');
  popover.style.setProperty('width', `${position.width}px`, 'important');
  popover.style.setProperty(
    'max-height',
    `${position.maxHeight}px`,
    'important'
  );
  popover.style.setProperty('overflow', 'auto', 'important');
  popover.style.setProperty('position-area', 'none', 'important');
  popover.style.setProperty('position-try-fallbacks', 'none', 'important');
  popover.style.setProperty('transform', 'none', 'important');
}

export function useOptionMenuViewportFit(): void {
  useEffect(() => {
    const positioned = new Set<HTMLElement>();

    const fit = (popover: HTMLElement) => {
      if (!popover.querySelector('[role="listbox"]')) return;
      fitOptionMenuElement(popover);
      positioned.add(popover);
    };

    const onToggle = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.hasAttribute('popover')) {
        return;
      }
      const state = (event as Event & { newState?: string }).newState;
      if (state === 'open') {
        // The library's selected-item offset lands in a layout effect. Fit
        // again on the next frame so that shift cannot leave rows off-screen.
        requestAnimationFrame(() => {
          fit(target);
          requestAnimationFrame(() => fit(target));
        });
        return;
      }
      positioned.delete(target);
    };

    const refit = () => {
      for (const popover of positioned) {
        if (!popover.isConnected) {
          positioned.delete(popover);
          continue;
        }
        fit(popover);
      }
    };

    document.addEventListener('toggle', onToggle, true);
    window.addEventListener('resize', refit);
    window.addEventListener('scroll', refit, true);
    return () => {
      document.removeEventListener('toggle', onToggle, true);
      window.removeEventListener('resize', refit);
      window.removeEventListener('scroll', refit, true);
    };
  }, []);
}
