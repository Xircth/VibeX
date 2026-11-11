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

  it('shows the shared folder path as a compact copyable row', () => {
    const bar = declarationsFor('.collaboration-collection-pathbar');
    expect(bar.display?.value).toBe('flex');
    expect(bar['flex-direction']?.value).toBe('column');
    const row = declarationsFor('.collaboration-collection-path-row');
    expect(row.display?.value).toBe('flex');
    expect(row['min-width']?.value).toBe('0');
    const value = declarationsFor('.collaboration-collection-path-value');
    expect(value['text-overflow']?.value).toBe('ellipsis');
  });

  it('renders collection notes on a single inline row and prevents cards from flex-shrinking', () => {
    const card = declarationsFor('.collaboration-collection-card');
    expect(card['flex-shrink']?.value).toBe('0');

    const note = declarationsFor('.collaboration-collection-note');
    expect(note.display?.value).toBe('flex');
    expect(note['flex-direction']?.value).toBe('row');
    expect(note['align-items']?.value).toBe('center');

    const display = declarationsFor('.collaboration-collection-note-display');
    expect(display.display?.value).toBe('flex');
    expect(display.width?.value).toBe('100%');
    expect(display['white-space']?.value).toBe('nowrap');
    expect(display['text-overflow']?.value).toBe('ellipsis');

    const cardDelete = declarationsFor(
      '.collaboration-collection-card .collaboration-collection-delete-btn'
    );
    expect(cardDelete.opacity?.value).toBe('0');

    const assetsSegmented = declarationsFor('.collaboration-assets-segmented');
    expect(assetsSegmented.height?.value).toBe('1.625rem');
    expect(assetsSegmented['min-height']?.value).toBe('1.625rem');
  });

  it('keeps collection open-tab, copy, and delete icon buttons backgroundless', () => {
    const openTab = declarationsFor('.collaboration-collection-open-tab-btn');
    expect(openTab.background?.value).toBe('transparent');
    expect(openTab['background-color']?.value ?? 'transparent').toBe(
      'transparent'
    );
    expect(openTab.border?.value).toBe('none');

    const copy = declarationsFor('.collaboration-collection-copy-btn');
    expect(copy.background?.value).toBe('transparent');
    expect(copy['background-color']?.value ?? 'transparent').toBe(
      'transparent'
    );
    expect(copy.border?.value).toBe('none');

    const remove = declarationsFor('.collaboration-collection-delete-btn');
    expect(remove.background?.value).toBe('transparent');
    expect(remove['background-color']?.value ?? 'transparent').toBe(
      'transparent'
    );
    expect(remove.border?.value).toBe('none');
    expect(remove.color?.value).toBe('hsl(var(--destructive) / 0.72)');
  });
});
