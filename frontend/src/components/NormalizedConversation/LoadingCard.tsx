import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Copy, Check } from 'lucide-react';
import { useTemporaryFlag } from '@/hooks/useTemporaryFlag';

interface LoadingCardProps {
  label?: string;
  shimmer?: boolean;
}

export const LoadingCard = ({
  label = 'AI 正在思考...',
  shimmer = true,
}: LoadingCardProps) => {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(Date.now());

  useEffect(() => {
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const formatElapsed = (seconds: number) => {
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  };

  return (
    <div className="flex items-center gap-3 py-1">
      <div className="conv-spinner" />
      <span
        className={`text-sm font-medium ${shimmer ? 'conv-shimmer-text' : ''}`}
      >
        {label}
      </span>
      <span className="ml-auto tabular-nums text-xs text-muted-foreground">
        {formatElapsed(elapsed)}
      </span>
    </div>
  );
};

export const CopyButton: React.FC<{ text: string }> = ({ text }) => {
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
      title="复制"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-[hsl(var(--success))]" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </button>
  );
};
