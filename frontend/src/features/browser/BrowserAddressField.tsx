import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
} from 'react';
import { createPortal } from 'react-dom';
import { NativeSurfaceOcclusionHold } from '@/contexts/WorkspaceOverlayContext';
import { usePortalContainer } from '@/contexts/PortalContainerContext';
import {
  readBrowserAddressHistory,
  suggestBrowserAddresses,
} from './browserAddressHistory';

const MENU_GAP = 4;
const MENU_MAX_HEIGHT = 240;

interface BrowserAddressFieldProps {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onEditingChange?: (editing: boolean) => void;
  inputRef?: Ref<HTMLInputElement>;
}

export function BrowserAddressField({
  value,
  onValueChange,
  onSubmit,
  onEditingChange,
  inputRef,
}: BrowserAddressFieldProps) {
  const container = usePortalContainer();
  const listId = useId();
  const rootRef = useRef<HTMLFormElement>(null);
  const localInputRef = useRef<HTMLInputElement | null>(null);
  const selectAllOnFocusRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [typedSinceFocus, setTypedSinceFocus] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [history, setHistory] = useState(readBrowserAddressHistory);
  const [menuBox, setMenuBox] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);

  const suggestions = suggestBrowserAddresses(
    typedSinceFocus ? value : '',
    history
  );
  const showMenu = open && suggestions.length > 0;

  const assignInputRef = useCallback(
    (node: HTMLInputElement | null) => {
      localInputRef.current = node;
      if (typeof inputRef === 'function') {
        inputRef(node);
      } else if (inputRef) {
        inputRef.current = node;
      }
    },
    [inputRef]
  );

  const closeMenu = useCallback(() => {
    setOpen(false);
    setActiveIndex(-1);
  }, []);

  const refreshMenuPosition = useCallback(() => {
    const input = localInputRef.current;
    if (!input) return;
    const rect = input.getBoundingClientRect();
    setMenuBox({
      top: rect.bottom + MENU_GAP,
      left: rect.left,
      width: rect.width,
    });
  }, []);

  const openMenu = useCallback(() => {
    setHistory(readBrowserAddressHistory());
    refreshMenuPosition();
    setOpen(true);
  }, [refreshMenuPosition]);

  useEffect(() => {
    if (!showMenu) return;
    refreshMenuPosition();
    const onReposition = () => refreshMenuPosition();
    window.addEventListener('resize', onReposition);
    window.addEventListener('scroll', onReposition, true);
    return () => {
      window.removeEventListener('resize', onReposition);
      window.removeEventListener('scroll', onReposition, true);
    };
  }, [refreshMenuPosition, showMenu]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (
        target instanceof Element &&
        target.closest('[data-browser-address-suggestions="true"]')
      ) {
        return;
      }
      closeMenu();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [closeMenu, open]);

  const submit = (nextValue = value) => {
    closeMenu();
    onEditingChange?.(false);
    onSubmit(nextValue);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      if (open) {
        event.preventDefault();
        closeMenu();
      }
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (suggestions.length === 0) return;
      event.preventDefault();
      if (!open) {
        openMenu();
        setActiveIndex(0);
        return;
      }
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((current) => {
        if (current < 0) return delta > 0 ? 0 : suggestions.length - 1;
        return (current + delta + suggestions.length) % suggestions.length;
      });
      return;
    }
    if (event.key === 'Enter' && activeIndex >= 0 && suggestions[activeIndex]) {
      event.preventDefault();
      submit(suggestions[activeIndex]);
    }
  };

  return (
    <form
      ref={rootRef}
      className="relative mx-1 min-w-0 flex-1"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <input
        ref={assignInputRef}
        aria-label="Address"
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-controls={showMenu ? listId : undefined}
        aria-expanded={showMenu}
        aria-activedescendant={
          showMenu && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined
        }
        role="combobox"
        value={value}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        placeholder="Enter a URL"
        className="h-7 w-full rounded-md border border-border bg-background px-2.5 font-mono text-xs text-foreground outline-none transition-colors focus:border-primary/70 focus:ring-1 focus:ring-primary/30"
        onFocus={() => {
          setTypedSinceFocus(false);
          selectAllOnFocusRef.current = true;
          onEditingChange?.(true);
          openMenu();
          requestAnimationFrame(() => localInputRef.current?.select());
        }}
        onMouseUp={(event) => {
          if (!selectAllOnFocusRef.current) return;
          selectAllOnFocusRef.current = false;
          event.preventDefault();
          event.currentTarget.select();
        }}
        onBlur={() => {
          selectAllOnFocusRef.current = false;
          onEditingChange?.(false);
        }}
        onChange={(event) => {
          setTypedSinceFocus(true);
          selectAllOnFocusRef.current = false;
          setActiveIndex(-1);
          onValueChange(event.target.value);
          if (!open) openMenu();
        }}
        onKeyDown={handleKeyDown}
      />
      {showMenu && menuBox
        ? createPortal(
            <div
              id={listId}
              role="listbox"
              aria-label="Address history"
              data-browser-address-suggestions="true"
              className="astryx-select-menu tahoe-popover"
              style={{
                top: menuBox.top,
                left: menuBox.left,
                width: menuBox.width,
                maxHeight: MENU_MAX_HEIGHT,
              }}
              onPointerDown={(event) => event.preventDefault()}
            >
              <NativeSurfaceOcclusionHold />
              {suggestions.map((suggestion, index) => (
                <div
                  key={suggestion}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={activeIndex === index}
                  data-active={activeIndex === index ? 'true' : undefined}
                  className="astryx-select-option font-mono"
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => submit(suggestion)}
                >
                  <span className="astryx-select-option-label">
                    {suggestion}
                  </span>
                </div>
              ))}
            </div>,
            container ?? document.body
          )
        : null}
    </form>
  );
}
