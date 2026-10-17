import { ArrowUp, Loader2, Square } from 'lucide-react';

import { Button } from '@/components/ui/button';

type ComposerPrimaryActionButtonProps = {
  action: 'send' | 'stop';
  label: string;
  pending?: boolean;
  disabled?: boolean;
  onClick: () => void;
};

export function ComposerPrimaryActionButton({
  action,
  label,
  pending = false,
  disabled = false,
  onClick,
}: ComposerPrimaryActionButtonProps) {
  return (
    <Button
      type="button"
      variant="default"
      size="icon"
      onClick={onClick}
      disabled={disabled}
      className="composer-primary-action shrink-0"
      data-basic-guide={action === 'send' ? 'session-send' : undefined}
      aria-label={label}
      aria-busy={pending || undefined}
      title={label}
    >
      {pending ? (
        <Loader2
          className="h-[11.2px] w-[11.2px] animate-spin"
          aria-hidden="true"
        />
      ) : action === 'send' ? (
        <ArrowUp
          className="h-[12.6px] w-[12.6px]"
          strokeWidth={2.25}
          aria-hidden="true"
        />
      ) : (
        <Square
          className="h-[7px] w-[7px] fill-current stroke-none"
          aria-hidden="true"
        />
      )}
    </Button>
  );
}
