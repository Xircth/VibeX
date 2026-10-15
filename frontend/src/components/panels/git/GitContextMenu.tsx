import { memo, useMemo } from 'react';
import { Plus, Minus, Undo2, Copy } from 'lucide-react';
import { ProductContextMenu } from '@/components/context-menu/ProductContextMenu';
import type { ProductContextMenuItem } from '@/components/context-menu/contextMenuTypes';

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
  const items = useMemo(() => {
    const result: ProductContextMenuItem[] = [];
    let lastGroup: string | undefined = undefined;

    const mapAction = (
      action: ContextMenuAction,
      index: number,
      prefix: string
    ): ProductContextMenuItem => {
      const id = `${prefix}-${index}-${action.label}`;
      if (action.submenu && action.submenu.length > 0) {
        return {
          id,
          type: 'submenu',
          label: action.label,
          iconNode: action.icon,
          disabled: action.disabled,
          disabledReason: action.disabledReason,
          danger: action.danger,
          children: action.submenu.map((sub, subIdx) =>
            mapAction(sub, subIdx, `${id}-sub`)
          ),
        };
      }
      return {
        id,
        label: action.label,
        iconNode: action.icon,
        disabled: action.disabled,
        disabledReason: action.disabledReason,
        danger: action.danger,
        onSelect: action.onClick,
      };
    };

    actions.forEach((action, idx) => {
      if (idx > 0 && action.group !== lastGroup) {
        result.push({
          id: `sep-${idx}`,
          type: 'separator',
        });
      }
      lastGroup = action.group;
      result.push(mapAction(action, idx, 'git'));
    });

    return result;
  }, [actions]);

  return <ProductContextMenu x={x} y={y} items={items} onClose={onClose} />;
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
