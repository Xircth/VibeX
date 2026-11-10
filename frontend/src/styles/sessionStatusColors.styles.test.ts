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
  it('assigns gray, yellow, red, and blue workbench tokens', () => {
    expect(legacyCss).toContain('--session-status-todo: var(--text-muted);');
    expect(legacyCss).toContain(
      '--session-status-inprogress: hsl(var(--warning));'
    );
    expect(legacyCss).toContain(
      '--session-status-inreview: hsl(var(--destructive));'
    );
    expect(legacyCss).toContain('--session-status-done: var(--usage-blue-fg);');
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

  it('paints collaboration review dots red instead of warning yellow', () => {
    expect(collaborationCss).toContain('var(--session-status-inreview)');
    expect(collaborationCss).toContain('var(--session-status-inprogress)');
    expect(collaborationCss).toContain('var(--session-status-done)');
  });
});
