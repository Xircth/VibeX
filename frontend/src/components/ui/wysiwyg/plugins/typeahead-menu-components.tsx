import {
  useRef,
  useEffect,
  useMemo,
  useCallback,
  useState,
  type ReactNode,
  type MouseEvent,
  type CSSProperties,
} from 'react';

// --- Headless Compound Components ---

type VerticalSide = 'top' | 'bottom';

interface TypeaheadPlacement {
  side: VerticalSide;
  maxHeight: number;
  left: number;
  bottom: number;
  width: number;
}

const VIEWPORT_PADDING = 16;
const MENU_SIDE_OFFSET = 6;
const MAX_MENU_HEIGHT = 360;
const MIN_MENU_HEIGHT = 48;
const MIN_MENU_WIDTH = 320;
const MAX_MENU_WIDTH = 520;

function getViewportHeight() {
  return window.innerHeight;
}

function getAvailableSpaceAbove(anchorRect: DOMRect) {
  const viewportHeight = getViewportHeight();
  return Math.min(
    viewportHeight - VIEWPORT_PADDING - MENU_SIDE_OFFSET,
    anchorRect.top - VIEWPORT_PADDING - MENU_SIDE_OFFSET
  );
}

function clampMenuHeight(height: number) {
  return Math.min(
    MAX_MENU_HEIGHT,
    Math.max(MIN_MENU_HEIGHT, Math.floor(height))
  );
}

function isUsableRect(rect: DOMRect) {
  return rect.width > 0 || rect.height > 0 || rect.top > 0 || rect.left > 0;
}

/**
 * Get the bounding rect for the Lexical typeahead anchor.
 * Lexical already positions this anchor at the current trigger text; using the
 * global selection first can point at stale editor positions in Dockview/WebView.
 */
function getCursorRect(anchorEl: HTMLElement): DOMRect {
  const anchorRect = anchorEl.getBoundingClientRect();
  if (isUsableRect(anchorRect)) {
    return anchorRect;
  }

  try {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0).cloneRange();
      range.collapse(false);
      const rect =
        range.getClientRects().item(range.getClientRects().length - 1) ??
        range.getBoundingClientRect();
      if (isUsableRect(rect)) {
        return rect;
      }
    }
  } catch {
    // fall through
  }
  return anchorRect;
}

function getTypeaheadSurfaceRect(anchorEl: HTMLElement): DOMRect {
  const activeEditorSurface = document.activeElement?.closest(
    '[data-typeahead-surface="editor"]'
  );
  if (activeEditorSurface instanceof HTMLElement) {
    const activeEditorSurfaceRect = activeEditorSurface.getBoundingClientRect();
    if (isUsableRect(activeEditorSurfaceRect)) {
      return activeEditorSurfaceRect;
    }
  }

  const selectionEditorSurface = window
    .getSelection()
    ?.anchorNode?.parentElement?.closest('[data-typeahead-surface="editor"]');
  if (selectionEditorSurface instanceof HTMLElement) {
    const selectionEditorSurfaceRect =
      selectionEditorSurface.getBoundingClientRect();
    if (isUsableRect(selectionEditorSurfaceRect)) {
      return selectionEditorSurfaceRect;
    }
  }

  const activeComposerSurface = document.activeElement?.closest(
    '[data-typeahead-surface="composer"]'
  );
  if (activeComposerSurface instanceof HTMLElement) {
    const activeSurfaceRect = activeComposerSurface.getBoundingClientRect();
    if (isUsableRect(activeSurfaceRect)) {
      return activeSurfaceRect;
    }
  }

  const activeSurface = document.activeElement?.closest(
    '[data-typeahead-surface]'
  );
  if (activeSurface instanceof HTMLElement) {
    const activeSurfaceRect = activeSurface.getBoundingClientRect();
    if (isUsableRect(activeSurfaceRect)) {
      return activeSurfaceRect;
    }
  }

  const selectionSurface = window
    .getSelection()
    ?.anchorNode?.parentElement?.closest('[data-typeahead-surface]');
  if (selectionSurface instanceof HTMLElement) {
    const selectionSurfaceRect = selectionSurface.getBoundingClientRect();
    if (isUsableRect(selectionSurfaceRect)) {
      return selectionSurfaceRect;
    }
  }

  const surface = anchorEl.closest('[data-typeahead-surface]');
  if (surface instanceof HTMLElement) {
    const surfaceRect = surface.getBoundingClientRect();
    if (isUsableRect(surfaceRect)) {
      return surfaceRect;
    }
  }

  return getCursorRect(anchorEl);
}

