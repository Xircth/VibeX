import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(
  resolve(process.cwd(), 'src/components/ui/toast.css'),
  {
    encoding: 'utf8',
  }
);

describe('toast surface contract', () => {
  it('uses an opaque 400px dialog card with overlay shadow', () => {
    expect(css).toContain('width: min(444px, 100vw);');
    expect(css).toContain('padding: 36px 12px 12px 32px;');
    expect(css).toContain('background: var(--surface-dialog);');
    expect(css).toContain('var(--toast-shadow)');
    expect(css).not.toContain('backdrop-filter:');
    expect(css).not.toContain('vu-toast-icon-tile');
    expect(css).not.toContain('vu-toast-summary');
  });

  it('keeps the drop shadow outside the rounded card', () => {
    expect(css).toMatch(/\.vu-toast-surface \{[\s\S]*?overflow: visible;/);
    expect(css).toMatch(
      /\.vu-toast-viewport \{[\s\S]*?padding: 36px 12px 12px 32px;/
    );
    expect(css).toContain(
      'animation: vu-toast-enter 180ms ease-out backwards;'
    );
    expect(css).not.toContain('ease-out both');
    expect(css).toContain('html.desktop-toast-shell .vu-toast-surface {');
    expect(css).toContain('box-shadow: none;');
    expect(css).toContain('drop-shadow(0 10px 28px hsl(220 36% 8% / 0.16))');
  });

  it('lets the title wrap to three lines at regular weight', () => {
    expect(css).toMatch(/\.vu-toast-title \{[\s\S]*?font-weight: 400;/);
    expect(css).toMatch(/\.vu-toast-title \{[\s\S]*?min-width: 0;/);
    expect(css).toMatch(/\.vu-toast-title \{[\s\S]*?-webkit-line-clamp: 3;/);
    expect(css).toMatch(/\.vu-toast-title \{[\s\S]*?line-clamp: 3;/);
    expect(css).not.toContain('white-space: nowrap;');
  });

  it('expands details across the icon column and keeps compact compose type', () => {
    expect(css).toContain('.vu-toast-details {');
    expect(css).toMatch(/\.vu-toast-details \{[\s\S]*?margin: 0 14px 12px;/);
    expect(css).toContain(
      '.vu-desktop-toast-compose .astryx-text-input input {'
    );
    expect(css).toContain('font-size: 12px !important;');
    expect(css).toContain('line-height: 18px !important;');
    expect(css).toMatch(
      /\.vu-toast-end \.astryx-button,[\s\S]*?--font-size-base: 12px;/
    );
    expect(css).toMatch(
      /\.vu-toast-end \.astryx-button,[\s\S]*?font-size: 12px;/
    );
    expect(css).toMatch(
      /\.vu-toast-end \.astryx-button,[\s\S]*?line-height: 16px;/
    );
  });
});
