import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, type LucideIcon } from 'lucide-react';
import { NativeSurfaceOcclusionHold } from '@/contexts/WorkspaceOverlayContext';
import { usePortalContainer } from '@/contexts/PortalContainerContext';
import { cn } from '@/lib/utils';
import { clampContextMenuPosition } from './contextMenuHitTest';
import { CONTEXT_MENU_ICON_CLASS, contextMenuIcon } from './contextMenuIcons';
import type {
  ProductContextMenuHeader,
  ProductContextMenuItem,
} from './contextMenuTypes';

let activeMenuEntry: { id: symbol; close: () => void } | null = null;

export function dismissActiveProductContextMenu(exceptId?: symbol) {
  if (activeMenuEntry && activeMenuEntry.id !== exceptId) {
    const previous = activeMenuEntry;
    activeMenuEntry = null;
    previous.close();
  }
}

function isInsideMenuTrigger(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(target.closest('[aria-haspopup="menu"][aria-expanded="true"]'))
  );
}

function isCanvasRightPanSurface(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(target.closest('.canvas-surface')) &&
    !target.closest('.session-hub-sidebar')
  );
}

export function ProductContextMenu({
  x,
  y,
  items,
  onClose,
  header,
  ariaLabel,
  itemRole = 'menuitem',
}: {
  x: number;
  y: number;
  items: ProductContextMenuItem[];
  onClose: () => void;
  header?: ProductContextMenuHeader | null;
  ariaLabel?: string;
  itemRole?: 'menuitem' | 'button';
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const instanceIdRef = useRef<symbol>(Symbol('ProductContextMenu'));
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const portalContainer = usePortalContainer();
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const id = instanceIdRef.current;
    dismissActiveProductContextMenu(id);
    activeMenuEntry = {
      id,
      close: () => onCloseRef.current(),
    };
    return () => {
      if (activeMenuEntry?.id === id) {
        activeMenuEntry = null;
      }
    };
  }, []);

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    setPos(
      clampContextMenuPosition({
        x,
        y,
        menuWidth: el.offsetWidth,
        menuHeight: el.offsetHeight,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      })
    );
  }, [x, y, items, header]);

  useEffect(() => {
    const isInsideMenu = (target: EventTarget | null) =>
      Boolean(
        menuRef.current &&
          target instanceof Node &&
          menuRef.current.contains(target)
      );

    const onPointerDownCapture = (
      event: globalThis.MouseEvent | globalThis.PointerEvent
    ) => {
      if (isInsideMenu(event.target) || isInsideMenuTrigger(event.target)) {
        return;
      }
      if (event.button === 2) {
        if (isCanvasRightPanSurface(event.target)) {
          onCloseRef.current();
        }
        return;
      }
      onCloseRef.current();
    };

    const onClickCapture = (event: globalThis.MouseEvent) => {
      if (isInsideMenu(event.target) || isInsideMenuTrigger(event.target)) {
        return;
      }
      onCloseRef.current();
    };

    const onContextMenuCapture = (event: globalThis.MouseEvent) => {
      if (isInsideMenu(event.target)) {
        return;
      }
      onCloseRef.current();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
      }
    };

    window.addEventListener(
      'pointerdown',
      onPointerDownCapture as EventListener,
      true
    );
    window.addEventListener(
      'mousedown',
      onPointerDownCapture as EventListener,
      true
    );
    window.addEventListener('click', onClickCapture, true);
    window.addEventListener('contextmenu', onContextMenuCapture, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener(
        'pointerdown',
        onPointerDownCapture as EventListener,
        true
      );
      window.removeEventListener(
        'mousedown',
        onPointerDownCapture as EventListener,
        true
      );
      window.removeEventListener('click', onClickCapture, true);
      window.removeEventListener('contextmenu', onContextMenuCapture, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const fallbackContainer =
    typeof document !== 'undefined'
      ? ((document.querySelector('.legacy-design') as HTMLElement | null) ??
        document.body)
      : (null as unknown as HTMLElement);
  const targetContainer = portalContainer ?? fallbackContainer;

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={ariaLabel}
      data-floating-layer="popover"
      className="product-context-menu fixed z-[10050] min-w-44 overflow-visible rounded-md border border-border bg-white p-1 font-sans text-[13px] leading-5 text-popover-foreground shadow-none animate-in fade-in-0 zoom-in-95 duration-100 dark:bg-popover"
      style={{ left: pos.x, top: pos.y, fontFamily: 'var(--font-ui)' }}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <NativeSurfaceOcclusionHold />
      {header ? (
        <>
          <div className="px-2 py-1 text-xs text-muted-foreground">
            <div className="truncate font-medium text-foreground">
              {header.title}
            </div>
            {header.subtitle ? (
              <div className="truncate">{header.subtitle}</div>
            ) : null}
          </div>
          <div
            className="mx-1 my-1 border-t border-border/60"
            role="separator"
          />
        </>
      ) : null}
      <MenuItems items={items} onClose={onClose} itemRole={itemRole} />
    </div>,
    targetContainer
  );
}

function MenuItems({
  items,
  onClose,
  itemRole = 'menuitem',
}: {
  items: ProductContextMenuItem[];
  onClose: () => void;
  itemRole?: 'menuitem' | 'button';
}) {
  const [openSubmenuId, setOpenSubmenuId] = useState<string | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  const cancelScheduledClose = () => {
    if (closeTimerRef.current == null) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  };

  const openSubmenuNow = (id: string) => {
    cancelScheduledClose();
    setOpenSubmenuId(id);
  };

  const closeSubmenuNow = () => {
    cancelScheduledClose();
    setOpenSubmenuId(null);
  };

  const scheduleSubmenuClose = (id: string) => {
    cancelScheduledClose();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setOpenSubmenuId((current) => (current === id ? null : current));
    }, 160);
  };

  useEffect(() => {
    return () => {
      if (closeTimerRef.current != null) {
        window.clearTimeout(closeTimerRef.current);
      }
    };
  }, []);

  const reserveIconSpace = items.some(
    (item) =>
      item.type !== 'separator' &&
      Boolean(item.iconNode || contextMenuIcon(item.id, item.icon))
  );

  return (
    <>
      {items.map((item) => {
        if (item.type === 'separator') {
          return (
            <div
              key={item.id}
              className="mx-1 my-1 border-t border-border/60"
              role="separator"
            />
          );
        }
        if (
          item.type === 'submenu' ||
          ('children' in item &&
            Array.isArray(
              (item as unknown as { children?: unknown[] }).children
            ))
        ) {
          const submenuItem = item as Extract<
            ProductContextMenuItem,
            { type: 'submenu' }
          >;
          return (
            <SubmenuItem
              key={submenuItem.id}
              item={submenuItem}
              open={openSubmenuId === submenuItem.id}
              reserveIconSpace={reserveIconSpace}
              itemRole={itemRole}
              onOpen={() => {
                if (submenuItem.disabled) {
                  closeSubmenuNow();
                  return;
                }
                openSubmenuNow(submenuItem.id);
              }}
              onScheduleClose={() => scheduleSubmenuClose(submenuItem.id)}
              onClose={onClose}
            />
          );
        }
        return (
          <MenuButton
            key={item.id}
            id={item.id}
            label={item.label}
            icon={item.icon}
            iconNode={item.iconNode}
            reserveIconSpace={reserveIconSpace}
            disabled={item.disabled}
            disabledReason={item.disabledReason}
            danger={item.danger}
            itemRole={itemRole}
            onMouseEnter={closeSubmenuNow}
            onClick={() => {
              if (item.disabled) return;
              onClose();
              item.onSelect();
            }}
          />
        );
      })}
    </>
  );
}

