import { useSequenceTracker } from './SequenceTracker';
import { cn } from '@/lib/utils';

export function SequenceIndicator() {
  const { buffer, isActive, isInvalid } = useSequenceTracker();

  if (!isActive && !isInvalid) return null;

  return (
    <div
      className={cn(
        'fixed bottom-4 right-4 z-[10001]',
        'animate-in fade-in-0 zoom-in-95 duration-150',
        isInvalid && 'animate-shake'
      )}
      data-testid="sequence-indicator"
    >
      <div
        className={cn(
          'flex items-center gap-1 rounded-sm border',
          'backdrop-blur-sm px-base py-half shadow-lg',
          isInvalid
            ? 'border-destructive bg-destructive/10'
            : 'border-border bg-popover/95'
        )}
      >
        {buffer.map((key, index) => (
          <kbd
            key={index}
            className={cn(
              'inline-flex items-center justify-center',
              'min-w-[24px] h-6 px-1.5',
              'rounded-sm border bg-secondary',
              'font-ibm-plex-mono text-sm',
              isInvalid
                ? 'border-destructive text-destructive'
                : 'border-border text-foreground'
            )}
          >
            {key.toUpperCase()}
          </kbd>
        ))}
        {!isInvalid && (
          <span className="text-muted-foreground text-sm ml-1">...</span>
        )}
      </div>
    </div>
  );
}
