import type { ReactNode } from 'react';
import {
  Bot,
  Clock,
  Download,
  Expand,
  Folder,
  LayoutGrid,
  Maximize2,
  MessageSquarePlus,
  Minimize2,
  Plus,
  SquareDashed,
  Trash2,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

const DOCK_BUTTON_SHAPE =
  'inline-flex size-8 shrink-0 items-center justify-center rounded-full transition-colors';

const DOCK_BUTTON = `${DOCK_BUTTON_SHAPE} text-muted-foreground hover:bg-[var(--surface-control-hover)] hover:text-foreground disabled:pointer-events-none disabled:opacity-40`;

const DOCK_BUTTON_DANGER = `${DOCK_BUTTON_SHAPE} text-muted-foreground hover:bg-destructive/10 hover:text-destructive`;

function DockButton({
  label,
  onClick,
  disabled,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={danger ? DOCK_BUTTON_DANGER : DOCK_BUTTON}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}

function DockDivider() {
  return (
    <span className="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden="true" />
  );
}

export function SessionCanvasDock({
  selectedCount,
  selectedExpanded,
  selectedIsGroup = false,
  selectedGroupCollapsed = false,
  onToggleGroupCollapse,
  onCreateGroup,
  onCreateSession,
  onImportByProject,
  onImportByRecent,
  onImportByAgent,
  onFitView,
  onAutoArrange,
  onExpandSelection,
  onCollapseSelection,
  onDeleteSelection,
}: {
  selectedCount: number;
  selectedExpanded: boolean;
  selectedIsGroup?: boolean;
  selectedGroupCollapsed?: boolean;
  onToggleGroupCollapse?: () => void;
  onCreateGroup: () => void;
  onCreateSession: () => void;
  onImportByProject: () => void;
  onImportByRecent: () => void;
  onImportByAgent: () => void;
  onFitView: () => void;
  onAutoArrange: () => void;
  onExpandSelection: () => void;
  onCollapseSelection: () => void;
  onDeleteSelection: () => void;
}) {
  const { t } = useTranslation(['tasks']);

  return (
    <div
      className={cn(
        'flex items-center gap-0.5 rounded-full border border-border',
        'bg-[var(--surface-card-strong)] p-1 shadow-[var(--shadow-popover)]'
      )}
      role="toolbar"
      aria-label={t('hubCanvas.dock')}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={DOCK_BUTTON}
            aria-label={t('hubCanvas.createMenu')}
            title={t('hubCanvas.createMenu')}
          >
            <Plus className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" side="top">
          <DropdownMenuItem onSelect={onCreateGroup}>
            <SquareDashed className="size-4 text-muted-foreground" />
            {t('hubCanvas.createEmptyGroup')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onCreateSession}>
            <MessageSquarePlus className="size-4 text-muted-foreground" />
            {t('hubCanvas.createSession')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={DOCK_BUTTON}
            aria-label={t('hubCanvas.importMenu')}
            title={t('hubCanvas.importMenu')}
          >
            <Download className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" side="top">
          <DropdownMenuItem onSelect={onImportByProject}>
            <Folder className="size-4 text-muted-foreground" />
            {t('hubCanvas.importByProject')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onImportByRecent}>
            <Clock className="size-4 text-muted-foreground" />
            {t('hubCanvas.importByRecent')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onImportByAgent}>
            <Bot className="size-4 text-muted-foreground" />
            {t('hubCanvas.importByAgent')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DockButton label={t('hubCanvas.fitView')} onClick={onFitView}>
        <Maximize2 className="size-4" />
      </DockButton>
      <DockButton label={t('hubCanvas.autoArrange')} onClick={onAutoArrange}>
        <LayoutGrid className="size-4" />
      </DockButton>
      {selectedCount > 0 ? (
        <>
          <DockDivider />
          {selectedIsGroup ? (
            <DockButton
              label={
                selectedGroupCollapsed
                  ? t('hubCanvas.expandGroupFrame')
                  : t('hubCanvas.collapseGroupFrame')
              }
              onClick={() => onToggleGroupCollapse?.()}
            >
              {selectedGroupCollapsed ? (
                <Expand className="size-4" />
              ) : (
                <Minimize2 className="size-4" />
              )}
            </DockButton>
          ) : selectedExpanded ? (
            <DockButton
              label={t('hubCanvas.collapseCard')}
              onClick={onCollapseSelection}
            >
              <Minimize2 className="size-4" />
            </DockButton>
          ) : (
            <DockButton
              label={t('hubCanvas.expandCard')}
              onClick={onExpandSelection}
            >
              <Expand className="size-4" />
            </DockButton>
          )}
          <DockButton
            label={t('hubCanvas.removeCard')}
            danger
            onClick={onDeleteSelection}
          >
            <Trash2 className="size-4" />
          </DockButton>
        </>
      ) : null}
    </div>
  );
}
