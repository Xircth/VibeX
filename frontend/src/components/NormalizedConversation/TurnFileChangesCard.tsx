import { useMemo, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowRight,
  ChevronRight,
  Edit,
  FilePlus2,
  Trash2,
  Undo2,
} from 'lucide-react';
import type { ConversationFileChangeSummary } from 'shared/types';
import { Button } from '@/components/ui/button';
import { useExpandable } from '@/stores/useExpandableStore';
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';
import { useGitDiffNavigationStore } from '@/stores/useGitDiffNavigationStore';
import { cn } from '@/lib/utils';
import { DEFAULT_COLLAPSE_PREFERENCES } from '@/lib/conversationCollapsePreferences';

function changeKindIcon(changeKind: string) {
  switch (changeKind) {
    case 'added':
    case 'created':
      return (
        <FilePlus2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      );
    case 'deleted':
      return <Trash2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
    case 'renamed':
      return (
        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      );
    default:
      return <Edit className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
  }
}

/**
 * Collapsible per-turn "files changed" summary rendered at the end of the turn
 * that produced the diff (checkpoint diff), restoring the pre-event-sourcing
 * card: header with total counts + Undo, expandable per-file rows that jump to
 * the diff panel.
 */
export function TurnFileChangesCard({
  summary,
  expansionKey,
  defaultExpanded = !DEFAULT_COLLAPSE_PREFERENCES.filesChangedCollapsed,
  onUndo,
  undoDisabled = false,
}: {
  summary: ConversationFileChangeSummary;
  expansionKey: string;
  defaultExpanded?: boolean;
  onUndo?: (() => void) | null;
  undoDisabled?: boolean;
}) {
  const { t } = useTranslation(['conversation', 'common']);
  const [expanded, setExpanded] = useExpandable(expansionKey, defaultExpanded);
  const { openDiffPreview } = usePanelActionsContext();
  const focusDiffPath = useGitDiffNavigationStore((state) => state.focusPath);

  const totals = useMemo(
    () =>
      summary.files.reduce(
        (acc, file) => ({
          additions: acc.additions + Number(file.additions ?? 0),
          deletions: acc.deletions + Number(file.deletions ?? 0),
        }),
        { additions: 0, deletions: 0 }
      ),
    [summary.files]
  );

  if (summary.files.length === 0) return null;

  const handleOpenDiffFile = (event: MouseEvent<HTMLElement>, path: string) => {
    event.stopPropagation();
    openDiffPreview();
    focusDiffPath(path);
  };

  return (
    <div className="mb-2 mt-1 overflow-hidden rounded-md border border-border bg-background">
      <div className="flex items-center gap-3 px-3 py-2 text-sm">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => setExpanded()}
        >
          <ChevronRight
            className={cn(
              'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
              expanded && 'rotate-90'
            )}
          />
          <div className="min-w-0 flex-1">
            <span className="font-medium text-foreground">
              {t('conversation:turnFileChanges.filesChanged', {
                count: summary.files.length,
              })}
            </span>
            <span className="ml-2 font-mono text-xs text-[hsl(var(--success))]">
              +{totals.additions}
            </span>
            <span className="ml-1 font-mono text-xs text-destructive">
              -{totals.deletions}
            </span>
          </div>
        </button>
        {onUndo ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2"
            onClick={onUndo}
            disabled={undoDisabled}
          >
            <Undo2 className="h-3.5 w-3.5" />
            <span>{t('conversation:turnFileChanges.undo')}</span>
          </Button>
        ) : null}
      </div>

      {expanded ? (
        <div className="px-2 pb-2">
          {summary.files.map((file) => (
            <div
              key={`${file.change_kind}:${file.path}`}
              className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted/40"
            >
              {changeKindIcon(file.change_kind)}
              <span
                className="min-w-0 flex-1 cursor-pointer truncate font-mono text-xs text-foreground hover:text-primary hover:underline"
                onClick={(event) => handleOpenDiffFile(event, file.path)}
              >
                {file.old_path ? `${file.old_path} -> ${file.path}` : file.path}
              </span>
              {file.additions != null ? (
                <span className="font-mono text-xs text-[hsl(var(--success))]">
                  +{Number(file.additions)}
                </span>
              ) : null}
              {file.deletions != null ? (
                <span className="font-mono text-xs text-destructive">
                  -{Number(file.deletions)}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
