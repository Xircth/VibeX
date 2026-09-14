import { describe, expect, it } from 'vitest';
import type { ThemedTokenWithVariants } from 'shiki';
import {
  createPlainTokenLines,
  getShikiTokenStyle,
  reuseStableTokenLines,
  splitCompleteLinePrefix,
} from './shikiHighlighter';

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

describe('reuseStableTokenLines', () => {
  it('keeps complete lines and leaves the growing last line as remainder', () => {
    expect(splitCompleteLinePrefix('fn main() {\n    let x')).toEqual({
      prefix: 'fn main() {\n',
      remainder: '    let x',
    });

    const previous = 'fn main() {\n    let x';
    const previousTokens = createPlainTokenLines(previous);
    const reused = reuseStableTokenLines(
      previous,
      previousTokens,
      'fn main() {\n    let x = 1\n    let y'
    );

    expect(reused?.reused).toEqual(previousTokens.slice(0, 1));
    expect(reused?.remainder).toBe('    let x = 1\n    let y');
  });

  it('does not reuse when the next value is not a prefix continuation', () => {
    const previous = 'const a = 1;\n';
    expect(
      reuseStableTokenLines(
        previous,
        createPlainTokenLines(previous),
        'const b = 2;\n'
      )
    ).toBeNull();
  });
});
