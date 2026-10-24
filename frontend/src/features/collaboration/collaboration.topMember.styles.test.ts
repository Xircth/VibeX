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
    expect(log['padding']?.value).toBe('2.75rem 1rem 0.75rem');
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

  it('reserves remove-button space so member-row hover does not shift layout', () => {
    const remove = declarationsFor('.collaboration-group-member-remove');
    expect(remove.display?.value).toBe('inline-flex');
    expect(remove.opacity?.value).toBe('0');
    const hover = declarationsFor(
      '.collaboration-group-member-row:hover .collaboration-group-member-remove, .collaboration-group-member-row:focus-within .collaboration-group-member-remove'
    );
    expect(hover.opacity?.value).toBe('1');
  });
});
