import { memo, useEffect, useRef } from 'react';
import { Plus, Minus, Undo2, Copy } from 'lucide-react';

export interface ContextMenuAction {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
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
      menuRef.current.style.left = `${x - rect.width}px`;
    }
    if (rect.bottom > vh) {
      menuRef.current.style.top = `${y - rect.height}px`;
    }
  }, [x, y]);

  return (
    <div
      ref={menuRef}
      className="fixed z-50 min-w-[160px] bg-popover border border-border rounded-md shadow-lg py-1 animate-in fade-in zoom-in-95 duration-100"
      style={{ left: x, top: y }}
    >
      {actions.map((action, i) => (
        <button
          key={i}
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
        >
          {action.icon}
          <span>{action.label}</span>
        </button>
      ))}
    </div>
  );
});

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
