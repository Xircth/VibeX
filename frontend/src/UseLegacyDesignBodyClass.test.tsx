import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { useLegacyDesignBodyClass } from './useLegacyDesignBodyClass';

describe('useLegacyDesignBodyClass', () => {
  afterEach(() => {
    document.body.classList.remove('legacy-design');
  });

  it('adds the legacy design class while mounted and removes it on unmount', () => {
    const { unmount } = renderHook(() => useLegacyDesignBodyClass());

    expect(document.body.classList.contains('legacy-design')).toBe(true);

    unmount();

    expect(document.body.classList.contains('legacy-design')).toBe(false);
  });
});
