import { useState } from 'react';
import { Tag as TagIcon, X } from 'lucide-react';

interface TagReferenceChipProps {
  tagName: string;
  content: string;
  isEditable?: boolean;
  onRemove?: (event: React.MouseEvent) => void;
  onDoubleClick?: (event: React.MouseEvent) => void;
}

export function TagReferenceChip({
  tagName,
  content,
  isEditable = false,
  onRemove,
  onDoubleClick,
}: TagReferenceChipProps) {
  const [showTooltip, setShowTooltip] = useState(false);

  return (
    <span
      className="relative mx-0.5 inline-flex cursor-default select-none items-center gap-1 rounded-md bg-[hsl(var(--primary)/0.12)] px-1.5 py-0.5 align-baseline text-sm text-primary"
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
      onDoubleClick={onDoubleClick}
    >
      <TagIcon className="h-3 w-3 shrink-0" />
      <span className="font-medium">#{tagName}</span>
      {isEditable && onRemove ? (
        <button
          type="button"
          className="ml-0.5 rounded-sm p-0.5 transition-colors hover:bg-[hsl(var(--primary)/0.22)]"
          onClick={onRemove}
          tabIndex={-1}
          aria-label={`Remove tag #${tagName}`}
        >
          <X className="h-2.5 w-2.5" />
        </button>
      ) : null}
      {showTooltip && content ? (
        <div className="pointer-events-none absolute bottom-full left-0 z-50 mb-1.5 max-h-[200px] max-w-[400px] overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-popover p-2 text-xs text-foreground shadow-lg">
          {content}
        </div>
      ) : null}
    </span>
  );
}
