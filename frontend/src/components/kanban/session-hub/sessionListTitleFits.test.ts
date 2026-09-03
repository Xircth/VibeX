import { describe, expect, it } from 'vitest';
import { sessionListTitleFits } from './sessionListTitleFits';

describe('sessionListTitleFits', () => {
  it('keeps the full title only when the slot can show every glyph', () => {
    expect(sessionListTitleFits(80, 56)).toBe(true);
    expect(sessionListTitleFits(56, 56)).toBe(true);
  });

  it('hides the title instead of truncating when the slot is narrower', () => {
    expect(sessionListTitleFits(40, 56)).toBe(false);
    expect(sessionListTitleFits(0, 56)).toBe(false);
  });
});
