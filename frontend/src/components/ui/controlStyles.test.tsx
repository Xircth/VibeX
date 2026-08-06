import { render, screen } from '@testing-library/react';
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { Button } from './button';
import { Input } from './input';
import { Select, SelectTrigger, SelectValue } from './select';
import { Switch } from './switch';

const frontendRoot = process.cwd();
const srcRoot = join(frontendRoot, 'src');
const radiusLengthPattern = /([0-9]*\.?[0-9]+)(px|rem|em)\b/g;

function readSourceFiles(directory: string): Array<[string, string]> {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return readSourceFiles(path);
    }
    if (!['.css', '.ts', '.tsx'].includes(extname(entry.name))) {
      return [];
    }
    return [[path, readFileSync(path, 'utf8')]];
  });
}
describe('shared raised controls', () => {
  it.each(['outline', 'secondary'] as const)(
    'gives the %s button the standard raised surface',
    (variant) => {
      render(<Button variant={variant}>Action</Button>);

      const className = screen.getByRole('button', {
        name: 'Action',
      }).className;
      expect(className).toContain('rounded-lg');
      expect(className).toContain('raised-control');
    }
  );

  it('gives the primary button the same standard control elevation', () => {
    render(<Button>Primary action</Button>);

    const className = screen.getByRole('button', {
      name: 'Primary action',
    }).className;
    expect(className).toContain('primary-control');
    expect(className).toContain('text-[var(--primary-control-foreground)]');
  });

  it('uses the canonical dark track and white thumb when a switch is on', () => {
    render(<Switch aria-label="Enabled" defaultChecked />);

    const control = screen.getByRole('switch', { name: 'Enabled' });
    expect(control.className).toContain(
      'data-[state=checked]:bg-[var(--switch-checked-track)]'
    );
    expect(control.className).toContain(
      'data-[state=checked]:border-[var(--switch-checked-border)]'
    );
    expect(control.firstElementChild?.className).toContain(
      'data-[state=checked]:bg-[var(--switch-checked-thumb)]'
    );
  });

  it('keeps destructive actions on the same control geometry and elevation', () => {
    render(<Button variant="destructive">Remove</Button>);

    const className = screen.getByRole('button', { name: 'Remove' }).className;
    expect(className).toContain('rounded-lg');
    expect(className).toContain('destructive-control');
  });

  it('keeps shared inputs on the canonical control radius', () => {
    render(<Input aria-label="Credential" />);

    expect(screen.getByLabelText('Credential').className).toContain(
      'rounded-lg'
    );
  });

  it('gives select triggers the same raised surface', () => {
    render(
      <Select defaultValue="main">
        <SelectTrigger aria-label="Branch">
          <SelectValue />
        </SelectTrigger>
      </Select>
    );

    const className = screen.getByRole('combobox', {
      name: 'Branch',
    }).className;
    expect(className).toContain('raised-control');
  });

  it('keeps the canonical radius and raised-material tokens stable', () => {
    const css = readFileSync(
      join(frontendRoot, 'src/styles/legacy/index.css'),
      'utf8'
    );
    const tailwind = readFileSync(
      join(frontendRoot, 'tailwind.legacy.config.js'),
      'utf8'
    );
    const design = readFileSync(join(frontendRoot, '../DESIGN.md'), 'utf8');

    expect(css).toContain('--_radius: 0.875rem;');
    expect(css).toContain('--_primary: 216 46.22% 76.67%;');
    expect(css).toContain('--_primary-foreground: 213 25% 15%;');
    expect(css).toContain('--primary-control-foreground: hsl(0 0% 100%);');
    expect(css).toContain('--switch-checked-track: hsl(213 25% 15%);');
    expect(css).toContain('--switch-checked-thumb: hsl(0 0% 100%);');
    expect(css).toContain('--switch-checked-border: hsl(0 0% 100% / 0.34);');
    expect(css).toContain('--_ring: var(--_primary);');
    expect(css).toContain('--surface-raised-control: hsl(220 14% 97%);');
    expect(css).toContain('--shadow-control:');
    expect(css).toContain('border: 0 !important;');
    expect(css).toContain('box-shadow: var(--shadow-control) !important;');
    expect(css).toContain('.primary-control,');
    expect(css).toContain('.destructive-control {');
    expect(design).toContain('primary: "#A8BEDF"');
    expect(design).toContain('primary-control-foreground: "#ffffff"');
    expect(css).toContain(".raised-control[aria-disabled='true']");
    expect(css).toContain('opacity: 0.5;');
    expect(tailwind).toContain("DEFAULT: 'var(--radius)'");
  });

  it('rejects local numeric radii outside circle and pill exceptions', () => {
    const violations: string[] = [];

    for (const [path, source] of readSourceFiles(srcRoot)) {
      if (path.endsWith('controlStyles.test.tsx')) continue;

      for (const declaration of source.matchAll(
        /(?:border-radius|--[\w-]*radius)\s*:\s*([^;]+);/g
      )) {
        if (declaration[0].startsWith('--_radius:')) continue;
        for (const length of declaration[1].matchAll(radiusLengthPattern)) {
          if (Number(length[1]) < 900) {
            violations.push(`${path}: ${declaration[0]}`);
          }
        }
      }

      if (/rounded-\[[0-9.]+(?:px|rem|em)\]/.test(source)) {
        violations.push(`${path}: arbitrary rounded length`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('requires native single-select controls to use the raised material', () => {
    const violations: string[] = [];

    for (const [path, source] of readSourceFiles(srcRoot)) {
      if (!path.endsWith('.tsx') || path.endsWith('controlStyles.test.tsx')) {
        continue;
      }
      for (const select of source.matchAll(/<select\b[\s\S]*?<\/select>/g)) {
        if (
          !select[0].includes('multiple') &&
          !select[0].includes('raised-control')
        ) {
          violations.push(path);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('keeps handwritten selector triggers on the raised material', () => {
    const selectorFiles = [
      'components/tasks/follow-up/SessionSelector.tsx',
      'components/tasks/follow-up/SessionSettingsSummary.tsx',
    ];

    for (const relativePath of selectorFiles) {
      const source = readFileSync(join(srcRoot, relativePath), 'utf8');
      const trigger = [...source.matchAll(/<button\b[\s\S]*?>/g)].find(
        (match) => match[0].includes('data-raised-selector')
      );

      expect(trigger?.[0], relativePath).toContain('raised-control');
      expect(trigger?.[0], relativePath).not.toContain('rounded-full');
    }
  });
});
