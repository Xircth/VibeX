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
  return Math.min(MAX_MENU_HEIGHT, Math.max(MIN_MENU_HEIGHT, Math.floor(height)));
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

  const activeSurface = document.activeElement?.closest('[data-typeahead-surface]');
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
      <div className="w-full overflow-hidden rounded-md border bg-background p-0 shadow-md">
        {children}
      </div>
    </div>
  );
}

function TypeaheadMenuHeader({ children }: { children: ReactNode }) {
  return (
    <div className="px-3 py-2 border-b bg-muted/30">
      <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
        {children}
      </div>
    </div>
  );
}

function TypeaheadMenuScrollArea({ children }: { children: ReactNode }) {
  return (
    <div
      className="py-1 overflow-auto"
      style={{ maxHeight: 'var(--typeahead-menu-max-height, 40vh)' }}
    >
      {children}
    </div>
  );
}

function TypeaheadMenuSectionHeader({ children }: { children: ReactNode }) {
  return (
    <div className="px-3 py-1 text-xs font-semibold text-muted-foreground uppercase">
      {children}
    </div>
  );
}

function TypeaheadMenuDivider() {
  return <div className="border-t my-1" />;
}

function TypeaheadMenuEmpty({ children }: { children: ReactNode }) {
  return (
    <div className="px-3 py-2 text-sm text-muted-foreground">{children}</div>
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
  return (
    <button
      type="button"
      className="w-full px-3 py-2 text-left text-sm border-l-2 border-l-transparent text-muted-foreground hover:bg-muted hover:text-high disabled:opacity-50 disabled:cursor-not-allowed"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
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
}

function TypeaheadMenuItemComponent({
  isSelected,
  index,
  setHighlightedIndex,
  onClick,
  children,
}: TypeaheadMenuItemProps) {
  const ref = useRef<HTMLDivElement>(null);
  const lastMousePositionRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (isSelected && ref.current) {
      ref.current.scrollIntoView({ block: 'nearest' });
    }
  }, [isSelected]);

  const handleMouseMove = (event: MouseEvent<HTMLDivElement>) => {
    const pos = { x: event.clientX, y: event.clientY };
    const last = lastMousePositionRef.current;
    if (!last || last.x !== pos.x || last.y !== pos.y) {
      lastMousePositionRef.current = pos;
      setHighlightedIndex(index);
    }
  };

  return (
    <div
      ref={ref}
      className={`px-3 py-2 cursor-pointer text-sm border-l-2 ${
        isSelected
          ? 'bg-secondary border-l-brand text-high'
          : 'hover:bg-muted border-l-transparent text-muted-foreground'
      }`}
      onMouseDown={(event) => event.preventDefault()}
      onMouseMove={handleMouseMove}
      onClick={onClick}
    >
      {children}
    </div>
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
