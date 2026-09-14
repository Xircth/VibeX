import { useMemo, type MouseEvent } from 'react';
import FileIcon from '@/components/FileIcon';
import { cn, formatFileSize } from '@/lib/utils';
import { formatDateShortWithTime } from '@/utils/date';

const HOVER_OPEN_DELAY_MS = 200;

export { HOVER_OPEN_DELAY_MS };

export type AttachmentFileCardProps = {
  name: string;
  sizeBytes?: bigint | number | null;
  modifiedAt?: string | number | Date | null;
  expanded?: boolean;
  className?: string;
  onClick?: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
};

function formatModifiedAt(
  value: string | number | Date | null | undefined
): string {
  if (value == null || value === '') return '';
  if (typeof value === 'string') {
    return formatDateShortWithTime(value);
  }
  return formatDateShortWithTime(new Date(value).toISOString());
}

export function AttachmentFileCard({
  name,
  sizeBytes,
  modifiedAt,
  expanded = true,
  className,
  onClick,
  onMouseEnter,
  onMouseLeave,
}: AttachmentFileCardProps) {
  const sizeLabel = formatFileSize(sizeBytes);
  const timeLabel = formatModifiedAt(modifiedAt);
  const meta = useMemo(
    () => [sizeLabel, timeLabel].filter(Boolean).join(' · '),
    [sizeLabel, timeLabel]
  );

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    onClick?.();
  };

  return (
    <button
      type="button"
      className={cn(
        'attachment-file-card',
        expanded ? 'is-expanded' : 'is-collapsed',
        className
      )}
      title={name}
      aria-label={name}
      data-testid="attachment-file-card"
      data-expanded={expanded ? 'true' : 'false'}
      onClick={handleClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <span className="attachment-file-card__icon" aria-hidden="true">
        <FileIcon filePath={name} className="h-5 w-5" />
      </span>
      <span className="attachment-file-card__body">
        <span className="attachment-file-card__name">{name}</span>
        {meta ? (
          <span className="attachment-file-card__meta">{meta}</span>
        ) : null}
      </span>
    </button>
  );
}
