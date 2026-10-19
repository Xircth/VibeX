import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

const STYLESHEET = resolve(
  process.cwd(),
  'src/styles/conversation/conv-tools.css'
);

function declarationsFor(
  selector: string
): Record<string, { value: string; important: boolean }> {
  const css = readFileSync(STYLESHEET, 'utf8');
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

describe('composer todo popover', () => {
  it('draws a bordered frame and hides the list scrollbar', () => {
    const popover = declarationsFor('.composer-todo-popover.tahoe-popover');
    const list = declarationsFor('.composer-todo-list');
    const webkit = declarationsFor('.composer-todo-list::-webkit-scrollbar');
    const nestedCard = declarationsFor(
      '.composer-todo-popover .conv-plan-card'
    );
    const streamCard = declarationsFor('.conv-plan-card');

    expect(popover.border?.value).toBe('1px solid var(--border-strong)');
    expect(popover.width?.value).toBe(
      'min(22rem, var(--radix-popper-anchor-width, calc(100vw - 24px)))'
    );
    expect(popover['max-width']?.value).toBe(
      'var(--radix-popper-anchor-width, calc(100vw - 24px))'
    );
    expect(popover.overflow?.value).toBe('hidden');
    expect(list.overflow?.value).toBe('auto');
    expect(list['scrollbar-width']?.value).toBe('none');
    expect(webkit.display?.value).toBe('none');
    expect(nestedCard.border?.value).toBe('0');
    expect(streamCard.border?.value).toBe(
      '1px solid var(--conv-border-subtle)'
    );
  });
});

describe('composer session popover', () => {
  it('caps height, scrolls sessions, and pins the new-session action', () => {
    const popover = declarationsFor('.composer-session-popover');
    const list = declarationsFor('.composer-session-list');
    const create = declarationsFor('.composer-session-new');

    expect(popover.display?.value).toBe('flex');
    expect(popover['flex-direction']?.value).toBe('column');
    expect(popover['max-height']?.value.replace(/\s+/g, ' ').trim()).toBe(
      'min( 24rem, var(--radix-dropdown-menu-content-available-height, calc(100dvh - 8rem)), calc(100dvh - 8rem) )'
    );
    expect(popover.overflow?.value).toBe('hidden');
    expect(list['min-height']?.value).toBe('0');
    expect(list.overflow?.value).toBe('auto');
    expect(create['flex-shrink']?.value).toBe('0');
  });
});

describe('conversation tool-call typography', () => {
  it('matches message-stream font, size, weight, and line-height', () => {
    const rules = declarationsFor('.astryx-chat-tool-calls');

    expect(rules['--font-family-body']?.value).toBe('var(--font-ui)');
    expect(rules['--font-family-code']?.value).toBe('var(--font-ui)');
    expect(rules['--text-supporting-size']?.value).toBe('13px');
    expect(rules['--text-supporting-weight']?.value).toBe('400');
    expect(rules['--text-supporting-leading']?.value).toBe('1.7');
    expect(rules['--font-weight-medium']?.value).toBe('400');
    expect(rules['font-family']?.value).toBe('var(--font-ui)');
    expect(rules['font-size']?.value).toBe('13px');
    expect(rules['font-weight']?.value).toBe('400');
    expect(rules['line-height']?.value).toBe('1.7');
  });

  it('shrinks only the grouped tool-call summary', () => {
    const label = declarationsFor(
      ".vibex-tool-call-batch > [role='button'] > span:nth-child(2)"
    );

    expect(label['--text-supporting-size']?.value).toBe('12px');
    expect(label['--text-supporting-leading']?.value).toBe('1.5');
    expect(label['white-space']?.value).toBe('nowrap');
    expect(label.overflow?.value).toBe('hidden');
    expect(label['min-width']?.value).toBe('0');
  });

  it('keeps mixed activity summaries on one clipped line', () => {
    const label = declarationsFor('.conv-activity-header > span');

    expect(label['white-space']?.value).toBe('nowrap');
    expect(label.overflow?.value).toBe('hidden');
    expect(label['min-width']?.value).toBe('0');
    expect(label.flex?.value).toBe('1');
  });
});

describe('conversation tool-call fold spacing and hover', () => {
  it('restores Astryx spacing-2 around tool-call folds, not ungrouped rows', () => {
    const fold = declarationsFor(
      '.conv-activity-batch, .conv-assistant-body .astryx-chat-tool-calls.vibex-tool-call-batch'
    );

    expect(fold['margin-block-start']?.value).toBe('8px');
    expect(fold['margin-block-end']?.value).toBe('8px');
  });

  it('spaces thinking from neighboring kinds inside a nested fold, not tool from tool', () => {
    const thinkingGap = declarationsFor(
      '.conv-nested-scroll > * + .conv-thinking, .conv-nested-scroll > .conv-thinking + *'
    );

    expect(thinkingGap['margin-top']?.value).toBe('10px');
    expect(
      declarationsFor(
        '.conv-nested-scroll > .astryx-chat-tool-calls + .astryx-chat-tool-calls'
      )['margin-top']
    ).toBeUndefined();
  });

  it('keeps CallRow hover radius inside nested overflow panes', () => {
    const nested = declarationsFor('.conv-nested-scroll');
    const expanded = declarationsFor(
      ".astryx-chat-tool-calls [role='button'][aria-expanded='true'] + div"
    );
    const expandedInner = declarationsFor(
      ".astryx-chat-tool-calls [role='button'][aria-expanded='true'] + div > div"
    );

    expect(nested['padding-inline-start']?.value).toBe('4px');
    expect(nested['padding-inline-end']?.value).toBe('4px');
    expect(nested['margin-inline-start']?.value).toBe('-4px');
    expect(nested['margin-inline-end']?.value).toBe('-4px');
    expect(nested['overflow-y']?.value).toBe('auto');
    expect(expanded['padding-inline-start']?.value).toBe('4px');
    expect(expanded['padding-inline-start']?.important).toBe(true);
    expect(expanded['padding-inline-end']?.value).toBe('4px');
    expect(expanded['padding-inline-end']?.important).toBe(true);
    expect(expanded['margin-inline-start']?.value).toBe('-4px');
    expect(expanded['margin-inline-end']?.value).toBe('-4px');
    expect(expandedInner.overflow?.value).toBe('visible');
  });
});
