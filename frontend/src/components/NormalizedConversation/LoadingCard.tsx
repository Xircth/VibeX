import React, { useEffect, useRef, useCallback } from 'react';
import { Copy, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTemporaryFlag } from '@/hooks/useTemporaryFlag';
import {
  PixelGridLoader,
  formatLoadingElapsed,
} from '@/components/ui/pixel-grid-loader';

interface LoadingCardProps {
  label?: string;
  shimmer?: boolean;
}

export const LoadingCard = ({ label, shimmer = true }: LoadingCardProps) => {
  const { t } = useTranslation(['conversation', 'common']);
  const startRef = useRef(Date.now());
  const elapsedRef = useRef<HTMLSpanElement | null>(null);
  const displayLabel = label ?? t('loadingCard.thinking');

  useEffect(() => {
    const interval = setInterval(() => {
      if (elapsedRef.current) {
        elapsedRef.current.textContent = formatLoadingElapsed(
          Date.now() - startRef.current
        );
      }
    }, 100);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex items-center gap-3 py-1">
      <PixelGridLoader />
      <span
        className={`text-sm font-medium ${shimmer ? 'conv-shimmer-text' : ''}`}
      >
        {displayLabel}
      </span>
      <span
        ref={elapsedRef}
        className="ml-auto font-mono text-xs tabular-nums text-muted-foreground"
      >
        {formatLoadingElapsed(0)}
      </span>
    </div>
  );
};

export const CopyButton: React.FC<{ text: string }> = ({ text }) => {
  const { t } = useTranslation(['conversation', 'common']);
  const [copied, triggerCopied] = useTemporaryFlag(2000);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      triggerCopied();
    } catch {
      // Clipboard API may fail in some contexts.
    }
  }, [text, triggerCopied]);

  return (
    <button
      onClick={handleCopy}
      className="conv-copy-btn rounded p-1 text-muted-foreground hover:bg-muted/80 hover:text-foreground"
      title={t('loadingCard.copy')}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-[hsl(var(--success))]" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </button>
  );
};
