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
    expect(css).toContain('width: min(400px, calc(100vw - 24px));');
    expect(css).toContain('background: var(--surface-dialog);');
    expect(css).toContain('var(--toast-shadow)');
    expect(css).not.toContain('backdrop-filter:');
    expect(css).not.toContain('vu-toast-icon-tile');
    expect(css).not.toContain('vu-toast-summary');
  });

  it('expands details across the icon column and keeps compact compose type', () => {
    expect(css).toContain('.vu-toast-details {');
    expect(css).toMatch(/\.vu-toast-details \{[\s\S]*?margin: 0 14px 12px;/);
    expect(css).toContain(
      '.vu-desktop-toast-compose .astryx-text-input input {'
    );
    expect(css).toContain('font-size: 12px !important;');
    expect(css).toContain('line-height: 18px !important;');
  });
});