function getPlacement(anchorEl: HTMLElement): TypeaheadPlacement {
  const surfaceRect = getTypeaheadSurfaceRect(anchorEl);
  const side: VerticalSide = 'top';
  const width = Math.max(
    MIN_MENU_WIDTH,
    Math.min(MAX_MENU_WIDTH, Math.floor(surfaceRect.width))
  );

  return {
    side,
    maxHeight: clampMenuHeight(getAvailableSpaceAbove(surfaceRect)),
    left: surfaceRect.left,
    bottom: getViewportHeight() - surfaceRect.top + MENU_SIDE_OFFSET,
    width,
  };
}

interface TypeaheadMenuProps {
  anchorEl: HTMLElement;
  children: ReactNode;
}

function TypeaheadMenuRoot({ anchorEl, children }: TypeaheadMenuProps) {
  const [placement, setPlacement] = useState<TypeaheadPlacement>(() =>
    getPlacement(anchorEl)
  );

  const syncPlacement = useCallback(() => {
    setPlacement((previous) => {
      const next = getPlacement(anchorEl);
      if (
        next.side === previous.side &&
        next.maxHeight === previous.maxHeight &&
        next.left === previous.left &&
        next.bottom === previous.bottom &&
        next.width === previous.width
      ) {
        return previous;
      }
      return next;
    });
  }, [anchorEl]);

  useEffect(() => {
    syncPlacement();

    const updateOnFrame = () => {
      window.requestAnimationFrame(syncPlacement);
    };

    window.addEventListener('resize', updateOnFrame);
    window.addEventListener('scroll', updateOnFrame, true);
    const observer = new ResizeObserver(updateOnFrame);
    observer.observe(anchorEl);

    return () => {
      window.removeEventListener('resize', updateOnFrame);
      window.removeEventListener('scroll', updateOnFrame, true);
      observer.disconnect();
    };
  }, [anchorEl, syncPlacement]);

  // Reposition during normal React renders too (e.g. typeahead cursor movement).
  useEffect(() => {
    syncPlacement();
  });

  const contentStyle = useMemo(
    () =>
      ({
        '--typeahead-menu-max-height': `${placement.maxHeight}px`,
        position: 'fixed',
        left: `${placement.left}px`,
        width: `${placement.width}px`,
        bottom: `${placement.bottom}px`,
        zIndex: 20000,
      }) as CSSProperties,
    [placement.bottom, placement.left, placement.maxHeight, placement.width]
  );

  return (
    <div style={contentStyle}>
      <div className="w-full overflow-hidden rounded-lg border border-border/80 bg-popover/95 p-1 text-popover-foreground shadow-xl backdrop-blur-md">
        {children}
      </div>
    </div>
  );
}

function TypeaheadMenuHeader({ children }: { children: ReactNode }) {
  return (
    <div className="border-b border-border/60 px-2.5 py-2">
      <div className="flex items-center gap-2 text-[11px] font-medium text-muted-foreground">
        {children}
      </div>
    </div>
  );
}

function TypeaheadMenuScrollArea({ children }: { children: ReactNode }) {
  return (
    <div
      className="overflow-auto py-0.5"
      style={{ maxHeight: 'var(--typeahead-menu-max-height, 40vh)' }}
    >
      {children}
    </div>
  );
}

