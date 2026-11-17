import { Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

type AgentUpdateBadgeProps = {
  label?: string;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
};

const BASE_CLASS =
  'inline-flex items-center gap-1 whitespace-nowrap rounded-[var(--radius-inner,var(--radius))] border-0 bg-transparent px-1.5 py-0.5 text-xs font-medium leading-[1.25] text-primary';

const INTERACTIVE_CLASS =
  'cursor-pointer font-sans transition-colors hover:bg-foreground/10 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45 disabled:cursor-not-allowed disabled:opacity-55';

export function AgentUpdateBadge({
  label,
  onClick,
  disabled = false,
  className,
}: AgentUpdateBadgeProps) {
  const { t } = useTranslation('settings');
  const text = label ?? t('agents.updateAvailableBadge');

  if (onClick) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        className={cn(BASE_CLASS, INTERACTIVE_CLASS, className)}
      >
        <Sparkles aria-hidden="true" className="size-3 shrink-0" />
        <span>{text}</span>
      </button>
    );
  }

  return (
    <span className={cn(BASE_CLASS, className)}>
      <Sparkles aria-hidden="true" className="size-3 shrink-0" />
      <span>{text}</span>
    </span>
  );
}
