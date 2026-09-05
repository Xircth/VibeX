import { GitMerge, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { displayConflictOpLabel } from '@/lib/conflicts';
import type { ConflictOp } from 'shared/types';

type Props = {
  op: ConflictOp;
  files: readonly string[];
  onOpenFile: (path: string) => void;
  onContinue: () => void;
  onAbort: () => void;
  continueLoading?: boolean;
  abortLoading?: boolean;
};

export function GitConflictSection({
  op,
  files,
  onOpenFile,
  onContinue,
  onAbort,
  continueLoading,
  abortLoading,
}: Props) {
  return (
    <div className="border-b border-warning/30 bg-warning/5 px-2 py-2">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-warning-foreground dark:text-warning">
        <GitMerge className="h-3.5 w-3.5" />
        {displayConflictOpLabel(op)} conflicts
      </div>
      <div className="mb-2 space-y-0.5">
        {files.map((path) => (
          <button
            key={path}
            type="button"
            className="block w-full truncate rounded px-1.5 py-0.5 text-left font-mono text-[11px] hover:bg-warning/10"
            onClick={() => onOpenFile(path)}
          >
            {path}
          </button>
        ))}
      </div>
      <div className="flex gap-1.5">
        <Button
          size="sm"
          className="h-7"
          onClick={onContinue}
          disabled={continueLoading || files.length > 0}
        >
          {continueLoading ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : null}
          Continue
        </Button>
        <Button
          size="sm"
          variant="destructive"
          className="h-7"
          onClick={onAbort}
          disabled={abortLoading}
        >
          Abort
        </Button>
      </div>
    </div>
  );
}
