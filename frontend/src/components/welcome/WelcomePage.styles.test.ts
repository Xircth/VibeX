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
    if (rule.selector !== selector) return;
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

  it('uses the requested light background on the home page', () => {
    const surface = declarationsFor('.welcome-page-surface');

    expect(surface.get('background')).toBe('#fafafa');
  });

  it('uses the requested background and a four-sided shadow on forms', () => {
    const surface = declarationsFor('.welcome-project-form-surface');

    expect(surface.get('background')).toBe('#fafafa');
    expect(surface.get('box-shadow')).toMatch(/^0 0 /);
  });

  it('keeps the description caret clear of the first glyph', () => {
    const textarea = declarationsFor(
      '.project-form-description-field textarea'
    );

    expect(textarea.get('padding-inline-start')).toBe('0.875rem');
    expect(textarea.get('text-indent')).toBe('0.125rem');
  });
});
