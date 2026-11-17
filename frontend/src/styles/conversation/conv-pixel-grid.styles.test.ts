import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'postcss';
import { describe, expect, it } from 'vitest';

const stylesheet = readFileSync(
  resolve(process.cwd(), 'src/styles/conversation/conv-components.css'),
  'utf8'
);

/** Base declarations only — rules nested in `@media` (reduced motion) are
 *  deliberately excluded so the resting animation contract stays readable. */
function declarationsFor(selector: string) {
  const declarations = new Map<string, string>();
  parse(stylesheet).walkRules((rule) => {
    if (rule.parent?.type !== 'root') return;
    const normalizedSelector = rule.selector.replace(/\s+/g, ' ').trim();
    if (normalizedSelector !== selector) return;
    rule.walkDecls((declaration) => {
      declarations.set(declaration.prop, declaration.value);
    });
  });
  return declarations;
}

function keyframeSteps(name: string) {
  const steps = new Map<string, Map<string, string>>();
  parse(stylesheet).walkAtRules('keyframes', (atRule) => {
    if (atRule.params !== name) return;
    atRule.walkRules((rule) => {
      const step = new Map<string, string>();
      rule.walkDecls((declaration) => {
        step.set(declaration.prop, declaration.value);
      });
      steps.set(rule.selector.replace(/\s+/g, ' ').trim(), step);
    });
  });
  return steps;
}

describe('conversation pixel-grid loader', () => {
  it('animates a chevron wavefront rather than a rotating ring', () => {
    const grid = declarationsFor('.conv-pixel-grid');
    expect(grid.get('display')).toBe('inline-grid');
    expect(grid.get('grid-template-columns')).toBe(
      'repeat(3, var(--conv-pixel-cell))'
    );
    expect(grid.get('grid-template-rows')).toBe(
      'repeat(3, var(--conv-pixel-cell))'
    );
  });

  it('lights the cells from the shared tool-icon token, not a spinner border', () => {
    const cell = declarationsFor('.conv-pixel-cell');
    expect(cell.get('background')).toBe('var(--conv-tool-icon)');
    expect(cell.get('border-radius')).toBe('0');
    expect(cell.get('animation')).toBe(
      'conv-pixel-on 650ms ease-in-out infinite'
    );

    const steps = keyframeSteps('conv-pixel-on');
    expect(steps.get('0%, 100%')?.get('opacity')).toBe('0.18');
    expect(steps.get('35%')?.get('opacity')).toBe('1');
  });

  it('keeps the reduced-motion state a legible static chevron', () => {
    // Reduced motion must not freeze every cell to the same dim value, which
    // reads as a broken indicator; the middle row holds the chevron shape.
    const reducedMotion = stylesheet.slice(
      stylesheet.indexOf('@media (prefers-reduced-motion: reduce)')
    );
    expect(reducedMotion).toMatch(
      /\.conv-pixel-cell\s*\{[^}]*animation:\s*none;/
    );
    expect(reducedMotion).toMatch(
      /\.conv-pixel-cell:nth-child\(4\)[\s\S]*?opacity:\s*0\.85;/
    );
  });

  it('no longer ships the circular conversation spinner', () => {
    expect(stylesheet).not.toMatch(/\.conv-spinner\s*\{/);
    expect(stylesheet).not.toMatch(/@keyframes\s+conv-spinner\s*\{/);
  });
});
