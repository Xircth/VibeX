import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'postcss';
import { describe, expect, it } from 'vitest';

function stylesheetRoot() {
  return parse(
    readFileSync(resolve(process.cwd(), 'src/styles/legacy/index.css'), 'utf8')
  );
}

function declarationsFor(selector: string) {
  const declarations = new Map<string, string>();
  stylesheetRoot().walkRules((rule) => {
    if (rule.selector.replace(/\s+/g, ' ') !== selector) return;
    rule.walkDecls((declaration) => {
      declarations.set(declaration.prop, declaration.value);
    });
  });
  return declarations;
}

describe('quote token hover preview', () => {
  it('does not paint a hover ring on the quote chip', () => {
    const hover = declarationsFor(
      '.legacy-design .session-composer-editor [data-quote-token]:is(:hover, :focus-visible)'
    );
    const sharedHover = declarationsFor(
      '.legacy-design .session-composer-editor [data-preview-element-token]:is(:hover, :focus-visible), .legacy-design .session-composer-editor [data-quote-token]:is(:hover, :focus-visible)'
    );

    expect(hover.size).toBe(0);
    expect(sharedHover.size).toBe(0);
    expect(
      declarationsFor(
        '.legacy-design .session-composer-editor [data-quote-token]'
      ).get('cursor')
    ).toBe('help');
  });

  it('paints the selection toolbar as a pill with icon actions', () => {
    const toolbar = declarationsFor(
      '.legacy-design .conversation-selection-toolbar'
    );
    const action = declarationsFor(
      '.legacy-design .conversation-selection-toolbar button'
    );

    expect(toolbar.get('border-radius')).toBe('999px');
    expect(toolbar.get('background')).toBe('#ffffff');
    expect(toolbar.get('border')).toBe('1px solid var(--border-subtle)');
    expect(action.get('border-radius')).toBe('999px');
    expect(action.get('background')).toBe('transparent');
  });

  it('shows quote preview on a white surface with a hairline border', () => {
    const preview = declarationsFor('.legacy-design .quote-token-preview');

    expect(preview.get('background')).toBe('#ffffff');
    expect(preview.get('border')).toBe('1px solid var(--border-subtle)');
    expect(preview.get('box-shadow')).toBe('none');
  });
});