function MenuButton({
  id,
  label,
  icon,
  iconNode,
  reserveIconSpace,
  disabled,
  disabledReason,
  danger,
  active,
  trailing,
  itemRole = 'menuitem',
  onMouseEnter,
  onClick,
}: {
  id: string;
  label: string;
  icon?: LucideIcon;
  iconNode?: ReactNode;
  reserveIconSpace?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  danger?: boolean;
  active?: boolean;
  trailing?: ReactNode;
  itemRole?: 'menuitem' | 'button';
  onMouseEnter?: (event: MouseEvent<HTMLButtonElement>) => void;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const Icon = contextMenuIcon(id, icon);
  const pointerDownHandledRef = useRef(false);

  return (
    <button
      type="button"
      role={itemRole === 'button' ? undefined : itemRole}
      disabled={disabled}
      title={disabledReason ?? undefined}
      className={cn(
        'flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 text-left text-[13px] leading-5 transition-colors',
        danger
          ? 'text-destructive hover:bg-destructive/10'
          : 'hover:bg-accent hover:text-accent-foreground',
        active &&
          !disabled &&
          (danger ? 'bg-destructive/10' : 'bg-accent text-accent-foreground'),
        disabled && 'cursor-not-allowed opacity-50 hover:bg-transparent'
      )}
      onMouseEnter={onMouseEnter}
      onPointerDown={(event) => {
        if (event.button === 0 && !disabled) {
          pointerDownHandledRef.current = true;
          onClick(event);
        }
      }}
      onClick={(event) => {
        if (pointerDownHandledRef.current) {
          pointerDownHandledRef.current = false;
          return;
        }
        if (!disabled) {
          onClick(event);
        }
      }}
    >
      {iconNode ? (
        <span
          className={cn(
            CONTEXT_MENU_ICON_CLASS,
            'flex items-center justify-center'
          )}
          aria-hidden="true"
        >
          {iconNode}
        </span>
      ) : Icon ? (
        <Icon className={CONTEXT_MENU_ICON_CLASS} aria-hidden="true" />
      ) : reserveIconSpace ? (
        <span className={CONTEXT_MENU_ICON_CLASS} aria-hidden="true" />
      ) : null}
      <span className="min-w-0 flex-1">{label}</span>
      {trailing}
    </button>
  );
}

function SubmenuItem({
  item,
  open,
  reserveIconSpace,
  itemRole,
  onOpen,
  onScheduleClose,
  onClose,
}: {
  item: Extract<ProductContextMenuItem, { type: 'submenu' }>;
  open: boolean;
  reserveIconSpace?: boolean;
  itemRole?: 'menuitem' | 'button';
  onOpen: () => void;
  onScheduleClose: () => void;
  onClose: () => void;
}) {
  return (
    <div className="relative" onMouseEnter={onOpen} onMouseLeave={onScheduleClose}>
      <MenuButton
        id={item.id}
        label={item.label}
        icon={item.icon}
        iconNode={item.iconNode}
        reserveIconSpace={reserveIconSpace}
        disabled={item.disabled}
        disabledReason={item.disabledReason}
        danger={item.danger}
        active={open}
        itemRole={itemRole}
        trailing={<ChevronRight className={CONTEXT_MENU_ICON_CLASS} />}
        onMouseEnter={onOpen}
        onClick={(event) => {
          event.stopPropagation();
          if (item.disabled) return;
          if (item.onSelect) {
            onClose();
            item.onSelect();
            return;
          }
          onOpen();
        }}
      />
      {open ? (
        <div
          className="absolute left-full top-0 z-10 -ml-2 min-h-full pl-2"
          data-testid="product-context-submenu-bridge"
          onMouseEnter={onOpen}
        >
          <div
            className="product-context-menu min-w-44 overflow-visible rounded-md border border-border bg-white p-1 font-sans text-[13px] leading-5 text-popover-foreground shadow-none animate-in fade-in-0 zoom-in-95 duration-100 dark:bg-popover"
            style={{ fontFamily: 'var(--font-ui)' }}
            role="menu"
          >
            <MenuItems items={item.children} onClose={onClose} itemRole={itemRole} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
