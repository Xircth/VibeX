import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

import './automationFilterTable.css';

export type FilterChipItem<FilterKey extends string = string> = {
  key: FilterKey;
  label: string;
  dot?: string;
  count: number;
  testId?: string;
};

export type FilterTableColumn = {
  key: string;
  label: string;
  align?: 'left' | 'right';
};

export type FilterTableRow<FilterKey extends string = string> = {
  key: string;
  statusKey: FilterKey;
  selected?: boolean;
  testId?: string;
  onClick?: () => void;
  cells: ReactNode[];
};

export type FilterStatusTone =
  | 'todo'
  | 'progress'
  | 'done'
  | 'paused'
  | 'error';

const TONE_CLASS: Record<FilterStatusTone, string> = {
  todo: 'filter-status-todo',
  progress: 'filter-status-progress',
  done: 'filter-status-done',
  paused: 'filter-status-paused',
  error: 'filter-status-error',
};

export function FilterStatusPill({
  tone,
  label,
  testId,
  className,
}: {
  tone: FilterStatusTone;
  label: string;
  testId?: string;
  className?: string;
}) {
  return (
    <span
      data-testid={testId}
      className={cn(
        'inline-flex h-[23px] shrink-0 items-center whitespace-nowrap rounded-md border px-[7px] text-[12.5px] font-medium',
        TONE_CLASS[tone],
        className
      )}
    >
      {label}
    </span>
  );
}

export function FilterTable<FilterKey extends string = string>({
  filters,
  columns,
  rows,
  gridTemplateColumns,
  minTableWidthClass = 'min-w-[420px]',
  ariaLabel,
  defaultFilter = 'all' as FilterKey,
  activeFilter: controlledFilter,
  onFilterChange,
  emptyContent,
  className,
}: {
  filters: ReadonlyArray<FilterChipItem<FilterKey | 'all'>>;
  columns: ReadonlyArray<FilterTableColumn>;
  rows: ReadonlyArray<FilterTableRow<FilterKey>>;
  gridTemplateColumns: string;
  minTableWidthClass?: string;
  ariaLabel?: string;
  defaultFilter?: FilterKey | 'all';
  activeFilter?: FilterKey | 'all';
  onFilterChange?: (next: FilterKey | 'all') => void;
  emptyContent?: ReactNode;
  className?: string;
}) {
  const [internalFilter, setInternalFilter] = useState<FilterKey | 'all'>(
    defaultFilter
  );
  const filter = controlledFilter ?? internalFilter;
  const setFilter = (next: FilterKey | 'all') => {
    setInternalFilter(next);
    onFilterChange?.(next);
  };

  const hasVisibleRows = rows.some(
    (row) => filter === 'all' || row.statusKey === filter
  );

  return (
    <div
      className={cn(
        'automation-filter-table-shell w-full min-w-0 overflow-x-hidden',
        className
      )}
    >
      {/* Status Filter Chips */}
      <div className="automation-filter-no-scrollbar mb-1.5 flex min-w-0 items-center gap-1 overflow-x-auto px-0.5 py-1">
        {filters.map((f) => {
          const active = filter === f.key;
          return (
            <button
              key={f.key}
              type="button"
              aria-pressed={active}
              data-testid={f.testId}
              onClick={() => setFilter(f.key)}
              className={cn(
                'automation-filter-chip flex shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium transition-[background-color,box-shadow,color] duration-200',
                active
                  ? 'is-active'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
              )}
            >
              {f.dot ? (
                <span
                  aria-hidden="true"
                  className="size-1.5 shrink-0 rounded-full"
                  style={{ background: f.dot }}
                />
              ) : null}
              <span>{f.label}</span>
              <span
                className={cn(
                  'rounded-none px-1 text-[10.5px] tabular-nums',
                  active
                    ? 'bg-muted text-muted-foreground'
                    : 'text-muted-foreground/75'
                )}
              >
                {f.count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Hairline Grid Card Table */}
      <div
        aria-label={ariaLabel}
        className="automation-filter-table-card automation-filter-no-scrollbar overflow-x-auto"
        role="region"
        tabIndex={0}
      >
        <div className={minTableWidthClass}>
          <div
            className="grid border-b border-[var(--grid-line)] text-[12.5px] font-medium text-muted-foreground"
            style={{ gridTemplateColumns }}
          >
            {columns.map((col, idx) => (
              <span
                key={col.key}
                className={cn(
                  'px-3 py-2',
                  idx < columns.length - 1 &&
                    'border-r border-[var(--grid-line)]',
                  col.align === 'right' && 'text-right'
                )}
              >
                {col.label}
              </span>
            ))}
          </div>

          {!hasVisibleRows && emptyContent ? (
            <div className="p-6">{emptyContent}</div>
          ) : null}

          {rows.map((row) => {
            const shown = filter === 'all' || row.statusKey === filter;
            return (
              <div
                key={row.key}
                aria-hidden={!shown}
                data-row-visible={shown ? 'true' : 'false'}
                className={cn(
                  'grid transition-[grid-template-rows,opacity] duration-300',
                  !shown && 'pointer-events-none'
                )}
                style={{
                  gridTemplateRows: shown ? '1fr' : '0fr',
                  opacity: shown ? 1 : 0,
                  transitionTimingFunction: 'cubic-bezier(0.23, 1, 0.32, 1)',
                }}
              >
                <div className="overflow-hidden">
                  <div
                    role={row.onClick ? 'button' : undefined}
                    tabIndex={row.onClick && shown ? 0 : undefined}
                    data-testid={row.testId}
                    onClick={row.onClick}
                    onKeyDown={
                      row.onClick
                        ? (e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              row.onClick?.();
                            }
                          }
                        : undefined
                    }
                    className={cn(
                      'automation-filter-row grid border-b border-[var(--grid-line)] text-[13px] last:border-b-0',
                      row.onClick && 'cursor-pointer',
                      row.selected && 'is-selected'
                    )}
                    style={{ gridTemplateColumns }}
                  >
                    {row.cells.map((cell, cellIdx) => (
                      <div
                        key={`${row.key}-cell-${cellIdx}`}
                        className={cn(
                          'flex min-w-0 items-center px-3 py-2',
                          cellIdx < row.cells.length - 1 &&
                            'border-r border-[var(--grid-line)]'
                        )}
                      >
                        {cell}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
