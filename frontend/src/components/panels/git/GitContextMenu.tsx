import { memo, useEffect, useRef, useState } from 'react';
import { Plus, Minus, Undo2, Copy, ChevronRight } from 'lucide-react';

export interface ContextMenuAction {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  group?: string;
  submenu?: ContextMenuAction[];
}

interface GitContextMenuProps {
  x: number;
  y: number;
  actions: ContextMenuAction[];
  onClose: () => void;
}

export const GitContextMenu = memo(function GitContextMenu({
  x,
  y,
  actions,
  onClose,
}: GitContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [openSubmenu, setOpenSubmenu] = useState<number | null>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  // Adjust position to stay within viewport
  useEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    if (rect.right > vw) {
      menuRef.current.style.left = `${Math.max(8, x - rect.width)}px`;
    }
    if (rect.bottom > vh) {
      menuRef.current.style.top = `${Math.max(8, y - rect.height)}px`;
    }
  }, [x, y]);

  // Group actions by group field
  const groupedActions = groupActionsByField(actions);

  return (
    <div
      ref={menuRef}
      className="fixed z-50 min-w-[180px] max-w-[320px] bg-popover border border-border rounded-lg shadow-lg py-1 animate-in fade-in zoom-in-95 duration-100"
      style={{ left: x, top: y }}
      role="menu"
    >
      {groupedActions.map((group, gi) => (
        <div key={gi}>
          {gi > 0 && (
            <div className="mx-2 my-1 border-t border-border/40" />
          )}
          {group.map((action, ai) => {
            const globalIdx = groupedActions
              .slice(0, gi)
              .reduce((s, g) => s + g.length, 0) + ai;

            if (action.submenu && action.submenu.length > 0) {
              return (
                <SubmenuItem
                  key={globalIdx}
                  action={action}
                  isOpen={openSubmenu === globalIdx}
                  onToggle={() =>
                    setOpenSubmenu(openSubmenu === globalIdx ? null : globalIdx)
                  }
                  onClose={onClose}
                />
              );
            }

            return (
              <button
                key={globalIdx}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors disabled:opacity-40 ${
                  action.danger
                    ? 'text-destructive hover:bg-destructive/10'
                    : 'text-popover-foreground hover:bg-accent'
                }`}
                onClick={() => {
                  action.onClick();
                  onClose();
                }}
                disabled={action.disabled}
                title={action.disabledReason ?? undefined}
                role="menuitem"
              >
                {action.icon}
                <span className="flex-1 text-left">{action.label}</span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
});

const SubmenuItem = memo(function SubmenuItem({
  action,
  isOpen,
  onToggle,
  onClose,
}: {
  action: ContextMenuAction;
  isOpen: boolean;
  onToggle: () => void;
  onClose: () => void;
}) {
  const itemRef = useRef<HTMLDivElement>(null);

  return (
    <div ref={itemRef} className="relative">
      <button
        className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors ${
          action.danger
            ? 'text-destructive hover:bg-destructive/10'
            : 'text-popover-foreground hover:bg-accent'
        }`}
        onClick={onToggle}
        disabled={action.disabled}
        title={action.disabledReason ?? undefined}
        role="menuitem"
      >
        {action.icon}
        <span className="flex-1 text-left">{action.label}</span>
        <ChevronRight className={`h-3 w-3 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
      </button>
      {isOpen && action.submenu && (
        <div className="ml-2 border-l border-border/30 pl-1">
          {action.submenu.map((sub, i) => (
            <button
              key={i}
              className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors disabled:opacity-40 ${
                sub.danger
                  ? 'text-destructive hover:bg-destructive/10'
                  : 'text-popover-foreground hover:bg-accent'
              }`}
              onClick={() => {
                sub.onClick();
                onClose();
              }}
              disabled={sub.disabled}
              title={sub.disabledReason ?? undefined}
              role="menuitem"
            >
              {sub.icon}
              <span>{sub.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
});

function groupActionsByField(actions: ContextMenuAction[]): ContextMenuAction[][] {
  const groups: ContextMenuAction[][] = [];
  let currentGroup: ContextMenuAction[] = [];
  let currentGroupName: string | undefined;

  for (const action of actions) {
    if (action.group !== currentGroupName && currentGroup.length > 0) {
      groups.push(currentGroup);
      currentGroup = [];
    }
    currentGroupName = action.group;
    currentGroup.push(action);
  }
  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }
  return groups;
}

export function buildFileContextActions({
  section,
  filePaths,
  onStageFile,
  onUnstageFile,
  onRevertFile,
  onCopyPath,
}: {
  section: 'staged' | 'unstaged';
  filePaths: string[];
  onStageFile?: (path: string) => void;
  onUnstageFile?: (path: string) => void;
  onRevertFile?: (path: string) => void;
  onCopyPath?: (path: string) => void;
}): ContextMenuAction[] {
  const count = filePaths.length;
  const suffix = count > 1 ? ` (${count})` : '';
  const actions: ContextMenuAction[] = [];

  if (section === 'unstaged') {
    if (onStageFile) {
      actions.push({
        label: `Stage${suffix}`,
        icon: <Plus className="h-3 w-3" />,
        onClick: () => filePaths.forEach((p) => onStageFile(p)),
      });
    }
    if (onRevertFile) {
      actions.push({
        label: `Discard${suffix}`,
        icon: <Undo2 className="h-3 w-3" />,
        onClick: () => filePaths.forEach((p) => onRevertFile(p)),
        danger: true,
      });
    }
  }

  if (section === 'staged') {
    if (onUnstageFile) {
      actions.push({
        label: `Unstage${suffix}`,
        icon: <Minus className="h-3 w-3" />,
        onClick: () => filePaths.forEach((p) => onUnstageFile(p)),
      });
    }
  }

  if (onCopyPath && filePaths.length === 1) {
    actions.push({
      label: 'Copy Path',
      icon: <Copy className="h-3 w-3" />,
      onClick: () => onCopyPath(filePaths[0]),
    });
  }

  return actions;
}
