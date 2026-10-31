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
  it('shares a 40px avatar token for DM and group-chat rows', () => {
    const shell = declarationsFor('.collaboration-shell');
    expect(shell['--collaboration-contact-avatar']?.value).toBe('2.5rem');

    const memberIcon = declarationsFor(
      '.collaboration-shell .collaboration-member-row .workspace-session-icon'
    );
    expect(memberIcon.width?.value).toBe(
      'var(--collaboration-contact-avatar, 2.5rem)'
    );
    expect(memberIcon.height?.value).toBe(
      'var(--collaboration-contact-avatar, 2.5rem)'
    );

    const shared = declarationsFor(
      '.collaboration-member-row .workspace-session-icon, .collaboration-contact-row-main > .collaboration-group-avatar'
    );
    expect(shared.width?.value).toBe(
      'var(--collaboration-contact-avatar, 2.5rem)'
    );
    expect(shared.height?.value).toBe(
      'var(--collaboration-contact-avatar, 2.5rem)'
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

    const hoveredSpaceMain = declarationsFor(
      '.collaboration-space-row:hover .collaboration-contact-row-main, .collaboration-space-row:focus-within .collaboration-contact-row-main'
    );
    const collapse = (value: string | undefined) =>
      (value ?? '')
        .replace(/\s+/g, ' ')
        .replace(/\(\s+/g, '(')
        .replace(/\s+\)/g, ')')
        .trim();
    expect(collapse(hoveredSpaceMain['-webkit-mask-image']?.value)).toBe(
      'linear-gradient(to right, #000 50%, transparent calc(100% - 3.5rem))'
    );
    expect(collapse(hoveredSpaceMain['mask-image']?.value)).toBe(
      'linear-gradient(to right, #000 50%, transparent calc(100% - 3.5rem))'
    );
  });

  it('paints the left contact pane with the shell gray', () => {
    const pane = declarationsFor('.collaboration-pane');
    expect(pane.background?.value).toBe('var(--surface-topbar)');
  });

  it('leaves the contact search field chrome to the shared Input', () => {
    const field = declarationsFor('.collaboration-global-search-field');
    expect(field.position?.value).toBe('relative');
    expect(field.flex?.value).toBe('1 1 0%');

    const icon = declarationsFor('.collaboration-global-search-icon');
    expect(icon.position?.value).toBe('absolute');
    expect(icon.left?.value).toBe('0.625rem');
    expect(icon['pointer-events']?.value).toBe('none');

    const input = declarationsFor(
      '.collaboration-global-search-header .collaboration-global-search-input'
    );
    expect(input.border).toBeUndefined();
    expect(input.background).toBeUndefined();
    expect(input['box-shadow']).toBeUndefined();
    expect(input['padding-left']?.value).toBe('2rem');

    const bare = declarationsFor('.collaboration-global-search-input');
    expect(bare.border).toBeUndefined();
    expect(bare.background).toBeUndefined();
    expect(bare['box-shadow']).toBeUndefined();
    expect(bare.outline).toBeUndefined();

    const divider = declarationsFor('.collaboration-global-search-divider');
    expect(divider.height).toBeUndefined();
    expect(divider.background).toBeUndefined();
  });

  it('draws a single dashed ring on a contact-group drop target', () => {
    const headerDrop = declarationsFor(
      '.collaboration-contact-section-header.is-drop-target'
    );
    expect(headerDrop['border-style']).toBeUndefined();
    expect(headerDrop['border-color']).toBeUndefined();

    const sectionDrop = declarationsFor(
      '.collaboration-contact-section.is-drop-target'
    );
    expect(sectionDrop['box-shadow']).toBeUndefined();
    expect(sectionDrop.outline?.value).toBe(
      '1px dashed hsl(var(--primary) / 0.45)'
    );
    expect(sectionDrop['outline-offset']?.value).toBe('-1px');
    expect(sectionDrop.background?.value).toBe('hsl(var(--primary) / 0.06)');
  });

  it('keeps the group chevron when the name is an input', () => {
    const nested = declarationsFor(
      '.collaboration-contact-section-header .collaboration-contact-group-input'
    );
    expect(nested.flex?.value).toBe('1 1 0%');
    expect(nested['min-width']?.value).toBe('0');
  });

  it('enlarges contact names and insets them from the row top', () => {
    const memberName = declarationsFor('.collaboration-member-name');
    expect(memberName['font-size']?.value).toBe('15px');
    const groupName = declarationsFor(
      '.collaboration-contact-name-line > .workspace-session-title'
    );
    expect(groupName['font-size']?.value).toBe('15px');

    const rowMain = declarationsFor('.collaboration-contact-row-main');
    expect(rowMain['padding-top']?.value).toBe('0.5rem');
    expect(rowMain['padding-bottom']?.value).toBe('0.3125rem');

    const nameCell = declarationsFor(
      '.collaboration-contact-row-main .collaboration-contact-name-line'
    );
    expect(nameCell['padding-top']?.value).toBe('0.1875rem');
    expect(nameCell['align-self']?.value).toBe('start');
    expect(nameCell['align-items']?.value).toBeUndefined();

    const nameLine = declarationsFor('.collaboration-contact-name-line');
    expect(nameLine.display?.value).toBe('flex');
    expect(nameLine['align-items']?.value).toBe('center');
  });

  it('keeps the unread count on the name line instead of the preview row', () => {
    const unread = declarationsFor(
      '.collaboration-contact-row-main .collaboration-chat-unread'
    );
    expect(unread['grid-column']).toBeUndefined();
    expect(unread['grid-row']).toBeUndefined();

    const meta = declarationsFor(
      '.collaboration-contact-name-line .collaboration-chat-meta'
    );
    expect(meta.flex?.value).toBe('none');
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

  it('vertically centers bot age and agent icon against the avatar', () => {
    const meta = declarationsFor(
      '.collaboration-contact-row-main > .workspace-session-meta-idle'
    );
    expect(meta['grid-row']?.value).toBe('1 / span 2');
    expect(meta['align-self']?.value).toBe('stretch');
    expect(meta.display?.value).toBe('inline-flex');
    expect(meta['align-items']?.value).toBe('center');
  });

  it('defaults the left contact pane to 16.65rem', () => {
    const twoColumn = declarationsFor(
      ".collaboration-shell[data-spaces='true'][data-thread='true'][data-preview='false'], .collaboration-shell[data-spaces='true'][data-thread='false'][data-preview='true']"
    );
    expect(twoColumn['grid-template-columns']?.value).toContain(
      'var(--collaboration-spaces-width, 16.65rem)'
    );
  });

  it('tightens the gap between contact rows', () => {
    const list = declarationsFor('.collaboration-pane-list-container');
    expect(list.gap?.value).toBe('0.25rem');
    const spaceList = declarationsFor('.collaboration-space-list');
    expect(spaceList.gap?.value).toBe('0.25rem');
    const body = declarationsFor('.collaboration-contact-section-body');
    expect(body.gap?.value).toBe('0.125rem');
  });
});
