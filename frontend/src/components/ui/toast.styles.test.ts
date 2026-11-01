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
  it('uses an opaque dialog surface with the shared toast shadow', () => {
    expect(css).toContain('width: min(420px, calc(100vw - 24px));');
    expect(css).toMatch(
      /\.vu-toast-viewport \.vu-toast-surface \{[\s\S]*?background: var\(--surface-dialog\);/
    );
    expect(css).toContain(
      'box-shadow: var(--toast-shadow), var(--vu-toast-inner);'
    );
    expect(css).not.toMatch(/^\s*(?:-webkit-)?backdrop-filter:\s*blur/m);
    expect(css).not.toContain('--vu-toast-glass');
    expect(css).not.toContain('#fafafa');
  });

  it('keeps the drop shadow outside the scroll clip', () => {
    expect(css).toMatch(
      /\.vu-toast-viewport \{[\s\S]*?padding: 48px 16px 16px;/
    );
    expect(css).toMatch(/\.vu-toast-host \{[\s\S]*?overflow: visible;/);
  });

  it('derives card radius from --radius and keeps the capsule pill', () => {
    expect(css).toMatch(
      /\[data-layout='card'\] \{[\s\S]*?border-radius: var\(--radius\);/
    );
    expect(css).toMatch(
      /\[data-layout='capsule'\] \{[\s\S]*?border-radius: 999px;/
    );
  });

  it('lets long titles wrap instead of truncating', () => {
    expect(css).toMatch(
      /\.vu-toast-viewport \.vu-toast-title \{[\s\S]*?overflow-wrap: anywhere;/
    );
  });

  it('keeps technical details in a bounded scrollable disclosure', () => {
    expect(css).toMatch(
      /\.vu-toast-details \{[\s\S]*?max-height: min\(42dvh, 360px\);/
    );
    expect(css).toMatch(/\.vu-toast-details \{[\s\S]*?overflow-y: auto;/);
  });

  it('puts the details toggle on the title row with token chrome', () => {
    expect(css).toMatch(
      /\.vu-toast-disclosure-inline \{[\s\S]*?flex: 0 0 auto;[\s\S]*?white-space: nowrap;[\s\S]*?border-radius: var\(--radius\);/
    );
    expect(css).toMatch(
      /\.vu-toast-disclosure-inline:hover \{[\s\S]*?background: var\(--surface-control\);/
    );
  });
});
