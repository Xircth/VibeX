import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'postcss';
import { describe, expect, it } from 'vitest';
import enApp from '@/i18n/locales/en/app.json';
import zhCNApp from '@/i18n/locales/zh-CN/app.json';

const stylesheet = readFileSync(
  resolve(process.cwd(), 'src/styles/legacy/index.css'),
  'utf8'
);

function declarationsFor(selector: string) {
  const declarations = new Map<string, string>();

  parse(stylesheet).walkRules((rule) => {
    const normalizedSelector = rule.selector.replace(/\s+/g, ' ').trim();
    if (normalizedSelector !== selector) return;
    rule.walkDecls((declaration) => {
      declarations.set(declaration.prop, declaration.value);
    });
  });

  return declarations;
}

describe('welcome project surfaces', () => {
  it('describes VibeX as a super Agent Coding platform', () => {
    expect(zhCNApp.welcomePage.tagline).toBe('超级 Agent Coding 平台');
    expect(enApp.welcomePage.tagline).toBe('Super Agent Coding Platform');
  });

  it('paints the workspace Welcome tab canvas with the shell color', () => {
    const surface = declarationsFor('.workspace-welcome');
    const light = declarationsFor('.legacy-design');
    const dark = declarationsFor('.legacy-design.dark, .dark .legacy-design');

    expect(light.get('--welcome-canvas')).toBe('var(--surface-shell)');
    expect(dark.get('--welcome-canvas')).toBe('var(--surface-shell)');
    expect(surface.get('background')).toBe('var(--welcome-canvas)');
  });

  it('lays out workspace Welcome recommend cards in a 2x2 gray grid', () => {
    const recommend = declarationsFor('.workspace-welcome__recommend');
    const action = declarationsFor('.workspace-welcome__action');

    expect(recommend.get('grid-template-columns')).toBe(
      'repeat(2, minmax(0, 1fr))'
    );
    expect(action.get('background')).toBe('var(--surface-control)');
  });

  it('paints the home page with the shell color and leaves the logo without a hover fill', () => {
    const surface = declarationsFor('.welcome-page-surface');
    const light = declarationsFor('.legacy-design');
    const dark = declarationsFor('.legacy-design.dark, .dark .legacy-design');
    const logoHover = declarationsFor(
      ".home-logo-button, .home-logo-button:hover, .home-logo-button[data-state='open']"
    );

    expect(light.get('--welcome-page')).toBe('var(--surface-shell)');
    expect(dark.get('--welcome-page')).toBe('var(--surface-shell)');
    expect(surface.get('background')).toBe('var(--welcome-page)');
    expect(surface.get('position')).toBe('relative');
    expect(logoHover.get('background')).toBe('transparent');
    expect(logoHover.get('border-color')).toBe('transparent');
  });

  it('uses the themed dialog surface and popover shadow on forms', () => {
    const surface = declarationsFor('.welcome-project-form-surface');

    expect(surface.get('background')).toBe('var(--surface-dialog)');
    expect(surface.get('box-shadow')).toBe('var(--shadow-popover)');
  });

  it('keeps the description caret clear of the first glyph', () => {
    const textarea = declarationsFor(
      '.project-form-description-field textarea'
    );

    expect(textarea.get('padding-inline-start')).toBe('0.875rem');
    expect(textarea.get('text-indent')).toBe('0.125rem');
  });
});
