import { ArrowUp, Loader2, Square } from 'lucide-react';

import { Button } from '@/components/ui/button';

type ComposerPrimaryActionButtonProps = {
  action: 'send' | 'stop';
  label: string;
  shortcutHint?: string | null;
  pending?: boolean;
  disabled?: boolean;
  onClick: () => void;
};

export function ComposerPrimaryActionButton({
  action,
  label,
  shortcutHint = null,
  pending = false,
  disabled = false,
  onClick,
}: ComposerPrimaryActionButtonProps) {
  const tooltipTitle = shortcutHint ? `${label} (${shortcutHint})` : label;
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
      title={tooltipTitle}
    >
      {pending ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      ) : action === 'send' ? (
        <ArrowUp
          className="h-[17px] w-[17px]"
          strokeWidth={2.25}
          aria-hidden="true"
        />
      ) : (
        <Square
          className="h-[10px] w-[10px] fill-current stroke-none"
          aria-hidden="true"
        />
      )}
    </Button>
  );
}
