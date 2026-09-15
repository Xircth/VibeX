import { Button } from '@/components/ui/button';

export function SessionListDeleteControl({
  selectedCount,
  isDeleting,
  selectLabel,
  selectedCountLabel,
  deleteLabel,
  deletingLabel,
  cancelLabel,
  onDelete,
  onCancel,
}: {
  selectedCount: number;
  isDeleting: boolean;
  selectLabel: string;
  selectedCountLabel: string;
  deleteLabel: string;
  deletingLabel: string;
  cancelLabel: string;
  onDelete: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex h-7 min-w-0 flex-1 items-center gap-1">
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        {selectedCount > 0 ? selectedCountLabel : selectLabel}
      </span>
      <Button
        type="button"
        size="xs"
        variant="destructive"
        className="h-7 px-2 text-[11px]"
        disabled={selectedCount === 0 || isDeleting}
        onClick={onDelete}
      >
        {isDeleting ? deletingLabel : deleteLabel}
      </Button>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        className="h-7 px-2 text-[11px]"
        disabled={isDeleting}
        onClick={onCancel}
      >
        {cancelLabel}
      </Button>
    </div>
  );
}
