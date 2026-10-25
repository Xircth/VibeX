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

describe('collaboration member-session preview layout', () => {
  it('keeps the session column filled and the composer from shrinking', () => {
    const frame = declarationsFor('.collaboration-preview-frame');
    expect(frame.display?.value).toBe('flex');
    expect(frame['flex-direction']?.value).toBe('column');
    expect(frame['min-height']?.value).toBe('0');
    expect(frame.height?.value).toBe('100%');
    expect(frame.overflow?.value).toBe('hidden');

    const child = declarationsFor('.collaboration-preview-frame > *');
    expect(child.display?.value).toBe('flex');
    expect(child['flex-direction']?.value).toBe('column');
    expect(child['min-height']?.value).toBe('0');
    expect(child.overflow?.value).toBe('hidden');

    const host = declarationsFor(
      '.collaboration-preview-frame [data-conversation-preview-host]'
    );
    expect(host.display?.value).toBe('flex');
    expect(host['flex-direction']?.value).toBe('column');
    expect(host['min-height']?.value).toBe('0');
    expect(host.flex?.value).toBe('1 1 auto');

    const composer = declarationsFor(
      '.collaboration-preview-frame .agent-question-composer-stack'
    );
    expect(composer['flex-shrink']?.value).toBe('0');

    const editor = declarationsFor(
      '.collaboration-preview-frame .session-composer-editor'
    );
    expect(editor['min-height']?.value).toBe('3.25rem');
  });
});
