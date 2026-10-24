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

describe('collaboration contact row chrome', () => {
  it('shares a 72px avatar token for DM and group-chat rows', () => {
    const shell = declarationsFor('.collaboration-shell');
    expect(shell['--collaboration-contact-avatar']?.value).toBe('4.5rem');

    const memberIcon = declarationsFor(
      '.collaboration-shell .collaboration-member-row .workspace-session-icon'
    );
    expect(memberIcon.width?.value).toBe(
      'var(--collaboration-contact-avatar, 4.5rem)'
    );
    expect(memberIcon.height?.value).toBe(
      'var(--collaboration-contact-avatar, 4.5rem)'
    );

    const shared = declarationsFor(
      '.collaboration-member-row .workspace-session-icon, .collaboration-contact-row-main > .collaboration-group-avatar'
    );
    expect(shared.width?.value).toBe(
      'var(--collaboration-contact-avatar, 4.5rem)'
    );
    expect(shared.height?.value).toBe(
      'var(--collaboration-contact-avatar, 4.5rem)'
    );
  });

  it('overlays hover actions so member and group rows keep a stable height', () => {
    const actions = declarationsFor(
      '.collaboration-space-hover-actions, .collaboration-member-hover-actions'
    );
    expect(actions.position?.value).toBe('absolute');
    expect(actions.opacity?.value).toBe('0');
    expect(actions['max-width']).toBeUndefined();
    expect(actions.overflow).toBeUndefined();

    const shown = declarationsFor(
      '.collaboration-space-row:hover .collaboration-space-hover-actions, .collaboration-space-row:focus-within .collaboration-space-hover-actions, .collaboration-member-row:hover .collaboration-member-hover-actions, .collaboration-member-row:focus-within .collaboration-member-hover-actions'
    );
    expect(shown.opacity?.value).toBe('1');
    expect(shown['max-width']).toBeUndefined();
    expect(shown.overflow).toBeUndefined();

    const hiddenMeta = declarationsFor(
      '.collaboration-space-row:hover .collaboration-space-meta--hide-on-hover, .collaboration-space-row:focus-within .collaboration-space-meta--hide-on-hover, .collaboration-member-row:hover .collaboration-member-meta--hide-on-hover, .collaboration-member-row:focus-within .collaboration-member-meta--hide-on-hover'
    );
    expect(hiddenMeta.visibility?.value).toBe('hidden');
    expect(hiddenMeta.display).toBeUndefined();
  });

  it('paints the left contact pane with the shell gray', () => {
    const pane = declarationsFor('.collaboration-pane');
    expect(pane.background?.value).toBe('var(--surface-topbar)');
  });

  it('leaves the contact search field chrome to the shared Input', () => {
    const input = declarationsFor(
      '.collaboration-global-search-header .collaboration-global-search-input'
    );
    expect(input.border).toBeUndefined();
    expect(input.background).toBeUndefined();
    expect(input['box-shadow']).toBeUndefined();
    expect(input.flex?.value).toBe('1 1 0%');
  });

  it('keeps member and group contact rows on the same outer box', () => {
    const rows = declarationsFor(
      '.collaboration-shell .collaboration-member-row, .collaboration-shell .collaboration-space-row'
    );
    expect(rows['padding-block']?.value).toBe('0');
    expect(rows['min-height']?.value).toBe('0');
    expect(rows.border?.value).toBe('0');
    expect(rows.overflow?.value).toBe('visible');
  });
});
