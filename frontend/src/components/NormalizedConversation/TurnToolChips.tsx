import {
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import FileIcon from '@/components/FileIcon';
import { cn } from '@/lib/utils';
import { useExpandableGroup } from '@/stores/useExpandableStore';
import { useNestedWheel } from './nestedScroll';
import type { TurnToolDiffChip } from './turnToolDiffChips';

export type TurnToolIconKind =
  | 'think'
  | 'write'
  | 'run'
  | 'read'
  | 'search'
  | 'web'
  | 'agent'
  | 'tool';

export type TurnToolStatus = 'pending' | 'running' | 'complete' | 'error';

export type TurnToolChipItem = {
  key: string;
  index: number;
  icon: TurnToolIconKind;
  label: string;
  chip?: ReactNode;
  monoChip?: boolean;
  additions?: number;
  deletions?: number;
  status: TurnToolStatus;
  errorMessage?: string;
  resultDetail?: ReactNode;
  isDetailExpanded?: boolean;
  onDetailExpandedChange?: (expanded: boolean) => void;
};

const INITIAL_VISIBLE_DIFF_CHIPS = 5;
const PREVIEW_CARD_WIDTH = 304;
const PREVIEW_VIEWPORT_MARGIN = 8;
const PREVIEW_ANCHOR_GAP = 6;

const CHEVRON_ICON = (
  <path
    d="M6 9l6 6 6-6"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
  />
);

const TOOL_CHIP_ICONS: Record<TurnToolIconKind, ReactNode> = {
  think: (
    <path
      d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z"
      fill="currentColor"
    />
  ),
  write: (
    <g
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
    </g>
  ),
  run: (
    <g
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 17l6-5-6-5" />
      <path d="M12 19h8" />
    </g>
  ),
  read: (
    <g
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6M8 13h8M8 17h5" />
    </g>
  ),
  search: (
    <g
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.8-3.8" />
    </g>
  ),
  web: (
    <g
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M3.6 9h16.8M3.6 15h16.8" />
      <path d="M12 3a14.5 14.5 0 0 1 0 18 14.5 14.5 0 0 1 0-18z" />
    </g>
  ),
  agent: (
    <g
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="4" y="7" width="16" height="12" rx="3" />
      <path d="M12 3v4M9 13h.01M15 13h.01" />
    </g>
  ),
  tool: (
    <g
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4l-5.6 5.6a1.8 1.8 0 0 0 2.6 2.6l5.6-5.6a4 4 0 0 0 5.4-5.4l-2.4 2.4-2.2-.4-.4-2.2z" />
    </g>
  ),
};

export function TurnToolChipRow({
  icon,
  label,
  chip,
  monoChip = false,
  additions,
  deletions,
  showInlineDiffCounts = false,
  status = 'complete',
  errorMessage,
  detail,
  expanded = false,
  onExpandedChange,
  ariaControls,
}: {
  icon: TurnToolIconKind;
  label: string;
  chip?: ReactNode;
  monoChip?: boolean;
  additions?: number;
  deletions?: number;
  showInlineDiffCounts?: boolean;
  status?: TurnToolStatus;
  errorMessage?: string;
  detail?: ReactNode;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  ariaControls?: string;
}) {
  const generatedDetailId = useId();
  const detailId = ariaControls ?? generatedDetailId;
  const isExpandable = Boolean(onExpandedChange && (detail || ariaControls));
  const isRunning = status === 'running' || status === 'pending';
  const isError = status === 'error';

  const handleToggle = () => {
    if (!isExpandable || !onExpandedChange) return;
    onExpandedChange(!expanded);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!isExpandable) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleToggle();
    }
  };

  return (
    <div
      className="conv-tool-chip-item"
      data-testid="turn-tool-chip-item"
      data-tool-status={status}
    >
      <div
        role={isExpandable ? 'button' : undefined}
        tabIndex={isExpandable ? 0 : undefined}
        aria-expanded={isExpandable ? expanded : undefined}
        aria-controls={isExpandable && expanded ? detailId : undefined}
        data-testid="turn-tool-chip-row"
        className={cn(
          'conv-tool-chip-row',
          isExpandable && 'is-expandable',
          expanded && 'is-expanded',
          isError && 'is-error',
          isRunning && 'is-running'
        )}
        onClick={isExpandable ? handleToggle : undefined}
        onKeyDown={isExpandable ? handleKeyDown : undefined}
      >
        {isError ? <span className="sr-only">Error: </span> : null}
        <span className="conv-tool-chip-icon-slot" aria-hidden="true">
          {isRunning ? (
            <Loader2
              className="conv-tool-chip-kind-icon conv-tool-chip-spinner"
              aria-hidden="true"
            />
          ) : (
            <svg
              viewBox="0 0 24 24"
              className="conv-tool-chip-kind-icon"
              aria-hidden="true"
              focusable="false"
            >
              {TOOL_CHIP_ICONS[icon]}
            </svg>
          )}
          {isExpandable ? (
            <svg
              viewBox="0 0 24 24"
              className={cn(
                'conv-tool-chip-chevron',
                expanded && 'is-expanded'
              )}
              aria-hidden="true"
              focusable="false"
            >
              {CHEVRON_ICON}
            </svg>
          ) : null}
        </span>

        <span className="conv-tool-chip-label">{label}</span>

        {chip ? (
          <span className={cn('conv-tool-chip-pill', monoChip && 'is-mono')}>
            {chip}
          </span>
        ) : null}

        {showInlineDiffCounts && additions ? (
          <span className="conv-tool-diff-add tabular-nums">+{additions}</span>
        ) : null}
        {showInlineDiffCounts && deletions ? (
          <span className="conv-tool-diff-del tabular-nums">-{deletions}</span>
        ) : null}

        {isError && errorMessage && !expanded ? (
          <span className="conv-tool-chip-error-badge">{errorMessage}</span>
        ) : null}
      </div>

      {isExpandable && expanded && detail ? (
        <div id={detailId} className="conv-tool-chip-detail">
          {detail}
        </div>
      ) : null}
    </div>
  );
}

