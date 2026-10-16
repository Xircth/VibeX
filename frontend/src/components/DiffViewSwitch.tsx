import { Columns, FileText, Pilcrow, WrapText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@astryxdesign/core/Button';
import { ButtonGroup } from '@astryxdesign/core/ButtonGroup';
import { cn } from '@/lib/utils';
import {
  useDiffViewMode,
  useDiffViewStore,
  useIgnoreWhitespaceDiff,
  useWrapTextDiff,
} from '@/stores/useDiffViewStore';

export const DIFF_VIEW_BUTTON_COUNT = 4;

/**
 * Compute how many button labels (from left to right, 0..4) can fit in the
 * available width for DiffViewSwitch, hiding labels one by one from right to left.
 */
export function computeDiffViewVisibleLabelCount(
  availableWidth: number
): number {
  if (availableWidth <= 0) {
    return DIFF_VIEW_BUTTON_COUNT;
  }
  const iconOnlyGroupWidth = DIFF_VIEW_BUTTON_COUNT * 28;
  const perLabelWidth = 48;

  for (let count = DIFF_VIEW_BUTTON_COUNT; count >= 1; count -= 1) {
    if (availableWidth >= iconOnlyGroupWidth + count * perLabelWidth) {
      return count;
    }
  }
  return 0;
}

type Props = {
  className?: string;
  /**
   * Number of buttons (from left to right, 0..4) that should display their text label.
   * When width shrinks, decreases from 4 -> 3 -> 2 -> 1 -> 0 so labels hide one by one from right to left.
   */
  visibleLabelCount?: number;
};

export default function DiffViewSwitch({
  className,
  visibleLabelCount = DIFF_VIEW_BUTTON_COUNT,
}: Props) {
  const { t } = useTranslation(['app', 'common']);
  const mode = useDiffViewMode();
  const setMode = useDiffViewStore((s) => s.setMode);
  const ignoreWhitespace = useIgnoreWhitespaceDiff();
  const setIgnoreWhitespace = useDiffViewStore((s) => s.setIgnoreWhitespace);
  const wrapText = useWrapTextDiff();
  const setWrapText = useDiffViewStore((s) => s.setWrapText);

  const inlineLabel = t('diffViewSwitch.inlineView');
  const splitLabel = t('diffViewSwitch.splitView');
  const whitespaceLabel = t('diffViewSwitch.ignoreWhitespace');
  const wrapLabel = t('diffViewSwitch.wrapText');

  const isInline = mode === 'unified';
  const isSplit = mode === 'split';

  const showInlineLabel = visibleLabelCount >= 1;
  const showSplitLabel = visibleLabelCount >= 2;
  const showWhitespaceLabel = visibleLabelCount >= 3;
  const showWrapLabel = visibleLabelCount >= 4;

  return (
    <ButtonGroup
      label="Diff view options"
      size="sm"
      data-visible-labels={String(visibleLabelCount)}
      className={cn('diff-view-button-group shrink-0', className)}
    >
      <Button
        label={inlineLabel}
        type="button"
        size="sm"
        variant="secondary"
        aria-pressed={isInline}
        data-active={isInline ? 'true' : 'false'}
        tooltip={inlineLabel}
        onClick={() => setMode('unified')}
        className="diff-toolbar-btn"
      >
        <span className="inline-flex items-center gap-1">
          <FileText
            className={cn(
              'h-3 w-3 shrink-0 transition-colors',
              isInline ? 'text-foreground' : 'text-muted-foreground'
            )}
          />
          {showInlineLabel && (
            <span className="diff-toolbar-btn-label whitespace-nowrap text-[11px]">
              {inlineLabel}
            </span>
          )}
        </span>
      </Button>

      <Button
        label={splitLabel}
        type="button"
        size="sm"
        variant="secondary"
        aria-pressed={isSplit}
        data-active={isSplit ? 'true' : 'false'}
        tooltip={splitLabel}
        onClick={() => setMode('split')}
        className="diff-toolbar-btn"
      >
        <span className="inline-flex items-center gap-1">
          <Columns
            className={cn(
              'h-3 w-3 shrink-0 transition-colors',
              isSplit ? 'text-foreground' : 'text-muted-foreground'
            )}
          />
          {showSplitLabel && (
            <span className="diff-toolbar-btn-label whitespace-nowrap text-[11px]">
              {splitLabel}
            </span>
          )}
        </span>
      </Button>

      <Button
        label={whitespaceLabel}
        type="button"
        size="sm"
        variant="secondary"
        aria-pressed={ignoreWhitespace}
        data-active={ignoreWhitespace ? 'true' : 'false'}
        tooltip={whitespaceLabel}
        onClick={() => setIgnoreWhitespace(!ignoreWhitespace)}
        className="diff-toolbar-btn"
      >
        <span className="inline-flex items-center gap-1">
          <Pilcrow
            className={cn(
              'h-3 w-3 shrink-0 transition-colors',
              ignoreWhitespace ? 'text-foreground' : 'text-muted-foreground'
            )}
          />
          {showWhitespaceLabel && (
            <span className="diff-toolbar-btn-label whitespace-nowrap text-[11px]">
              {whitespaceLabel}
            </span>
          )}
        </span>
      </Button>

      <Button
        label={wrapLabel}
        type="button"
        size="sm"
        variant="secondary"
        aria-pressed={wrapText}
        data-active={wrapText ? 'true' : 'false'}
        tooltip={wrapLabel}
        onClick={() => setWrapText(!wrapText)}
        className="diff-toolbar-btn"
      >
        <span className="inline-flex items-center gap-1">
          <WrapText
            className={cn(
              'h-3 w-3 shrink-0 transition-colors',
              wrapText ? 'text-foreground' : 'text-muted-foreground'
            )}
          />
          {showWrapLabel && (
            <span className="diff-toolbar-btn-label whitespace-nowrap text-[11px]">
              {wrapLabel}
            </span>
          )}
        </span>
      </Button>
    </ButtonGroup>
  );
}
