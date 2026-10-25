import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

function declarationsFor(
  selector: string
): Record<string, { value: string; important: boolean }> {
  const css = readFileSync(
    resolve(process.cwd(), 'src/features/collaboration/collaboration.css'),
    'utf8'
  );
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

describe('collaboration group and assistant details width', () => {
  it('caps the group details, collection, and members tab bodies', () => {
    expect(
      declarationsFor('.collaboration-group-details-usage')['max-width']?.value
    ).toBe('22.5rem');
    expect(
      declarationsFor('.collaboration-group-members')['max-width']?.value
    ).toBe('22.5rem');
    expect(
      declarationsFor('.collaboration-group-details-body')['max-width']?.value
    ).toBe('28rem');
  });

  it('caps assistant details, collection, and customize separately', () => {
    expect(
      declarationsFor('.collaboration-assistant-details-session')['max-width']
        ?.value
    ).toBe('32rem');
    expect(
      declarationsFor(
        '.collaboration-assistant-details-body.collaboration-group-details-body'
      )['max-width']?.value
    ).toBe('28rem');
    expect(
      declarationsFor('.collaboration-assistant-details-customize')['max-width']
        ?.value
    ).toBe('24rem');
  });

  it('centers the add-member control', () => {
    const wrap = declarationsFor('.collaboration-group-add-member-wrap');
    expect(wrap['justify-content']?.value).toBe('center');
  });

  it('caps the create-group bot list height', () => {
    expect(
      declarationsFor('.collaboration-create-member-list')['max-height']?.value
    ).toBe('14.5rem');
    expect(
      declarationsFor('.collaboration-create-member-list')['overflow']?.value
    ).toBe('auto');
  });
});
