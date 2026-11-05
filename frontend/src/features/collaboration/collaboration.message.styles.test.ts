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
    if (rule.parent?.type === 'atrule') return;
    const normalized = rule.selector.replace(/\s+/g, ' ').trim();
    const selectors = rule.selectors.map((item) =>
      item.replace(/\s+/g, ' ').trim()
    );
    if (normalized !== selector && !selectors.includes(selector)) return;
    rule.walkDecls((declaration) => {
      declarations[declaration.prop] = {
        value: declaration.value,
        important: declaration.important,
      };
    });
  });
  return declarations;
}

function keyframesFor(name: string): Record<string, Record<string, string>> {
  const css = readFileSync(
    resolve(process.cwd(), 'src/features/collaboration/collaboration.css'),
    'utf8'
  );
  const frames: Record<string, Record<string, string>> = {};
  parse(css).walkAtRules('keyframes', (rule) => {
    if (rule.params !== name) return;
    rule.walkRules((frame) => {
      const decls: Record<string, string> = {};
      frame.walkDecls((declaration) => {
        decls[declaration.prop] = declaration.value;
      });
      frames[frame.selector] = decls;
    });
  });
  return frames;
}

describe('collaboration assistant list and message cluster chrome', () => {
  it('sizes assistant-list chips from the list-avatar token', () => {
    const chip = declarationsFor('.collaboration-top-member-chip');
    expect(chip.height?.value).toBe('var(--collaboration-list-avatar, 2.5rem)');
    expect(chip['font-size']?.value).toBe('0.8125rem');

    const stack = declarationsFor('.collaboration-top-member-stack-item');
    expect(stack.width?.value).toBe('var(--collaboration-list-avatar, 2.5rem)');
    expect(stack.height?.value).toBe(
      'var(--collaboration-list-avatar, 2.5rem)'
    );
  });

  it('keeps message avatars at 40px with name type 1px larger', () => {
    const shell = declarationsFor('.collaboration-shell');
    expect(shell['--collaboration-assistant-avatar']?.value).toBe('2.5rem');
  });

  it('places the 40px avatar at the bottom-left of the bubble', () => {
    const row = declarationsFor('.collaboration-message-row');
    expect(row['align-items']?.value).toBe('flex-end');

    const slot = declarationsFor('.collaboration-message-avatar-slot');
    expect(slot.width?.value).toBe(
      'var(--collaboration-assistant-avatar, 2.5rem)'
    );

    const avatar = declarationsFor('.collaboration-message-avatar');
    expect(avatar.width?.value).toBe(
      'var(--collaboration-assistant-avatar, 2.5rem)'
    );
    expect(avatar.height?.value).toBe(
      'var(--collaboration-assistant-avatar, 2.5rem)'
    );
    expect(avatar.overflow?.value).toBe('visible');

    const name = declarationsFor('.collaboration-message-name');
    expect(name['font-size']?.value).toBe('0.9375rem');
  });

  it('uses a filled bubble and WeChat-style cluster radii', () => {
    const bubble = declarationsFor(
      '.collaboration-message .conv-assistant-msg'
    );
    expect(bubble.background?.value).toBe('var(--surface-subtle)');
    expect(bubble['border-radius']?.value).toBe('var(--radius)');
    expect(bubble.width?.value).toBe('fit-content');

    const inner = declarationsFor('.collaboration-member-bubble');
    expect(inner.background).toBeUndefined();
    expect(inner.padding).toBeUndefined();

    const collapse = (value: string | undefined) =>
      (value ?? '').replace(/\s+/g, ' ').trim();

    const start = declarationsFor(
      ".collaboration-message[data-cluster='start'] .conv-assistant-msg"
    );
    expect(collapse(start['border-radius']?.value)).toBe(
      'var(--radius) var(--radius) var(--collaboration-cluster-radius) var(--collaboration-cluster-radius)'
    );

    const middle = declarationsFor(
      ".collaboration-message[data-cluster='middle'] .conv-assistant-msg"
    );
    expect(collapse(middle['border-radius']?.value)).toBe(
      'var(--collaboration-cluster-radius)'
    );

    const end = declarationsFor(
      ".collaboration-message[data-cluster='end'] .conv-assistant-msg"
    );
    expect(collapse(end['border-radius']?.value)).toBe(
      'var(--collaboration-cluster-radius) var(--collaboration-cluster-radius) var(--radius) var(--radius)'
    );
  });

  it('nests the reaction badge on the bubble corner', () => {
    const shell = declarationsFor('.collaboration-bubble-shell');
    expect(shell.position?.value).toBe('relative');
    expect(shell.overflow?.value).toBe('visible');

    const badge = declarationsFor('.collaboration-bubble-reaction');
    expect(badge.position?.value).toBe('absolute');
    expect(badge.top?.value).toBe('-0.55rem');
    expect(badge.right?.value).toBe('-0.4rem');
    expect(badge['border-radius']?.value).toBe('999px');
  });

  it('paints the reply capsule as a full-width muted bar', () => {
    const capsule = declarationsFor('.collaboration-reply-capsule');
    expect(capsule.display?.value).toBe('flex');
    expect(capsule.width?.value).toBe('100%');
    expect(capsule.background?.value).toBe('var(--surface-subtle)');
    expect(capsule['border-radius']?.value).toBe('var(--radius)');

    const text = declarationsFor('.collaboration-reply-capsule-text');
    expect(text.overflow?.value).toBe('hidden');
    expect(text['text-overflow']?.value).toBe('ellipsis');
    expect(text['white-space']?.value).toBe('nowrap');
  });

  it('places user delivery ticks below the bubble', () => {
    const userRow = declarationsFor('.collaboration-bubble-outer-row--user');
    expect(userRow['flex-direction']?.value).toBe('column');
    expect(userRow['align-items']?.value).toBe('flex-end');
  });

  it('vertically centers the working avatar with the status copy', () => {
    const status = declarationsFor('.collaboration-working-status');
    expect(status.display?.value).toBe('flex');
    expect(status['align-items']?.value).toBe('center');

    const slot = declarationsFor('.collaboration-working-avatar-slot');
    expect(slot.display?.value).toBe('flex');
    expect(slot['align-items']?.value).toBe('center');
    expect(slot['justify-content']?.value).toBe('center');
    expect(slot.width?.value).toBe('1.25rem');
    expect(slot.height?.value).toBe('1.25rem');
    expect(slot.position?.value).toBe('relative');
    expect(slot.top?.value).toBe('-1px');

    const avatar = declarationsFor('.collaboration-working-avatar');
    expect(avatar.display?.value).toBe('block');
    expect(avatar.width?.value).toBe('1.25rem');
    expect(avatar.height?.value).toBe('1.25rem');

    const copy = declarationsFor('.collaboration-working-copy');
    expect(copy.display?.value).toBe('flex');
    expect(copy['align-items']?.value).toBe('center');
    expect(copy['line-height']?.value).toBe('1.25rem');
    expect(copy.height?.value).toBe('1.25rem');
  });

  it('flips the working avatar horizontally when cycling', () => {
    const slot = declarationsFor('.collaboration-working-avatar-slot');
    expect(slot.perspective?.value).toBe('2.5rem');

    const flipper = declarationsFor(
      '.collaboration-working-avatar-flipper.is-flipping'
    );
    expect(flipper.animation?.value).toContain(
      'collaboration-working-avatar-flip'
    );
    expect(flipper['transform-style']?.value).toBe('preserve-3d');

    const back = declarationsFor('.collaboration-working-avatar-side--back');
    expect(back.transform?.value).toBe('rotateY(180deg)');
    expect(
      back['backface-visibility']?.value ??
        back['-webkit-backface-visibility']?.value
    ).toBe('hidden');
  });

  it('pulses working-status copy between faint and strong text', () => {
    const copy = declarationsFor('.collaboration-working-copy');
    expect(copy.animation?.value).toContain('collaboration-working-pulse');
    expect(copy.color?.value).toBe('var(--text-strong)');
    const pulse = keyframesFor('collaboration-working-pulse');
    expect(JSON.stringify(pulse)).toContain('--text-faint');
    expect(JSON.stringify(pulse)).toContain('--text-strong');
  });

  it('raises the log fade so 40px chips stay clear of the first bubble', () => {
    const log = declarationsFor('.collaboration-thread-log');
    expect(log['padding']?.value).toBe('3.75rem 2.75rem 0.75rem 1rem');
    expect(log['mask-image']?.value).toContain('3.5rem');
  });

  it('insets user bubbles and the piano-key nav from the right edge', () => {
    const log = declarationsFor('.collaboration-thread-log');
    expect(log['padding']?.value).toBe('3.75rem 2.75rem 0.75rem 1rem');

    const nav = declarationsFor(
      '.collaboration-thread .conv-message-nav-anchor'
    );
    expect(nav.right?.value).toBe('0.75rem');
    expect(nav.display?.value).toBe('flex');
    expect(nav['align-items']?.value).toBe('center');

    const rail = declarationsFor(
      '.collaboration-thread .conv-message-nav-rail'
    );
    expect(rail.position?.value).toBe('relative');
    expect(rail.top?.value).toBe('auto');
    expect(rail.transform?.value).toBe('none');
    expect(rail['max-height']?.value).toBe('100%');
  });

  it('caps user bubbles to content width and right-aligns attachments above the bubble', () => {
    const userMsg = declarationsFor('.collaboration-message .conv-user-msg');
    expect(userMsg.display?.value).toBe('flex');
    expect(userMsg['flex-direction']?.value).toBe('column');
    expect(userMsg['align-items']?.value).toBe('flex-end');
    expect(userMsg.width?.value).toBe('fit-content');
    expect(userMsg['max-width']?.value).toBe('75%');
    expect(userMsg['margin-left']?.value).toBe('auto');

    const attachments = declarationsFor(
      ".collaboration-message .conv-user-msg [data-testid='user-message-attachments']"
    );
    expect(attachments['margin-left']?.value).toBe('auto');
    expect(attachments['align-self']?.value).toBe('flex-end');

    const bubble = declarationsFor(
      '.collaboration-message .vibex-user-message .conv-user-bubble'
    );
    expect(bubble.width?.value).toBe('fit-content');
    expect(bubble['max-width']?.value).toBe('100%');
  });

  it('paints user message bubbles in space with the user primary accent color', () => {
    const userMsg = declarationsFor('.collaboration-message .conv-user-msg');
    expect(userMsg['--conv-user-bg']?.value).toBe('hsl(var(--primary))');
    expect(userMsg['--conv-user-text']?.value).toBe(
      'hsl(var(--primary-foreground))'
    );

    const bubble = declarationsFor(
      '.collaboration-message .vibex-user-message .conv-user-bubble'
    );
    expect(bubble.background?.value).toBe('hsl(var(--primary))');
    expect(bubble.color?.value).toBe('hsl(var(--primary-foreground))');
  });

  it('draws cross-chat notice lines in the sender avatar color, thicker toward the copy', () => {
    const lines = declarationsFor(
      '.collaboration-cross-chat-notice::before, .collaboration-cross-chat-notice::after'
    );
    expect(lines.height?.value).toBe('2px');
    expect(lines.opacity?.value).toBe('0.45');
    expect(lines.background?.value).toBe(
      'var(--cross-chat-line-color, var(--border-subtle))'
    );

    const before = declarationsFor('.collaboration-cross-chat-notice::before');
    expect(before['clip-path']?.value).toBe(
      'polygon(0 38%, 100% 18%, 100% 82%, 0 62%)'
    );

    const after = declarationsFor('.collaboration-cross-chat-notice::after');
    expect(after['clip-path']?.value).toBe(
      'polygon(0 18%, 100% 38%, 100% 62%, 0 82%)'
    );
  });

  it('vertically centers the cross-chat group avatar with the group name', () => {
    const chip = declarationsFor(
      '.collaboration-cross-chat-notice .collaboration-member-mention-chip'
    );
    expect(chip.display?.value).toBe('inline-flex');
    expect(chip['align-items']?.value).toBe('center');

    const avatar = declarationsFor(
      '.collaboration-cross-chat-notice .collaboration-cross-chat-group-chip .collaboration-group-avatar'
    );
    expect(avatar.display?.value).toBe('block');
    expect(avatar.flex?.value).toBe('none');
  });

  it('paints mention names with fill-color so composer typing keeps default color', () => {
    const name = declarationsFor('.collaboration-member-mention-name');
    expect(name.color?.value).toBe('inherit');
    expect(name['-webkit-text-fill-color']?.value).toBe(
      'var(--member-mention-color)'
    );
    expect(name['-webkit-text-fill-color']?.important).toBe(true);
  });

  it('keeps inline ask_user_question cards in normal flow as a standalone message container without outer bubble chrome', () => {
    const card = declarationsFor(
      '.collaboration-card-actions .agent-question-card'
    );
    expect(card.position?.value).toBe('relative');
    expect(card.bottom?.value).toBe('auto');
    expect(card.left?.value).toBe('auto');
    expect(card.right?.value).toBe('auto');
    expect(card.transform?.value).toBe('none');
    expect(card.width?.value).toBe('min(26rem, calc(100vw - 7rem))');

    const container = declarationsFor(
      '.collaboration-message .collaboration-question-card-msg'
    );
    expect(container.padding?.value).toBe('0');
    expect(container.background?.value).toBe('transparent');
    expect(container.border?.value).toBe('0');
    expect(container['box-shadow']?.value).toBe('none');
  });

  it('caps collapsed message bubbles with a lower-half fade and centered expand-all capsule', () => {
    const collapsedBody = declarationsFor(
      ".collaboration-bubble-collapsible[data-collapsed='true'] .collaboration-bubble-collapsible-body"
    );
    expect(collapsedBody['max-height']?.value).toBe(
      'var(--collaboration-bubble-max-height, 15rem)'
    );
    expect(collapsedBody.overflow?.value).toBe('hidden');
    expect(collapsedBody['mask-image']?.value).toContain('linear-gradient');

    const fade = declarationsFor('.collaboration-bubble-collapsible-fade');
    expect(fade.position?.value).toBe('absolute');
    expect(fade.height?.value).toBe('50%');
    expect(fade.display?.value).toBe('flex');
    expect(fade['align-items']?.value).toBe('flex-end');
    expect(fade['justify-content']?.value).toBe('center');
    expect(fade['padding-bottom']?.value).toBe('0.25rem');
    expect(fade['pointer-events']?.value).toBe('none');

    const pill = declarationsFor('.collaboration-bubble-expand-pill');
    expect(pill['pointer-events']?.value).toBe('auto');
    expect(pill['border-radius']?.value).toBe('999px');
    expect(pill.display?.value).toBe('inline-flex');

    const footer = declarationsFor('.collaboration-bubble-collapsible-footer');
    expect(footer.display?.value).toBe('flex');
    expect(footer['justify-content']?.value).toBe('center');
  });

  it('keeps the left sidebar top toolbar and supervisor slot fixed while only the space list scrolls', () => {
    const container = declarationsFor('.collaboration-pane-list-container');
    expect(container.display?.value).toBe('flex');
    expect(container['flex-direction']?.value).toBe('column');
    expect(container.overflow?.value).toBe('hidden');

    const toolbar = declarationsFor('.collaboration-top-toolbar');
    expect(toolbar['flex-shrink']?.value).toBe('0');

    const supervisor = declarationsFor('.collaboration-supervisor-slot');
    expect(supervisor['flex-shrink']?.value).toBe('0');

    const spaceList = declarationsFor('.collaboration-space-list');
    expect(spaceList.flex?.value).toBe('1 1 0%');
    expect(spaceList['min-height']?.value).toBe('0');
    expect(spaceList['overflow-y']?.value).toBe('auto');
  });
});
