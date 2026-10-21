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
const fileTree = readFileSync(
  resolve(frontendRoot, 'src/styles/file-tree/file-tree-base.css'),
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

  it('documents Astryx neutral surfaces and Pearl Ink accent', () => {
    expect(design).toContain('dark-primary: "#E7EBEF"');
    expect(design).toContain('dark-primary-foreground: "#0E1319"');
    expect(design).toContain('shell-bg: "#ffffff"');
    expect(design).toContain('content-bg: "#ffffff"');
    expect(design).toContain('dark-shell-bg: "#1b1b1b"');
    expect(design).toContain('dark-content-bg: "#262626"');
    expect(design).toContain('dark-panel-bg: "#262626"');
    expect(design).toContain('Pearl Ink');
    expect(design).toContain('same hex on macOS and Windows');
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

  it('paints workspace chrome from one opaque topbar token on every platform', () => {
    expect(css).toContain('--surface-sidebar: var(--surface-topbar);');
    expect(css).toContain('--surface-right-panel: var(--surface-shell);');
    expect(css).not.toContain('html.host-windows .legacy-design {');
    expect(light.get('--surface-shell')).toBe('#ffffff');
    expect(light.get('--surface-topbar')).toBe('#f1f1f1');
    expect(light.get('--surface-glass-solid')).toBe('var(--surface-shell)');
    expect(dark.get('--surface-shell')).toBe('#1b1b1b');
    expect(dark.get('--surface-topbar')).toBe('var(--surface-shell)');
    expect(dark.get('--surface-glass-solid')).toBe('var(--surface-shell)');
    expect(isOpaqueColor(light.get('--surface-shell'))).toBe(true);
    expect(isOpaqueColor(dark.get('--surface-shell'))).toBe(true);
  });

  it('keeps content and dialogs on the lifted Astryx surface', () => {
    expect(isOpaqueColor(light.get('--surface-content'))).toBe(true);
    expect(isOpaqueColor(dark.get('--surface-content'))).toBe(true);
    expect(isOpaqueColor(dark.get('--surface-card-strong'))).toBe(true);
    expect(isOpaqueColor(dark.get('--surface-dialog'))).toBe(true);
    expect(light.get('--surface-content')).toBe('#ffffff');
    expect(light.get('--surface-dialog')).toBe('#ffffff');
    expect(dark.get('--surface-content')).toBe('#262626');
    expect(dark.get('--surface-card-strong')).toBe('#262626');
    expect(dark.get('--surface-dialog')).toBe('#262626');
  });

  it('paints the settings nav with a gray-white-gray wash', () => {
    expect(light.get('--surface-wash')?.replace(/\s+/g, ' ')).toBe(
      'linear-gradient( 180deg, #e6e6e6 0%, #f3f3f3 24%, #ffffff 50%, #f3f3f3 76%, #e6e6e6 100% )'
    );
    expect(dark.get('--surface-wash')?.replace(/\s+/g, ' ')).toBe(
      'linear-gradient( 180deg, #262626 0%, #1b1b1b 28%, #1b1b1b 72%, #262626 100% )'
    );
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

  it('paints the session list with the page color', () => {
    expect(css).toMatch(
      /\.session-hub-sidebar \{\s*min-width: 0;\s*overflow: hidden;\s*background: var\(--surface-shell\);/
    );
  });

  it('paints the file tree with the page color', () => {
    expect(fileTree).toMatch(
      /\.file-tree-panel \{[\s\S]*?background: var\(--surface-shell\);/
    );
    expect(fileTree).not.toContain('--surface-topbar');
  });

  it('paints user bubbles gray on the white page', () => {
    expect(conv).toContain('--conv-user-bg: #f1f1f1;');
    expect(conv).toContain('--conv-user-bg: var(--surface-raised-control);');
    expect(conv).toContain('--conv-user-text: var(--text-strong);');
  });

  it('aligns shadcn dark background to the Astryx body', () => {
    expect(dark.get('--_background')).toBe('0 0% 10.59%');
    expect(dark.get('--_secondary')).toBe('0 0% 14.9%');
    expect(dark.get('--card')).toBe('0 0% 14.9%');
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
      /\.welcome-page-surface \{[\s\S]*?background: var\(--welcome-page\);/
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

  it('maps Astryx dark chrome onto the neutral body and the live accent', () => {
    expect(dark.get('--color-background-body')).toBe('#1b1b1b');
    expect(dark.get('--color-background-card')).toBe('#262626');
    expect(dark.get('--color-background-surface')).toBe('#262626');
    expect(dark.get('--color-background-popover')).toBe('#262626');
    expect(dark.get('--color-accent')).toBe('hsl(var(--primary))');
    expect(dark.get('--color-accent-muted')).toBe('hsl(var(--primary) / 0.12)');
    expect(dark.get('--color-on-accent')).toBe(
      'hsl(var(--primary-foreground))'
    );
    expect(dark.get('--color-text-accent')).toBe('hsl(var(--primary))');
    expect(dark.get('--color-icon-accent')).toBe('hsl(var(--primary))');
    expect(dark.get('--color-text-primary')).toBe('#fafafa');
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
    expect(toast).toContain('background: var(--surface-dialog);');
    expect(toast).toContain('var(--toast-shadow)');
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
