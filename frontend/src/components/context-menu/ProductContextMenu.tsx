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
import type { ProductContextMenuItem } from './contextMenuTypes';

export function ProductContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: ProductContextMenuItem[];
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const portalContainer = usePortalContainer();
  const [pos, setPos] = useState({ x, y });

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
  }, [x, y, items]);

  useEffect(() => {
    const close = () => onClose();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('click', close);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      className="product-context-menu tahoe-popover fixed z-[10050] min-w-[220px] overflow-visible rounded-xl p-1.5 font-sans text-sm text-popover-foreground"
      style={{ left: pos.x, top: pos.y, fontFamily: 'var(--font-ui)' }}
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.preventDefault()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <NativeSurfaceOcclusionHold />
      <MenuItems items={items} onClose={onClose} />
    </div>,
    portalContainer ?? document.body
  );
}

function MenuItems({
  items,
  onClose,
}: {
  items: ProductContextMenuItem[];
  onClose: () => void;
}) {
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
        if (item.type === 'submenu') {
          return <SubmenuItem key={item.id} item={item} onClose={onClose} />;
        }
        return (
          <MenuButton
            key={item.id}
            id={item.id}
            label={item.label}
            icon={item.icon}
            disabled={item.disabled}
            danger={item.danger}
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
  disabled,
  danger,
  trailing,
  onClick,
}: {
  id: string;
  label: string;
  icon?: LucideIcon;
  disabled?: boolean;
  danger?: boolean;
  trailing?: ReactNode;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const Icon = contextMenuIcon(id, icon);
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      className={cn(
        'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors',
        danger
          ? 'text-destructive hover:bg-destructive/10'
          : 'hover:bg-muted/70',
        disabled && 'cursor-not-allowed opacity-50 hover:bg-transparent'
      )}
      onClick={onClick}
    >
      {Icon ? (
        <Icon className={CONTEXT_MENU_ICON_CLASS} aria-hidden="true" />
      ) : (
        <span className={CONTEXT_MENU_ICON_CLASS} aria-hidden="true" />
      )}
      <span className="min-w-0 flex-1">{label}</span>
      {trailing}
    </button>
  );
}

function SubmenuItem({
  item,
  onClose,
}: {
  item: Extract<ProductContextMenuItem, { type: 'submenu' }>;
  onClose: () => void;
}) {
  const [open, setOpen] = useState(false);
  const closeTimerRef = useRef<number | null>(null);

  const cancelClose = () => {
    if (closeTimerRef.current == null) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  };

  const openNow = () => {
    cancelClose();
    setOpen(true);
  };

  const closeSoon = () => {
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setOpen(false);
    }, 160);
  };

  useEffect(() => {
    return () => {
      if (closeTimerRef.current != null) {
        window.clearTimeout(closeTimerRef.current);
      }
    };
  }, []);

  return (
    <div className="relative" onMouseEnter={openNow} onMouseLeave={closeSoon}>
      <MenuButton
        id={item.id}
        label={item.label}
        icon={item.icon}
        trailing={<ChevronRight className={CONTEXT_MENU_ICON_CLASS} />}
        onClick={(event) => {
          event.stopPropagation();
          openNow();
        }}
      />
      {open ? (
        <div
          className="absolute left-full top-0 z-10 -ml-2 min-h-full pl-2"
          data-testid="product-context-submenu-bridge"
          onMouseEnter={openNow}
        >
          <div
            className="product-context-menu tahoe-popover min-w-[180px] overflow-visible rounded-xl p-1.5 font-sans text-sm text-popover-foreground"
            style={{ fontFamily: 'var(--font-ui)' }}
            role="menu"
          >
            <MenuItems items={item.children} onClose={onClose} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
