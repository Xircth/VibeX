import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(
  resolve(process.cwd(), 'src/components/ui/toast.css'),
  { encoding: 'utf8' }
);

function rule(selector: string): string {
  const index = css.indexOf(`${selector} {`);
  expect(index, `missing rule ${selector}`).toBeGreaterThanOrEqual(0);
  return css.slice(index, css.indexOf('}', index));
}

describe('toast surface contract (glass capsule)', () => {
  it('keeps the frosted-glass surface for in-app toasts', () => {
    const surface = rule('.vu-toast-viewport .vu-toast-surface');
    expect(surface).toContain('backdrop-filter: blur(');
    expect(surface).toContain('var(--vu-toast-glass)');
  });

  it('falls back to an opaque surface for reduced transparency', () => {
    expect(css).toContain('prefers-reduced-transparency: reduce');
    expect(css).toContain('background: var(--vu-toast-solid);');
  });

  it('peeks stacked toasts above the front toast instead of behind it', () => {
    const peek1 = rule(
      ".vu-toast-viewport[data-expanded='false'] .vu-toast-host[data-stack-index='1']"
    );
    expect(peek1).toContain('var(--vu-toast-front-height');
    expect(peek1).not.toContain('translateY');
    const peekHost = rule(
      ".vu-toast-viewport[data-expanded='false']\n  .vu-toast-host[data-stack-index]:not([data-stack-index='0'])"
    );
    expect(peekHost).toContain('height: var(--vu-toast-peek-height)');
    expect(peekHost).toContain('var(--vu-toast-peek-inset');
    expect(peek1).toContain('--vu-toast-peek-inset: 8px;');
    expect(
      rule(
        ".vu-toast-viewport[data-expanded='false'] .vu-toast-host[data-stack-index='2']"
      )
    ).toContain('--vu-toast-peek-inset: 16px;');
  });

  it('does not leave the host as a backdrop root after the entry animation', () => {
    expect(css).toMatch(/vu-toast-pop[^;]*backwards/);
    expect(css).not.toMatch(/vu-toast-pop[^;]*\bboth\b/);
  });

  it('separates detail rows with gaps instead of divider lines', () => {
    const details = rule('.vu-toast-details');
    expect(details).toContain('gap: 8px;');
    expect(css).not.toMatch(/\.vu-toast-detail-row \+ \.vu-toast-detail-row/);
    const title = rule('.vu-toast-detail-title');
    expect(title).toContain('color: var(--text-muted);');
    expect(title).toContain('font-weight: 400;');
  });

  it('uses design tokens for the details disclosure and focus ring', () => {
    const disclosure = rule('.vu-toast-disclosure');
    expect(disclosure).toContain('color: var(--text-muted);');
    expect(disclosure).toContain('font-size: 0.75rem;');
    expect(css).toContain('outline: 2px solid var(--focus-ring);');
  });

  it('renders technical details in monospace', () => {
    expect(rule('.vu-toast-detail-copy-mono')).toContain(
      'font-family: var(--font-mono'
    );
    expect(rule('.vu-toast-detail-copy-mono')).toContain(
      'word-break: break-all;'
    );
  });
});
