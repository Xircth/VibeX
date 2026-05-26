import { useEffect } from 'react';

const LEGACY_DESIGN_BODY_CLASS = 'legacy-design';

export function useLegacyDesignBodyClass() {
  useEffect(() => {
    document.body.classList.add(LEGACY_DESIGN_BODY_CLASS);
    return () => {
      document.body.classList.remove(LEGACY_DESIGN_BODY_CLASS);
    };
  }, []);
}
