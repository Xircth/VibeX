import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

const STYLESHEET = resolve(
  process.cwd(),
  'src/components/previews/markdownFileProse.css'
);

function rules(): Array<{
  selector: string;
  decls: Record<string, string>;
}> {
  const css = readFileSync(STYLESHEET, 'utf8');
  const result: Array<{ selector: string; decls: Record<string, string> }> = [];
  parse(css).walkRules((rule: Rule) => {
    const decls: Record<string, string> = {};
    rule.walkDecls((declaration) => {
      decls[declaration.prop] = declaration.value;
    });
    result.push({
      selector: rule.selector.replace(/\s+/g, ' ').trim(),
      decls,
    });
  });
  return result;
}

function ruleIncluding(...parts: string[]) {
  const found = rules().find((rule) =>
    parts.every((part) => rule.selector.includes(part))
  );
  expect(found, `missing rule with ${parts.join(' + ')}`).toBeTruthy();
  return found!;
}

describe('markdown file prose chrome', () => {
  it('matches conversation markdown body metrics on Preview and RichText', () => {
    const root = ruleIncluding('.markdown-file-prose', '[contenteditable]');
    expect(root.decls['font-size']).toBe('13px');
    expect(root.decls['line-height']).toBe('1.7');

    const body = ruleIncluding(
      '.markdown-file-prose',
      ":is(p, li, [role='paragraph'])"
    );
    expect(body.decls['font-size']).toBe('13px');
    expect(body.decls['line-height']).toBe('1.7');
  });

  it('flattens headings to the conversation markdown scale', () => {
    const headings = ruleIncluding(
      '.markdown-file-prose',
      ':is(h1, h2, h3, h4, h5, h6)'
    );
    expect(headings.decls['font-size']).toBe('1em');
    expect(headings.decls['font-weight']).toBe('650');
    expect(headings.decls['line-height']).toBe('1.7');
  });

  it('uses an 8px block rhythm', () => {
    const rhythm = rules().find(
      (rule) =>
        rule.selector.includes('.markdown-file-prose') &&
        rule.selector.includes('+ :is(') &&
        rule.decls['margin-top'] === '8px'
    );
    expect(rhythm).toBeTruthy();
  });
});
