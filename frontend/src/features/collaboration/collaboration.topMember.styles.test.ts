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

describe('collaboration top assistant list chrome', () => {
  it('overlays the expanded assistant list instead of taking message-area flow', () => {
    const bar = declarationsFor('.collaboration-top-member-bar');
    expect(bar.position?.value).toBe('absolute');
    expect(bar.background?.value).toBe('transparent');
    expect(bar.width?.value).toBe('auto');
  });

  it('drops gray hover wash under the assistant list', () => {
    const expandHover = declarationsFor(
      '.collaboration-top-member-expand-trigger:hover, .collaboration-top-member-collapsed-bar .collaboration-top-member-expand-trigger:hover'
    );
    expect(expandHover.background?.value).toBe('transparent');

    const chipHover = declarationsFor(
      '.collaboration-top-member-chip:hover, .collaboration-top-member-chip:focus-visible'
    );
    expect(chipHover.background?.value).toBe('transparent');
  });

  it('uses a transparent stack slot so bot avatars can show a white silhouette stroke', () => {
    const item = declarationsFor('.collaboration-top-member-stack-item');
    expect(item.background?.value).toBe('transparent');
    expect(item['box-shadow']?.value).toBe('none');
  });

  it('stacks collapsed member avatars with more than a corner of overlap', () => {
    const overlap = declarationsFor(
      '.collaboration-top-member-stack-item + .collaboration-top-member-stack-item'
    );
    expect(overlap['margin-left']?.value).toBe(
      'calc(var(--collaboration-list-avatar, 2.5rem) * -0.55)'
    );
  });

  it('keeps the expanded details button and chevron in one chrome without chevron hover fill', () => {
    const chrome = declarationsFor('.collaboration-top-member-chrome');
    expect(chrome.display?.value).toBe('inline-flex');
    expect(chrome['border-radius']?.value).toBe('999px');

    const toggleHover = declarationsFor(
      '.collaboration-top-member-toggle:hover, .collaboration-top-member-toggle:focus-visible'
    );
    expect(toggleHover.background?.value).toBe('transparent');
  });

  it('renders expanded assistant chips without a rounded fill', () => {
    const chip = declarationsFor('.collaboration-top-member-chip');
    expect(chip.background?.value).toBe('transparent');
    expect(chip.border?.value).toBe('0');
    expect(chip['border-radius']?.value).toBe('0');
    expect(chip['font-weight']?.value).toBe('700');
  });

  it('fades the message log at the top instead of clipping it', () => {
    const log = declarationsFor('.collaboration-thread-log');
    expect(log['mask-image']?.value).toContain('linear-gradient');
    expect(log['padding']?.value).toBe('3.75rem 2.75rem 0.75rem 1rem');
  });

  it('animates delayed-message member chips on the GPU compositor via ::after transform and opacity instead of background-position or box-shadow', () => {
    const chip = declarationsFor(
      '.collaboration-top-member-chip.has-delayed-messages'
    );
    expect(chip.animation).toBeUndefined();
    expect(chip['background-size']).toBeUndefined();

    const after = declarationsFor(
      '.collaboration-top-member-chip.has-delayed-messages::after'
    );
    expect(after.animation?.value).toContain(
      'collaboration-member-flowing-blue-glow'
    );
    expect(after['will-change']?.value).toBe('transform, opacity');

    const css = readFileSync(
      resolve(process.cwd(), 'src/features/collaboration/collaboration.css'),
      'utf8'
    );
    const frameProps = new Set<string>();
    parse(css).walkAtRules('keyframes', (rule) => {
      if (rule.params !== 'collaboration-member-flowing-blue-glow') return;
      rule.walkDecls((decl) => {
        frameProps.add(decl.prop);
      });
    });
    expect(frameProps.has('transform')).toBe(true);
    expect(frameProps.has('opacity')).toBe(true);
    expect(frameProps.has('background-position')).toBe(false);
    expect(frameProps.has('box-shadow')).toBe(false);
  });
});

describe('collaboration group details chrome', () => {
  it('centers a pill tab strip with muted unselected labels', () => {
    const tabs = declarationsFor('.collaboration-group-details-tabs');
    expect(tabs['justify-content']?.value).toBe('center');
    const tab = declarationsFor('.collaboration-group-details-tab');
    expect(tab['border-radius']?.value).toBe('999px');
    expect(tab.background?.value).toBe('transparent');
    const selected = declarationsFor(
      ".collaboration-group-details-tab[aria-selected='true']"
    );
    expect(selected.background?.value).toBe('var(--surface-control)');
  });

  it('reveals the remove control on row hover without shifting layout', () => {
    const row = declarationsFor('.collaboration-group-member-row');
    expect(row['border-radius']?.value).toBe('var(--radius)');
    const hoverRow = declarationsFor(
      '.collaboration-group-member-row:hover, .collaboration-group-member-row:focus-within'
    );
    expect(hoverRow.background?.value).toBe('var(--surface-control-hover)');

    const action = declarationsFor('.collaboration-group-member-action');
    expect(action['flex-shrink']?.value).toBe('0');
    expect(action.opacity?.value).toBe('0');
    expect(action['pointer-events']?.value).toBe('none');
    const hover = declarationsFor(
      '.collaboration-group-member-row:hover .collaboration-group-member-action, .collaboration-group-member-row:focus-within .collaboration-group-member-action'
    );
    expect(hover.opacity?.value).toBe('1');
    expect(hover['pointer-events']?.value).toBe('auto');

    const star = declarationsFor('.collaboration-bot-avatar-lead-star');
    expect(star.position?.value).toBe('absolute');
    expect(star.color?.value).toBe('hsl(var(--warning))');
    expect(star.right?.value).toBe('-12%');
    expect(star.bottom?.value).toBe('-12%');
  });
});
