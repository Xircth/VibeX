import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

const frontendRoot = process.cwd();
const legacyCss = readFileSync(
  resolve(frontendRoot, 'src/styles/legacy/index.css'),
  'utf8'
);
const collaborationCss = readFileSync(
  resolve(frontendRoot, 'src/features/collaboration/collaboration.css'),
  'utf8'
);

function declarationsFor(
  css: string,
  selector: string
): Record<string, string> {
  const declarations: Record<string, string> = {};
  parse(css).walkRules((rule: Rule) => {
    const normalized = rule.selector.replace(/\s+/g, ' ').trim();
    if (normalized !== selector) return;
    rule.walkDecls((declaration) => {
      declarations[declaration.prop] = declaration.value;
    });
  });
  return declarations;
}

describe('session status colors', () => {
  it('assigns gray, blue, amber, and green workbench tokens', () => {
    const tokens = declarationsFor(legacyCss, '.legacy-design');
    expect(tokens['--session-status-todo']).toBe('var(--text-muted)');
    expect(tokens['--session-status-inprogress'].replace(/\s+/g, ' ')).toBe(
      'color-mix( in srgb, var(--usage-blue-fg) 85%, var(--text-strong) )'
    );
    expect(tokens['--session-status-inreview'].replace(/\s+/g, ' ')).toBe(
      'color-mix( in srgb, var(--status-warning-text) 85%, var(--text-strong) )'
    );
    expect(tokens['--session-status-done'].replace(/\s+/g, ' ')).toBe(
      'color-mix( in srgb, var(--usage-green-fg) 80%, var(--text-strong) )'
    );
  });

  it('paints status dots from those tokens', () => {
    expect(
      declarationsFor(legacyCss, '.workspace-session-status--todo').background
    ).toBe('var(--session-status-todo)');
    expect(
      declarationsFor(legacyCss, '.workspace-session-status--inprogress')
        .background
    ).toBe('transparent');
    expect(
      declarationsFor(legacyCss, '.workspace-session-status--inprogress').color
    ).toBe('var(--session-status-inprogress)');
    expect(
      declarationsFor(legacyCss, '.workspace-session-status--inreview')
        .background
    ).toBe('var(--session-status-inreview)');
    expect(
      declarationsFor(legacyCss, '.workspace-session-status--done').background
    ).toBe('var(--session-status-done)');
  });

  it('shares lifecycle colors with collaboration status dots', () => {
    expect(collaborationCss).toContain('var(--session-status-inreview)');
    expect(collaborationCss).toContain('var(--session-status-inprogress)');
    expect(collaborationCss).toContain('var(--session-status-done)');
  });
});
