import { useEffect, useRef } from 'react';

import { useOptionalBasicGuide } from './BasicGuideContext';
import { BASIC_GUIDE_HELLO } from './basicGuideState';

export function useBasicGuideHelloSeed(
  value: string,
  onChange: (next: string) => void
) {
  const guide = useOptionalBasicGuide();
  const seededRef = useRef(false);

  useEffect(() => {
    if (
      guide?.state.phase !== 'active' ||
      guide.state.substep !== 'send-hello'
    ) {
      return;
    }
    if (seededRef.current) return;
    seededRef.current = true;
    if (value.trim()) return;
    onChange(BASIC_GUIDE_HELLO);
  }, [guide?.state.phase, guide?.state.substep, onChange, value]);
}
