import { Check, Clipboard, Pencil, Trash2 } from 'lucide-react';

export function WysiwygReadOnlyActions({
  copied,
  onCopy,
  onEdit,
  onDelete,
}: {
  copied: boolean;
  onCopy: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  return (
    <div className="flex justify-end gap-0.5 mt-1 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
      <button
        type="button"
        aria-label={copied ? 'Copied!' : 'Copy as Markdown'}
        title={copied ? 'Copied!' : 'Copy as Markdown'}
        onClick={onCopy}
        className="p-1 rounded hover:bg-muted/70 transition-colors"
      >
        {copied ? (
          <Check className="w-3.5 h-3.5 text-green-400" />
        ) : (
          <Clipboard className="w-3.5 h-3.5 opacity-60 hover:opacity-100" />
        )}
      </button>
      {onEdit && (
        <button
          type="button"
          aria-label="Edit"
          title="Edit"
          onClick={onEdit}
          className="p-1 rounded hover:bg-muted/70 transition-colors"
        >
          <Pencil className="w-3.5 h-3.5 opacity-60 hover:opacity-100" />
        </button>
      )}
      {onDelete && (
        <button
          type="button"
          aria-label="Delete"
          title="Delete"
          onClick={onDelete}
          className="p-1 rounded hover:bg-muted/70 transition-colors"
        >
          <Trash2 className="w-3.5 h-3.5 opacity-60 hover:opacity-100" />
        </button>
      )}
    </div>
  );
}
