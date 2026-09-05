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
    if (
      rule.selector !== selector ||
      (rule.parent?.type === 'atrule' && rule.parent.name !== 'layer')
    ) {
      return;
    }
    rule.walkDecls((declaration) => {
      declarations.set(declaration.prop, declaration.value);
    });
  });
  return declarations;
}

function declarationsMatching(fragment: string) {
  const declarations = new Map<string, string>();
  stylesheetRoot().walkRules((rule) => {
    const matches = rule.selector
      .split(',')
      .some((part) => part.trim().endsWith(fragment));
    if (!matches) return;
    if (rule.parent?.type === 'atrule' && rule.parent.name !== 'layer') return;
    rule.walkDecls((declaration) => {
      declarations.set(declaration.prop, declaration.value);
    });
  });
  return declarations;
}

describe('settings page alignment', () => {
  it('keeps form pages flush with the sidebar instead of adding extra top inset', () => {
    const content = declarationsFor('.settings-page .settings-content');

    expect(content.get('width')).toBe('min(100%, 860px)');
    expect(content.get('margin')).toBe('0 auto');
    expect(content.get('padding')).toBe('0 0 1.5rem');
  });

  it('uses the same content width for the product plugin catalog', () => {
    const page = declarationsFor('.settings-page .product-plugins-page');

    expect(page.get('width')).toBe('min(100%, 860px)');
    expect(page.get('margin')).toBe('0 auto');
    expect(page.get('padding')).toBe('0 0 1.5rem');
  });

  it('matches chat-channel and plugin catalog titles to other settings headings', () => {
    const chatTitle = declarationsFor(
      '.settings-page .chat-channel-heading__copy h2'
    );
    const chatCopy = declarationsFor(
      '.settings-page .chat-channel-heading__copy p'
    );
    const pluginCopy = declarationsFor(
      '.settings-page .product-plugins-header p'
    );
    const sectionTitle = declarationsFor(
      '.settings-page .settings-card__header h3'
    );
    const sectionCopy = declarationsFor(
      '.settings-page .settings-card__header p'
    );

    expect(chatTitle.get('font-size')).toBe(sectionTitle.get('font-size'));
    expect(chatCopy.get('font-size')).toBe(sectionCopy.get('font-size'));
    expect(pluginCopy.get('font-size')).toBe('calc(0.875rem - 2px)');
    expect(chatTitle.get('display')).toBe('flex');
  });

  it('lets the plugin README scroll inside the clipped plugins pane', () => {
    const page = declarationsFor('.settings-page .product-plugins-page');
    const detail = declarationsFor(
      '.settings-page .product-plugin-detail-page'
    );
    const readme = declarationsFor('.settings-page .product-plugin-readme');
    const contents = declarationsFor('.settings-page .product-plugin-contents');

    expect(page.get('overflow')).toBe('hidden');
    expect(detail.get('min-height')).toBe('0');
    expect(readme.get('overflow-y')).toBe('auto');
    expect(readme.get('min-height')).toBe('0');
    expect(readme.get('flex')).toBe('1 1 auto');
    expect(contents.get('overflow-y')).toBe('auto');
    expect(contents.get('min-height')).toBe('0');
  });

  it('keeps the import track compact and accent-filled', () => {
    const track = declarationsFor('.import-local-progress__track');
    const count = declarationsFor('.import-local-progress__count');

    expect(track.get('height')).toBe('6px');
    expect(track.get('border-radius')).toBe('999px');
    expect(track.get('background')).toBe('var(--surface-control)');
    expect(count.get('font-variant-numeric')).toBe('tabular-nums');
  });

  it('keeps updater release notes in a bounded scrolling well', () => {
    const notes = declarationsFor('.settings-page .settings-release-notes');

    expect(notes.get('max-height')).toBe('14rem');
    expect(notes.get('overflow')).toBe('auto');
  });

  it('keeps setting labels and descriptions on the same type scale', () => {
    const description = declarationsFor(
      '.settings-page .settings-row__description'
    );
    const label = declarationsFor(
      '.settings-page .settings-row :where(label, .settings-row__label)'
    );

    expect(description.get('font-size')).toBe('0.875rem');
    expect(label.get('font-size')).toBe('0.875rem');

    const pairingDescription = declarationsFor(
      '.settings-page .settings-pairing-devices__row .settings-row__description'
    );
    expect(pairingDescription.get('font-size')).toBe('0.875rem');
  });

  it('centers project names in the worktree list items', () => {
    const item = declarationsFor(
      '.settings-page .settings-worktree-board__item'
    );

    expect(item.get('display')).toBe('flex');
    expect(item.get('align-items')).toBe('center');
    expect(item.get('min-height')).toBe('2.5rem');
  });

  it('does not patch the Windows save bar with a LiquidGlass centering transform', () => {
    const glass = declarationsFor(
      'html.host-windows .settings-page .settings-action-bar__glass'
    );

    expect(glass.get('transform')).toBeUndefined();
  });

  it('keeps the Agent header on one row when switching Agents', () => {
    const header = declarationsFor('.settings-page .agent-detail-header');
    const title = declarationsFor(
      '.settings-page .agent-detail-header-title h2'
    );
    const description = declarationsFor(
      '.settings-page .agent-detail-header-copy p'
    );
    const actions = declarationsFor(
      '.settings-page .agent-detail-header-actions'
    );

    expect(header.get('display')).toBe('grid');
    expect(header.get('grid-template-columns')).toBe('minmax(0, 1fr) auto');
    expect(header.get('flex-wrap')).toBeUndefined();
    expect(title.get('white-space')).toBe('nowrap');
    expect(description.get('white-space')).toBe('nowrap');
    expect(actions.get('flex-wrap')).toBe('nowrap');
  });

  it('keeps the page scrollbar as a thumb without a track', () => {
    const pane = declarationsFor('.settings-page [data-settings-content]');
    const agentScroll = declarationsFor(
      '.settings-page .agent-settings-scroll'
    );
    const gutter = declarationsMatching(
      '[data-settings-content]::-webkit-scrollbar'
    );
    const paneThumb = declarationsMatching(
      '[data-settings-content]::-webkit-scrollbar-thumb'
    );
    const paneTrack = declarationsMatching(
      '[data-settings-content]::-webkit-scrollbar-track'
    );

    expect(pane.get('padding-inline-end')).toBe('1.5rem');
    expect(pane.get('scrollbar-gutter')).toBe('auto');
    expect(agentScroll.get('padding-inline-end')).toBe('0.75rem');
    expect(gutter.get('width')).toBe('6px');
    expect(gutter.get('background')).toBe('transparent');
    expect(paneThumb.get('border')).toBe('none');
    expect(paneTrack.get('background')).toBe('transparent');
  });

  it('clips model provider rows to the list radius', () => {
    const list = declarationsFor('.settings-page .agent-model-provider-list');
    expect(list.get('overflow')).toBe('hidden');
    expect(list.get('border-radius')).toBe('var(--radius)');
  });

  it('paints the plugin catalog list as a white settings surface', () => {
    const list = declarationsFor('.settings-page .product-plugin-list');
    const surface = declarationsFor('.settings-surface');
    const card = declarationsFor('.settings-page .settings-card');

    expect(list.get('background')).toBe(surface.get('background'));
    expect(list.get('background')).toBe('var(--surface-card-strong)');
    expect(card.get('background')).toBe('var(--surface-content)');
  });

  it('keeps grouped settings surfaces lifted so loading shells show their shadow', () => {
    const surface = declarationsFor('.settings-surface');
    expect(surface.get('border-radius')).toBe('var(--radius)');
    expect(surface.get('box-shadow')?.replace(/\s+/g, ' ')).toBe(
      '0 1px 2px hsl(220 36% 8% / 0.05), 0 10px 30px hsl(220 36% 8% / 0.06)'
    );
  });

  it('animates loading bones outside the settings page wrapper', () => {
    const line = declarationsMatching('.agent-settings-loading-line');
    expect(line.get('animation')).toContain('agent-settings-loading-pulse');
    expect(line.get('background')).toBe('var(--surface-control)');
  });

  it('shrinks the preflight version-to-status spacer before wrapping the version row', () => {
    const layout = declarationsFor('.settings-page .agent-preflight-layout');
    expect(layout.get('grid-template-areas')).toBe(
      "'identity information controls'"
    );
    expect(layout.get('grid-template-columns')).toBe(
      '160px minmax(0, 1fr) auto'
    );

    const wrapQueries: string[] = [];
    stylesheetRoot().walkAtRules('container', (atrule) => {
      if (!atrule.params.includes('agent-preflight')) return;
      wrapQueries.push(atrule.params);
    });
    expect(wrapQueries).toHaveLength(1);
    const maxWidth = wrapQueries[0].match(/max-width:\s*(\d+)px/);
    expect(maxWidth).not.toBeNull();
    // Default settings window leaves the preflight grid at ~750px. Wrapping
    // at 760px made the stacked version row the common case.
    expect(Number(maxWidth![1])).toBe(400);
  });
});
