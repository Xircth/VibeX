import { describe, expect, it } from 'vitest';
import type { ThemedTokenWithVariants } from 'shiki';
import { getShikiTokenStyle } from './shikiHighlighter';

function token(
  light: { color?: string; fontStyle?: number },
  dark: { color?: string; fontStyle?: number }
): ThemedTokenWithVariants {
  return {
    content: 'x',
    offset: 0,
    variants: { light, dark },
  } as ThemedTokenWithVariants;
}

describe('getShikiTokenStyle', () => {
  it('exposes each theme color as an isolated CSS variable', () => {
    const style = getShikiTokenStyle(
      token({ color: '#111111' }, { color: '#eeeeee' })
    );

    expect(style['--shiki-token-light']).toBe('#111111');
    expect(style['--shiki-token-dark']).toBe('#eeeeee');
  });

  it('applies a font style only when both themes share it', () => {
    expect(
      getShikiTokenStyle(token({ fontStyle: 1 }, { fontStyle: 1 })).fontStyle
    ).toBe('italic');
    expect(
      getShikiTokenStyle(token({ fontStyle: 2 }, { fontStyle: 2 })).fontWeight
    ).toBe(600);
  });

  it('does not bleed a single-theme font style across themes', () => {
    const style = getShikiTokenStyle(token({ fontStyle: 1 }, { fontStyle: 0 }));

    expect(style.fontStyle).toBeUndefined();
    expect(style.fontWeight).toBeUndefined();
  });

  it('treats the unset (-1) font style as no style', () => {
    const style = getShikiTokenStyle(
      token({ fontStyle: -1 }, { fontStyle: 1 })
    );

    expect(style.fontStyle).toBeUndefined();
  });
});
