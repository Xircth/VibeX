import { Archive, Lightbulb, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';

const COMPACT_CONTEXT_LABEL = '\u538b\u7f29\u4e0a\u4e0b\u6587';
const ENHANCE_PROMPT_LABEL = '\u63d0\u793a\u8bcd\u4f18\u5316';

type ActionBarUtilityButtonsProps = {
  canCompactContext: boolean;
  isCompactingContext: boolean;
  promptEnhancementEnabled: boolean;
  isEnhancingPrompt: boolean;
  canEnhancePrompt: boolean;
  onCompactContext: () => void;
  onEnhancePrompt: () => void;
};

export function ActionBarUtilityButtons({
  canCompactContext,
  isCompactingContext,
  promptEnhancementEnabled,
  isEnhancingPrompt,
  canEnhancePrompt,
  onCompactContext,
  onEnhancePrompt,
}: ActionBarUtilityButtonsProps) {
  return (
    <>
      <Button
        onClick={onCompactContext}
        disabled={!canCompactContext || isCompactingContext}
        size="sm"
        variant="ghost"
        className="h-7 w-7 p-0"
        title={COMPACT_CONTEXT_LABEL}
        aria-label={COMPACT_CONTEXT_LABEL}
      >
        {isCompactingContext ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Archive className="h-3.5 w-3.5" />
        )}
      </Button>

      {promptEnhancementEnabled ? (
        <Button
          onClick={onEnhancePrompt}
          disabled={!canEnhancePrompt || isEnhancingPrompt}
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0"
          title={ENHANCE_PROMPT_LABEL}
          aria-label={ENHANCE_PROMPT_LABEL}
        >
          {isEnhancingPrompt ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Lightbulb className="h-3.5 w-3.5" />
          )}
        </Button>
      ) : null}
    </>
  );
}
