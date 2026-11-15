import { memo, useCallback } from 'react';
import { Check, Copy } from 'lucide-react';
import { useTemporaryFlag } from '@/hooks/useTemporaryFlag';
import {
  getShikiTokenStyle,
  normalizeShikiLanguage,
  useShikiTokens,
  type ShikiTokenLines,
} from '@/utils/shikiHighlighter';

export type CodeBlockHighlightState = 'deferred' | 'highlighted' | 'plain';

type CodeBlockProps = {
  className?: string;
  value: string;
  isStreaming?: boolean;
  deferHighlight?: boolean;
};

export function extractLanguageTag(className?: string): string | null {
  if (!className) return null;
  const match = className.match(/language-([\w-]+)/i);
  return match ? match[1] : null;
}

function hasHighlightedTokens(tokens: ShikiTokenLines): boolean {
  return tokens.some((line) =>
    line.some(
      (token) =>
        Boolean(token.variants.light?.color) ||
        Boolean(token.variants.dark?.color) ||
        token.variants.light?.fontStyle !== undefined ||
        token.variants.dark?.fontStyle !== undefined
    )
  );
}

function resolveHighlightState(
  deferHighlight: boolean,
  tokens: ShikiTokenLines
): CodeBlockHighlightState {
  if (deferHighlight) return 'deferred';
  return hasHighlightedTokens(tokens) ? 'highlighted' : 'plain';
}

function TokenizedCode({ tokens }: { tokens: ShikiTokenLines }) {
  return (
    <>
      {tokens.map((line, lineIndex) => (
        <span className="conv-md-codeblock-line" key={lineIndex}>
          {line.map((token, tokenIndex) => (
            <span
              className="conv-md-token"
              key={`${lineIndex}-${token.offset}-${tokenIndex}`}
              style={getShikiTokenStyle(token)}
            >
              {token.content}
            </span>
          ))}
        </span>
      ))}
    </>
  );
}

export const CompactCodeBlock = memo(function CompactCodeBlock({
  className,
  value,
  deferHighlight = false,
}: CodeBlockProps) {
  const language = normalizeShikiLanguage(extractLanguageTag(className));
  const tokens = useShikiTokens(
    deferHighlight ? '' : value,
    deferHighlight ? 'text' : language
  );
  const highlightState = resolveHighlightState(deferHighlight, tokens);

  return (
    <pre
      className="conv-md-codeblock-single"
      data-highlight-state={highlightState}
    >
      <code className={className}>
        {deferHighlight ? value : <TokenizedCode tokens={tokens} />}
      </code>
    </pre>
  );
});

export const CodeBlock = memo(function CodeBlock({
  className,
  value,
  isStreaming = false,
  deferHighlight = false,
}: CodeBlockProps) {
  const [copied, triggerCopied] = useTemporaryFlag(1200);
  const languageTag = extractLanguageTag(className);
  const language = normalizeShikiLanguage(languageTag);
  const tokens = useShikiTokens(
    deferHighlight ? '' : value,
    deferHighlight ? 'text' : language,
    {
      incremental: isStreaming && !deferHighlight,
    }
  );
  const languageLabel = languageTag?.trim() || 'text';
  const highlightState = resolveHighlightState(deferHighlight, tokens);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      triggerCopied();
    } catch {
      // Clipboard access depends on the host WebView permission state.
    }
  }, [triggerCopied, value]);

  return (
    <div className="conv-md-codeblock" data-highlight-state={highlightState}>
      <div className="conv-md-codeblock-header">
        <span className="conv-md-codeblock-language">{languageLabel}</span>
        <button
          type="button"
          className={`conv-md-codeblock-copy${copied ? ' is-copied' : ''}`}
          onClick={handleCopy}
          title={copied ? '\u5df2\u590d\u5236' : '\u590d\u5236\u4ee3\u7801'}
          aria-label={
            copied ? '\u5df2\u590d\u5236' : '\u590d\u5236\u4ee3\u7801'
          }
        >
          {copied ? (
            <Check className="h-3.5 w-3.5" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
      <pre>
        <code className={className}>
          {deferHighlight ? value : <TokenizedCode tokens={tokens} />}
        </code>
      </pre>
    </div>
  );
});
