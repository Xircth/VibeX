import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Copy, Check } from 'lucide-react';
import { useTemporaryFlag } from '@/hooks/useTemporaryFlag';

/***********************
 * Phase 5: LoadingCard — shimmer + spinner + timer
 ***********************/

export const LoadingCard = () => {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(Date.now());

  useEffect(() => {
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const formatElapsed = (s: number) => {
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  };

  return (
    <div className="flex items-center gap-3 py-1">
      <div className="conv-spinner" />
      <span className="conv-shimmer-text text-sm font-medium">
        AI 正在思考...
      </span>
      <span className="text-xs text-muted-foreground ml-auto tabular-nums">
        {formatElapsed(elapsed)}
      </span>
    </div>
  );
};

/*****************************
 * Phase 2: CopyButton for assistant messages
 *****************************/

export const CopyButton: React.FC<{ text: string }> = ({ text }) => {
  const [copied, triggerCopied] = useTemporaryFlag(2000);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      triggerCopied();
    } catch {
      // Clipboard API may fail in some contexts
    }
  }, [text, triggerCopied]);

  return (
    <button
      onClick={handleCopy}
      className="conv-copy-btn p-1 rounded hover:bg-muted/80 text-muted-foreground hover:text-foreground"
      title="复制"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-green-500" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </button>
  );
};