function TypeaheadMenuSectionHeader({ children }: { children: ReactNode }) {
  return (
    <div className="px-2.5 pb-1.5 pt-2 text-[11px] font-medium text-muted-foreground">
      {children}
    </div>
  );
}

function TypeaheadMenuDivider() {
  return <div className="mx-1 my-1 border-t border-border/60" />;
}

function TypeaheadMenuEmpty({ children }: { children: ReactNode }) {
  return (
    <div className="px-2.5 py-2 text-sm text-muted-foreground">{children}</div>
  );
}

interface TypeaheadMenuActionProps {
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}

function TypeaheadMenuAction({
  onClick,
  disabled = false,
  children,
}: TypeaheadMenuActionProps) {
  const mouseSelectionRef = useRef(false);

  const commitSelection = useCallback(() => {
    if (!disabled) {
      onClick();
    }
  }, [disabled, onClick]);

  const handleMouseDown = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      if (event.button !== 0 || disabled) return;
      mouseSelectionRef.current = true;
      commitSelection();
    },
    [commitSelection, disabled]
  );

  const handleClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      if (mouseSelectionRef.current) {
        mouseSelectionRef.current = false;
        return;
      }
      commitSelection();
    },
    [commitSelection]
  );

  return (
    <button
      type="button"
      className="w-full rounded-md px-2.5 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
      onMouseDown={handleMouseDown}
      onClick={handleClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

interface TypeaheadMenuItemProps {
  isSelected: boolean;
  index: number;
  setHighlightedIndex: (index: number) => void;
  onClick: () => void;
  children: ReactNode;
  setRefElement?: (element: HTMLElement | null) => void;
}

function TypeaheadMenuItemComponent({
  isSelected,
  index,
  setHighlightedIndex,
  onClick,
  children,
  setRefElement,
}: TypeaheadMenuItemProps) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const lastMousePositionRef = useRef<{ x: number; y: number } | null>(null);
  const mouseSelectionRef = useRef(false);

  const assignRef = useCallback(
    (element: HTMLButtonElement | null) => {
      ref.current = element;
      setRefElement?.(element);
    },
    [setRefElement]
  );

  useEffect(() => {
    if (isSelected && ref.current) {
      ref.current.scrollIntoView({ block: 'nearest' });
    }
  }, [isSelected]);

  const handleMouseMove = (event: MouseEvent<HTMLButtonElement>) => {
    const pos = { x: event.clientX, y: event.clientY };
    const last = lastMousePositionRef.current;
    if (!last || last.x !== pos.x || last.y !== pos.y) {
      lastMousePositionRef.current = pos;
      setHighlightedIndex(index);
    }
  };

  const handleMouseDown = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      if (event.button !== 0) return;
      mouseSelectionRef.current = true;
      onClick();
    },
    [onClick]
  );

  const handleClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      if (mouseSelectionRef.current) {
        mouseSelectionRef.current = false;
        return;
      }
      onClick();
    },
    [onClick]
  );

  return (
    <button
      ref={assignRef}
      type="button"
      role="option"
      aria-selected={isSelected}
      className={`w-full rounded-md px-2.5 py-2 text-left text-sm transition-colors ${
        isSelected
          ? 'bg-accent text-accent-foreground shadow-sm'
          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
      }`}
      onMouseMove={handleMouseMove}
      onMouseDown={handleMouseDown}
      onClick={handleClick}
    >
      {children}
    </button>
  );
}

export const TypeaheadMenu = Object.assign(TypeaheadMenuRoot, {
  Header: TypeaheadMenuHeader,
  ScrollArea: TypeaheadMenuScrollArea,
  SectionHeader: TypeaheadMenuSectionHeader,
  Divider: TypeaheadMenuDivider,
  Empty: TypeaheadMenuEmpty,
  Action: TypeaheadMenuAction,
  Item: TypeaheadMenuItemComponent,
});
