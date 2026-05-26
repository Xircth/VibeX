import { useCallback, useState } from 'react';
import type { FocusEvent } from 'react';

export function useSessionComposerFocus() {
  const [isTextareaFocused, setIsTextareaFocused] = useState(false);

  const handleComposerFocus = useCallback(() => {
    setIsTextareaFocused(true);
  }, []);

  const handleComposerBlur = useCallback((event: FocusEvent<HTMLElement>) => {
    const nextTarget =
      event.relatedTarget instanceof Node ? event.relatedTarget : null;
    if (!event.currentTarget.contains(nextTarget)) {
      setIsTextareaFocused(false);
    }
  }, []);

  return {
    isTextareaFocused,
    handleComposerFocus,
    handleComposerBlur,
  };
}
