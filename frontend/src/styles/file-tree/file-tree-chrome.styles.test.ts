import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

function declarationsFor(
  stylesheet: string,
  selector: string
): Record<string, { value: string; important: boolean }> {
  const css = readFileSync(resolve(process.cwd(), stylesheet), 'utf8');
  const declarations: Record<string, { value: string; important: boolean }> =
    {};
  parse(css).walkRules((rule: Rule) => {
    const normalized = rule.selector.replace(/\s+/g, ' ').trim();
    if (normalized !== selector) return;
    rule.walkDecls((declaration) => {
      declarations[declaration.prop] = {
        value: declaration.value,
        important: declaration.important,
      };
    });
  });
  return declarations;
}

const BASE = 'src/styles/file-tree/file-tree-base.css';
const GIT = 'src/styles/file-tree/file-tree-git.css';

describe('file tree chrome', () => {
  it('insets the project title and keeps the title bar on the tree background', () => {
    const zone = declarationsFor(BASE, '.file-tree-top-zone');
    const reduced = declarationsFor(
      BASE,
      '.app.reduced-transparency .file-tree-top-zone'
    );
    const root = declarationsFor(BASE, '.file-tree-row.is-root');

    expect(zone.background?.value).toBe('transparent');
    expect(zone['backdrop-filter']?.value).toBe('none');
    expect(zone['-webkit-backdrop-filter']?.value).toBe('none');
    expect(zone['padding-bottom']).toBeUndefined();
    expect(zone.gap).toBeUndefined();
    expect(reduced.background).toBeUndefined();
    expect(root.padding?.value).toBe('0 8px 0 12px');
    expect(root['min-height']?.value).toBe('24px');
    expect(root['line-height']?.value).toBe('24px');
  });

  it('moves the expand glyph toward the folder icon without shifting the icon column', () => {
    const chevron = declarationsFor(BASE, '.file-tree-chevron');
    const spacer = declarationsFor(BASE, '.file-tree-spacer');

    expect(chevron.width?.value).toBe('14px');
    expect(chevron['margin-left']?.value).toBe('4px');
    expect(chevron['margin-right']?.value).toBe('-4px');
    expect(spacer.width?.value).toBe('14px');
    expect(spacer['margin-right']).toBeUndefined();
  });

  it('dims ignored names without italicizing them', () => {
    const row = declarationsFor(GIT, '.file-tree-row.is-gitignored');
    const name = declarationsFor(
      GIT,
      '.file-tree-row.is-gitignored .file-tree-name'
    );

    expect(row.opacity?.value).toBe('0.5');
    expect(name['font-style']?.value).not.toBe('italic');
  });

  it('expands file search over the title without a rule above the results', () => {
    const overlay = declarationsFor(BASE, '.file-tree-search-overlay');
    const results = declarationsFor(BASE, '.file-tree-search-results');
    const css = readFileSync(resolve(process.cwd(), BASE), 'utf8');

    const field = declarationsFor(
      BASE,
      '.file-tree-search-field > .astryx-field'
    );
    const input = declarationsFor(
      BASE,
      '.file-tree-search-input.astryx-text-input'
    );
    const options = declarationsFor(BASE, '.file-tree-search-options');

    expect(overlay.background?.value).toBe('var(--surface-card-strong)');
    expect(overlay.height).toBeUndefined();
    expect(overlay['max-height']).toBeUndefined();
    expect(field.flex?.value).toBe('1 1 auto');
    expect(field['min-width']?.value).toBe('0');
    expect(input.height?.value).toBe('24px');
    expect(options.flex?.value).toBe('0 0 auto');
    expect(options.width?.value).toBe('24px');
    expect(options.height?.value).toBe('24px');
    expect(results.border?.value).toBe('0');
    expect(results['border-top']).toBeUndefined();
    expect(css).toContain('@keyframes file-tree-search-expand');
    expect(css).toContain('prefers-reduced-motion: reduce');
    expect(css).not.toContain('mask-image:');
    expect(css).not.toContain('.astryx-power-search');
    expect(css).toContain('.file-tree-search-input');
  });
});
