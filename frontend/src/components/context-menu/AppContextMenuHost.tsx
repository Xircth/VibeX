import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  readClipboardViaBridge,
  writeClipboardViaBridge,
} from '@/vscode/bridge';
import { ProductContextMenu } from './ProductContextMenu';
import {
  getContextMenuSelectedText,
  isEditableContextMenuTarget,
  isForbiddenContextMenuTarget,
  isReadOnlyEditable,
} from './contextMenuHitTest';
import type {
  OpenProductContextMenuInput,
  ProductContextMenuItem,
} from './contextMenuTypes';

type AppContextMenuValue = {
  open: (input: OpenProductContextMenuInput) => void;
  close: () => void;
  openSurfaceMenu: (
    event: ReactMouseEvent | MouseEvent,
    items: ProductContextMenuItem[]
  ) => boolean;
};

const AppContextMenuContext = createContext<AppContextMenuValue | null>(null);

function cutFromInput(el: HTMLInputElement | HTMLTextAreaElement) {
  const start = el.selectionStart ?? 0;
  const end = el.selectionEnd ?? 0;
  if (end <= start) return;
  const selected = el.value.slice(start, end);
  void writeClipboardViaBridge(selected);
  const next = el.value.slice(0, start) + el.value.slice(end);
  el.value = next;
  el.setSelectionRange(start, start);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function pasteIntoInput(
  el: HTMLInputElement | HTMLTextAreaElement,
  text: string
) {
  const start = el.selectionStart ?? 0;
  const end = el.selectionEnd ?? 0;
  el.value = el.value.slice(0, start) + text + el.value.slice(end);
  const caret = start + text.length;
  el.setSelectionRange(caret, caret);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function buildEditMenu(
  target: EventTarget | null,
  t: (key: string) => string
): ProductContextMenuItem[] {
  const selected = getContextMenuSelectedText(target);
  const readOnly = isReadOnlyEditable(target);
  const canCopy = selected.length > 0;
  const canCut = canCopy && !readOnly;
  const canPaste = !readOnly;
  const items: ProductContextMenuItem[] = [];
  if (canCut) {
    items.push({
      id: 'cut',
      label: t('contextMenu.cut'),
      onSelect: () => {
        if (
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement
        ) {
          cutFromInput(target);
        } else {
          const text = getContextMenuSelectedText(target);
          void writeClipboardViaBridge(text);
          document.execCommand('delete');
        }
      },
    });
  }
  items.push({
    id: 'copy',
    label: t('contextMenu.copy'),
    disabled: !canCopy,
    onSelect: () => {
      void writeClipboardViaBridge(selected);
    },
  });
  if (canPaste) {
    items.push({
      id: 'paste',
      label: t('contextMenu.paste'),
      onSelect: () => {
        void readClipboardViaBridge().then((text) => {
          if (
            target instanceof HTMLInputElement ||
            target instanceof HTMLTextAreaElement
          ) {
            target.focus();
            pasteIntoInput(target, text);
            return;
          }
          if (target instanceof HTMLElement) {
            target.focus();
            document.execCommand('insertText', false, text);
          }
        });
      },
    });
  }
  return items;
}

function withSelectionCopy(
  items: ProductContextMenuItem[],
  target: EventTarget | null,
  copyLabel: string
): ProductContextMenuItem[] {
  const selected = getContextMenuSelectedText(target).trim();
  if (!selected) return items;
  if (
    items[0] &&
    items[0].type !== 'submenu' &&
    items[0].type !== 'separator' &&
    items[0].id === 'copy'
  ) {
    return items;
  }
  return [
    {
      id: 'copy-selection',
      label: copyLabel,
      onSelect: () => {
        void writeClipboardViaBridge(selected);
      },
    },
    { type: 'separator', id: 'copy-selection-sep' },
    ...items,
  ];
}

export function AppContextMenuHost({ children }: { children: ReactNode }) {
  const { t } = useTranslation('common');
  const [menu, setMenu] = useState<OpenProductContextMenuInput | null>(null);
  const targetRef = useRef<EventTarget | null>(null);

  const close = useCallback(() => setMenu(null), []);

  const open = useCallback((input: OpenProductContextMenuInput) => {
    setMenu(input.items.length > 0 ? input : null);
  }, []);

  const openSurfaceMenu = useCallback(
    (event: ReactMouseEvent | MouseEvent, items: ProductContextMenuItem[]) => {
      if (
        isForbiddenContextMenuTarget(event.target) ||
        isEditableContextMenuTarget(event.target)
      ) {
        return false;
      }
      event.preventDefault();
      event.stopPropagation();
      targetRef.current = event.target;
      open({
        x: event.clientX,
        y: event.clientY,
        items: withSelectionCopy(items, event.target, t('contextMenu.copy')),
      });
      return true;
    },
    [open, t]
  );

  useEffect(() => {
    const onCapture = (event: MouseEvent) => {
      event.preventDefault();
    };
    const onBubble = (event: MouseEvent) => {
      if (isForbiddenContextMenuTarget(event.target)) {
        close();
        return;
      }
      if (isEditableContextMenuTarget(event.target)) {
        targetRef.current = event.target;
        open({
          x: event.clientX,
          y: event.clientY,
          items: buildEditMenu(event.target, t),
        });
        return;
      }
      close();
    };
    document.addEventListener('contextmenu', onCapture, true);
    document.addEventListener('contextmenu', onBubble);
    return () => {
      document.removeEventListener('contextmenu', onCapture, true);
      document.removeEventListener('contextmenu', onBubble);
    };
  }, [close, open, t]);

  const value = useMemo(
    () => ({ open, close, openSurfaceMenu }),
    [close, open, openSurfaceMenu]
  );

  return (
    <AppContextMenuContext.Provider value={value}>
      {children}
      {menu ? (
        <ProductContextMenu
          x={menu.x}
          y={menu.y}
          items={menu.items}
          onClose={close}
        />
      ) : null}
    </AppContextMenuContext.Provider>
  );
}

const NOOP_MENU: AppContextMenuValue = {
  open: () => undefined,
  close: () => undefined,
  openSurfaceMenu: (event) => {
    if (
      isForbiddenContextMenuTarget(event.target) ||
      isEditableContextMenuTarget(event.target)
    ) {
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    return true;
  },
};

export function useAppContextMenu(): AppContextMenuValue {
  return useContext(AppContextMenuContext) ?? NOOP_MENU;
}