type DiffHoverState = {
  diff: TurnToolDiffChip;
  rect: DOMRect;
};

export function TurnToolDiffChipsBar({
  diffs,
  onOpenDiff,
}: {
  diffs: readonly TurnToolDiffChip[];
  onOpenDiff?: (diff: TurnToolDiffChip) => void;
}) {
  const { t } = useTranslation('conversation');
  const [showAll, setShowAll] = useState(false);
  const [hover, setHover] = useState<DiffHoverState | null>(null);

  useEffect(() => {
    if (!hover) return undefined;
    const dismiss = () => setHover(null);
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setHover(null);
    };
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [hover]);

  if (diffs.length === 0) return null;

  const visibleDiffs =
    showAll || diffs.length <= INITIAL_VISIBLE_DIFF_CHIPS
      ? diffs
      : diffs.slice(0, INITIAL_VISIBLE_DIFF_CHIPS);
  const hiddenCount = diffs.length - visibleDiffs.length;

  const openPreview = (diff: TurnToolDiffChip, element: HTMLButtonElement) => {
    if (diff.previewLines.length === 0) return;
    setHover({ diff, rect: element.getBoundingClientRect() });
  };

  const computePortalStyle = (rect: DOMRect) => {
    const viewportW =
      typeof window !== 'undefined' ? window.innerWidth : PREVIEW_CARD_WIDTH;
    const viewportH = typeof window !== 'undefined' ? window.innerHeight : 800;
    const maxLeft = Math.max(
      PREVIEW_VIEWPORT_MARGIN,
      viewportW - PREVIEW_CARD_WIDTH - PREVIEW_VIEWPORT_MARGIN
    );
    const left = Math.min(
      Math.max(PREVIEW_VIEWPORT_MARGIN, rect.left),
      maxLeft
    );
    const spaceBelow = viewportH - rect.bottom;
    const placeAbove = spaceBelow < 200 && rect.top > spaceBelow;
    return placeAbove
      ? {
          left,
          bottom: viewportH - rect.top + PREVIEW_ANCHOR_GAP,
          width: `min(${PREVIEW_CARD_WIDTH}px, calc(100vw - ${PREVIEW_VIEWPORT_MARGIN * 2}px))`,
        }
      : {
          left,
          top: rect.bottom + PREVIEW_ANCHOR_GAP,
          width: `min(${PREVIEW_CARD_WIDTH}px, calc(100vw - ${PREVIEW_VIEWPORT_MARGIN * 2}px))`,
        };
  };

  return (
    <>
      <div className="conv-tool-diff-chips" data-testid="turn-tool-diff-chips">
        {visibleDiffs.map((diff) => (
          <button
            key={diff.key}
            type="button"
            data-diffchip=""
            className="conv-tool-diff-chip"
            title={diff.displayPath}
            aria-label={t('toolChips.showDiff', { file: diff.displayPath })}
            onClick={() => onOpenDiff?.(diff)}
            onMouseEnter={(event: MouseEvent<HTMLButtonElement>) =>
              openPreview(diff, event.currentTarget)
            }
            onMouseLeave={() => setHover(null)}
            onFocus={(event: FocusEvent<HTMLButtonElement>) =>
              openPreview(diff, event.currentTarget)
            }
            onBlur={() => setHover(null)}
          >
            <FileIcon
              filePath={diff.displayPath}
              className="conv-tool-diff-file-icon"
            />
            <span className="conv-tool-diff-name">{diff.fileName}</span>
            {diff.additions > 0 || diff.deletions === 0 ? (
              <span className="conv-tool-diff-add tabular-nums">
                +{diff.additions}
              </span>
            ) : null}
            {diff.deletions > 0 ? (
              <span className="conv-tool-diff-del tabular-nums">
                -{diff.deletions}
              </span>
            ) : null}
          </button>
        ))}

        {hiddenCount > 0 ? (
          <button
            type="button"
            className="conv-tool-diff-chip conv-tool-diff-more tabular-nums"
            onClick={() => setShowAll(true)}
          >
            {t('toolChips.more', { count: hiddenCount })}
          </button>
        ) : null}
      </div>

      {hover && typeof document !== 'undefined'
        ? createPortal(
            <div
              role="tooltip"
              data-testid="turn-tool-diff-preview"
              className="conv-tool-diff-preview"
              style={computePortalStyle(hover.rect)}
            >
              <div className="conv-tool-diff-preview-header">
                <span className="conv-tool-diff-preview-path">
                  {hover.diff.displayPath}
                </span>
                <span className="conv-tool-diff-preview-counts tabular-nums">
                  {hover.diff.additions > 0 || hover.diff.deletions === 0 ? (
                    <span className="conv-tool-diff-add">
                      +{hover.diff.additions}
                    </span>
                  ) : null}
                  {hover.diff.deletions > 0 ? (
                    <span className="conv-tool-diff-del">
                      -{hover.diff.deletions}
                    </span>
                  ) : null}
                </span>
              </div>
              <div className="conv-tool-diff-preview-body">
                {hover.diff.previewLines.map((line, lineIndex) => (
                  <div
                    key={lineIndex}
                    className={cn(
                      'conv-tool-diff-preview-line',
                      line.tone === 'add' && 'is-add',
                      line.tone === 'del' && 'is-del'
                    )}
                  >
                    <span
                      className="conv-tool-diff-preview-sign"
                      aria-hidden="true"
                    >
                      {line.tone === 'add'
                        ? '+'
                        : line.tone === 'del'
                          ? '−'
                          : ' '}
                    </span>
                    <span className="conv-tool-diff-preview-code">
                      {line.text || '\u00a0'}
                    </span>
                  </div>
                ))}
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  );
}

export function TurnToolChipsBatch({
  expansionKeys,
  label,
  diffs,
  onOpenDiff,
  collapsedErrors,
  children,
}: {
  expansionKeys: string[];
  label: string;
  diffs?: readonly TurnToolDiffChip[];
  onOpenDiff?: (diff: TurnToolDiffChip) => void;
  collapsedErrors?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useExpandableGroup(expansionKeys);
  useNestedWheel(bodyRef, { enabled: expanded });

  return (
    <div className="conv-activity-batch conv-tool-chips-batch">
      <button
        type="button"
        className={cn(
          'conv-activity-header conv-tool-chips-header',
          expanded && 'is-expanded'
        )}
        aria-expanded={expanded}
        aria-controls={id}
        onClick={() => setExpanded(!expanded)}
      >
        <svg
          viewBox="0 0 24 24"
          className={cn(
            'conv-tool-chips-batch-chevron',
            expanded && 'is-expanded'
          )}
          aria-hidden="true"
          focusable="false"
        >
          {CHEVRON_ICON}
        </svg>
        <span className="tabular-nums">{label}</span>
      </button>

      {expanded ? (
        <div
          id={id}
          ref={bodyRef}
          className="conv-nested-scroll conv-tool-chips-list"
          data-nested-scroll=""
        >
          {children}
        </div>
      ) : collapsedErrors ? (
        <div className="conv-tool-chips-list">{collapsedErrors}</div>
      ) : null}

      {diffs && diffs.length > 0 ? (
        <TurnToolDiffChipsBar diffs={diffs} onOpenDiff={onOpenDiff} />
      ) : null}
    </div>
  );
}
