import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'postcss';
import { describe, expect, it } from 'vitest';

const frontendRoot = process.cwd();
const css = readFileSync(
  resolve(frontendRoot, 'src/styles/legacy/index.css'),
  'utf8'
);
const design = readFileSync(resolve(frontendRoot, '../DESIGN.md'), 'utf8');
const conv = readFileSync(
  resolve(frontendRoot, 'src/styles/conversation/conv-variables.css'),
  'utf8'
);

function declarationsFor(match: (selector: string) => boolean) {
  const declarations = new Map<string, string>();
  parse(css).walkRules((rule) => {
    if (!match(rule.selector)) return;
    rule.walkDecls((declaration) => {
      declarations.set(declaration.prop, declaration.value);
    });
  });
  return declarations;
}

function isOpaqueColor(value: string | undefined) {
  if (!value) return false;
  if (value.includes(' / ')) return false;
  if (/#[0-9a-f]{8}$/i.test(value)) return false;
  return /#|hsl\(|rgb\(|var\(/.test(value);
}

describe('dark night scene tokens', () => {
  const dark = declarationsFor((selector) =>
    selector.includes('.legacy-design.dark')
  );
  const light = declarationsFor(
    (selector) =>
      selector.includes('.legacy-design') &&
      !selector.includes('.dark') &&
      !selector.includes('reduced-transparency')
  );

  it('documents Hangar, Mirage, and Pearl Ink as first-class dark materials', () => {
    expect(design).toContain('dark-primary: "#E7EBEF"');
    expect(design).toContain('dark-primary-foreground: "#0E1319"');
    expect(design).toContain('dark-shell-bg: "#0E1319"');
    expect(design).toContain('dark-content-bg: "#1F2430"');
    expect(design).toContain('dark-panel-bg: "#242936"');
    expect(design).toContain('Pearl Ink');
    expect(design).toContain('Hangar');
    expect(design).toContain(
      'Astryx `theme-neutral` chrome follows the same night scene'
    );
    expect(design).not.toContain('dark-switch-checked-border: "#ffffff57"');
    expect(design).toContain(
      'dark-switch-checked-track: "hsl(var(--primary))"'
    );
  });

  it('falls back to Pearl Ink when no accent is applied', () => {
    expect(dark.get('--_primary')).toBe('var(--accent-hsl, 210 20% 92%)');
    expect(dark.get('--_primary-foreground')).toBe(
      'var(--accent-foreground-hsl, 0 0% 9.02%)'
    );
  });

  it('paints workspace chrome from one topbar token', () => {
    expect(css).toContain('--surface-sidebar: var(--surface-topbar);');
    expect(css).toContain('--surface-right-panel: var(--surface-topbar);');
    expect(css).toContain('--surface-glass-solid: hsl(220 24% 96%);');
    expect(css).toMatch(
      /\.workspace-topbar,\s*\.workspace-chrome \{\s*background: var\(--surface-topbar\);/
    );
  });

  it('keeps chrome translucent and content fully opaque', () => {
    expect(dark.get('--surface-shell')).toBe('#0e1319');
    expect(dark.get('--surface-glass')).toMatch(/\/ 0\.55\)/);
    expect(isOpaqueColor(dark.get('--surface-content'))).toBe(true);
    expect(isOpaqueColor(dark.get('--surface-card-strong'))).toBe(true);
    expect(isOpaqueColor(dark.get('--surface-dialog'))).toBe(true);
    expect(dark.get('--surface-content')).toBe('#1f2430');
    expect(dark.get('--surface-card-strong')).toBe('#242936');
    expect(dark.get('--surface-dialog')).toBe('#242936');
  });

  it('gives dark chrome a moonlight edge and sidebar wash instead of deleting decoration', () => {
    expect(light.get('--surface-wash')).toContain('linear-gradient');
    expect(dark.get('--surface-wash')).toContain('210 32% 42%');
    expect(dark.get('--highlight-edge')).toBe('hsl(210 30% 80% / 0.12)');
    expect(css).toContain(
      'background: var(--surface-wash), var(--surface-sidebar);'
    );
    expect(css).not.toMatch(
      /\.dark \.settings-sidebar \{\s*background: var\(--surface-sidebar\);/
    );
  });

  it('routes grouped elevation through theme tokens instead of light-only ink', () => {
    expect(light.get('--shadow-surface')).toContain('hsl(220 36% 8% / 0.05)');
    expect(dark.get('--shadow-surface')).toBe(
      '0 1px 0 hsl(210 30% 80% / 0.08)'
    );
    expect(css).toContain('box-shadow: var(--shadow-surface);');
    expect(css).toContain('box-shadow: var(--shadow-composer);');
  });

  it('keeps conversation user bubbles on raised Mirage instead of a third gray', () => {
    expect(conv).toContain('--conv-user-bg: var(--surface-raised-control);');
    expect(conv).toContain('--conv-user-text: var(--text-strong);');
  });

  it('aligns shadcn dark background to Mirage so content islands do not fork', () => {
    expect(dark.get('--_background')).toBe('222 22% 15%');
    expect(dark.get('--_secondary')).toBe('223 20% 18%');
    expect(dark.get('--_console-background')).toBe('213 28% 8%');
  });

  it('routes switch, search, and input inset light through night-aware shadow tokens', () => {
    expect(light.get('--shadow-inset')).toBe(
      'inset 0 1px 0 hsl(0 0% 100% / 0.08)'
    );
    expect(dark.get('--shadow-inset')).toBe(
      'inset 0 1px 0 hsl(210 30% 80% / 0.08)'
    );
    expect(light.get('--shadow-switch-track')).toContain('hsl(220 36% 8%');
    expect(dark.get('--shadow-switch-track')).toContain('hsl(210 40% 2%');
    expect(css).toContain('box-shadow: var(--shadow-switch-track);');
    expect(css).toContain('box-shadow: var(--shadow-inset);');
    expect(css).not.toContain('hsl(0 0% 0% / 0.18)');
    expect(css).not.toContain('inset 0 1px 0 hsl(0 0% 100% / 0.04)');
  });

  it('paints welcome, quote, and selection chrome from tokens instead of light hex plus a dark patch', () => {
    expect(css).toContain('.welcome-page-surface {');
    expect(css).toMatch(
      /\.welcome-page-surface \{[\s\S]*?background: var\(--surface-dialog\);/
    );
    expect(css).toMatch(
      /\.welcome-project-form-surface \{[\s\S]*?background: var\(--surface-dialog\);/
    );
    expect(css).toMatch(
      /\.welcome-project-form-surface \{[\s\S]*?box-shadow:\s*var\(--shadow-popover\);/
    );
    expect(css).not.toContain('.dark .welcome-page-surface');
    expect(css).toContain('.legacy-design .conversation-selection-toolbar');
    expect(css).toMatch(
      /\.legacy-design \.conversation-selection-toolbar \{[\s\S]*?background: var\(--surface-dialog\);/
    );
    expect(css).toMatch(
      /\.legacy-design \.quote-token-preview \{[\s\S]*?background: var\(--surface-dialog\);/
    );
    expect(css).not.toContain(
      '.legacy-design.dark .conversation-selection-toolbar'
    );
  });

  it('collapses reduced-transparency popovers to the dialog token instead of hard-coded paper', () => {
    expect(css).not.toContain('--surface-popover: #fafafa;');
    expect(css).toContain('--surface-popover: var(--surface-dialog);');
    expect(css).not.toContain('--project-rail-glass: #202126;');
    expect(css).toContain('--project-rail-glass: var(--surface-glass-solid);');
  });

  it('maps Astryx dark chrome onto Hangar, Mirage, and the live accent', () => {
    expect(dark.get('--color-background-body')).toBe('#0e1319');
    expect(dark.get('--color-background-card')).toBe('#1f2430');
    expect(dark.get('--color-background-surface')).toBe('#242936');
    expect(dark.get('--color-background-popover')).toBe('#242936');
    expect(dark.get('--color-accent')).toBe('hsl(var(--primary))');
    expect(dark.get('--color-accent-muted')).toBe('hsl(var(--primary) / 0.12)');
    expect(dark.get('--color-on-accent')).toBe(
      'hsl(var(--primary-foreground))'
    );
    expect(dark.get('--color-text-accent')).toBe('hsl(var(--primary))');
    expect(dark.get('--color-icon-accent')).toBe('hsl(var(--primary))');
    expect(dark.get('--color-text-primary')).toBe('#e7ebef');
  });

  it('keeps the composer usage ring as a ring, not a pearl pie', () => {
    expect(dark.get('--composer-token-usage-ring')).toBe('hsl(var(--primary))');
    expect(dark.get('--composer-token-usage-core')).toBe(
      'var(--surface-content)'
    );
    expect(dark.get('--composer-token-usage-core')).not.toBe('#e7ebef');
  });

  it('keeps the agent question card opaque in both themes instead of deleting glass at night', () => {
    expect(css).toMatch(
      /\.agent-question-card \{[\s\S]*?background: var\(--surface-dialog\);/
    );
    expect(css).not.toContain('.dark .agent-question-card {');
  });
});

describe('night scene component islands', () => {
  const toast = readFileSync(
    resolve(frontendRoot, 'src/components/ui/toast.css'),
    'utf8'
  );
  const effort = readFileSync(
    resolve(
      frontendRoot,
      'src/components/tasks/effort-slider/effort-slider.css'
    ),
    'utf8'
  );
  const terminal = readFileSync(
    resolve(frontendRoot, 'src/utils/terminalTheme.ts'),
    'utf8'
  );

  it('does not fall back toast chrome to paper white', () => {
    expect(toast).not.toContain('#fafafa');
    expect(toast).toContain('background: var(--surface-popover);');
    expect(toast).toContain('inset 0 1px 0 var(--highlight-edge)');
  });

  it('gives the effort thumb a Pearl metal recipe in dark', () => {
    expect(effort).toContain('--effort-thumb-fill:');
    expect(effort).toContain('.dark .vx-effort-track');
    expect(effort).toContain('#e7ebef');
    expect(effort).toContain('var(--effort-thumb-fill)');
  });

  it('selects terminal text with Pearl Ink, matching Monaco', () => {
    expect(terminal).toContain("selectionBackground: '#E7EBEF4D'");
    expect(terminal).not.toContain("selectionBackground: '#3d4966'");
  });
});

describe('night scene file tree bridge', () => {
  const fileTree = readFileSync(
    resolve(frontendRoot, 'src/styles/file-tree/file-tree-base.css'),
    'utf8'
  );

  it('aliases Tahoe tokens instead of overwriting them with shadcn HSL', () => {
    expect(fileTree).toContain('--text-emphasis: var(--text-strong);');
    expect(fileTree).toContain('--text-quiet: var(--text-muted);');
    expect(fileTree).not.toContain('--text-strong: hsl(var(--_foreground));');
    expect(fileTree).not.toContain(
      '--surface-card-strong: hsl(var(--_background));'
    );
    expect(fileTree).not.toContain('--surface-hover: hsl(var(--_accent));');
    expect(fileTree).not.toContain('var(--text-low)');
    expect(fileTree).not.toContain('var(--error)');
  });
});
