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
  const normalizedTarget = selector.replace(/\s+/g, ' ').trim();
  stylesheetRoot().walkRules((rule) => {
    if (
      rule.selector.replace(/\s+/g, ' ').trim() !== normalizedTarget ||
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

describe('desktop window chrome insets', () => {
  it('reserves macOS traffic-light and Windows control space on overlay chrome', () => {
    const macos = declarationsFor(
      "html.tauri-desktop[data-host-platform='macos'] .window-chrome"
    );
    const windows = declarationsFor(
      'html.tauri-desktop.host-windows .window-chrome'
    );

    expect(macos.get('padding-left')).toBe('4.75rem');
    expect(windows.get('padding-right')).toBe('6.5rem');
  });

  it('marks drag regions as Windows app-region drag and keeps controls no-drag', () => {
    const drag = declarationsFor('[data-tauri-drag-region]');
    expect(drag.get('-webkit-app-region')).toBe('drag');
    expect(drag.get('app-region')).toBe('drag');

    const noDrag = declarationsMatching('.window-chrome button');
    expect(noDrag.get('-webkit-app-region')).toBe('no-drag');
    expect(noDrag.get('app-region')).toBe('no-drag');
  });

  it('hides the traffic-light divider except on the macOS desktop shell', () => {
    const rule = declarationsFor('.window-chrome-leading-rule');
    const macos = declarationsFor(
      "html.tauri-desktop[data-host-platform='macos'] .window-chrome-leading-rule"
    );

    expect(rule.get('display')).toBe('none');
    expect(macos.get('display')).toBe('block');
  });
});

describe('settings page alignment', () => {
  it('keeps form pages flush with the sidebar instead of adding extra top inset', () => {
    const content = declarationsFor('.settings-page .settings-content');
    const sections = declarationsFor('.settings-page .settings-sections');
    const section = declarationsFor('.settings-page .settings-section');

    expect(content.get('width')).toBe('min(100%, 860px)');
    expect(content.get('margin')).toBe('0 auto');
    expect(content.get('padding')).toBe('0 0 1.5rem');
    expect(sections.get('grid-template-columns')).toBe('minmax(0, 1fr)');
    expect(sections.get('min-width')).toBe('0');
    expect(section.get('min-width')).toBe('0');
  });

  it('uses the same content width for the product plugin catalog', () => {
    const page = declarationsFor('.settings-page .product-plugins-page');

    expect(page.get('width')).toBe('min(100%, 860px)');
    expect(page.get('margin')).toBe('0 auto');
    expect(page.get('padding')).toBe('0 0 1.5rem');
  });

  it('matches chat-channel and plugin catalog titles to other settings headings', () => {
    const pageTitle = declarationsFor(
      '.settings-page .settings-page-header h2'
    );
    const chatTitle = declarationsFor(
      '.settings-page .chat-channel-heading__copy h2'
    );
    const chatCopy = declarationsFor(
      '.settings-page .chat-channel-heading__copy p'
    );
    const pluginCopy = declarationsFor(
      '.settings-page .product-plugins-header .chat-channel-heading__copy p'
    );
    const sectionTitle = declarationsFor(
      '.settings-page .settings-card__header h3'
    );
    const sectionCopy = declarationsFor(
      '.settings-page .settings-card__header p'
    );

    expect(pageTitle.get('font-size')).toBe('1.25rem');
    expect(chatTitle.get('font-size')).toBe(pageTitle.get('font-size'));
    expect(sectionTitle.get('font-size')).toBe('0.875rem');
    expect(chatCopy.get('font-size')).toBe(sectionCopy.get('font-size'));
    expect(pluginCopy.get('font-size')).toBe('0.75rem');
    expect(chatTitle.get('display')).toBe('flex');
  });

  it('lets the plugin README scroll inside the clipped plugins pane', () => {
    const page = declarationsFor('.settings-page .product-plugins-page');
    const detail = declarationsFor(
      '.settings-page .product-plugin-detail-page'
    );
    const readme = declarationsFor('.settings-page .product-plugin-readme');
    const contents = declarationsFor('.settings-page .product-plugin-contents');
    const configShell = declarationsFor(
      '.settings-page .product-plugin-config-shell'
    );

    expect(page.get('overflow')).toBe('hidden');
    expect(detail.get('min-height')).toBe('0');
    expect(readme.get('overflow-y')).toBe('auto');
    expect(readme.get('min-height')).toBe('0');
    expect(readme.get('flex')).toBe('1 1 auto');
    expect(contents.get('overflow-y')).toBe('auto');
    expect(contents.get('min-height')).toBe('0');
    expect(configShell.get('overflow-y')).toBe('auto');
    expect(configShell.get('min-height')).toBe('0');
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

  it('keeps setting labels larger than descriptions in the 4-tier type scale', () => {
    const description = declarationsFor(
      '.settings-page .settings-row__description'
    );
    const label = declarationsFor(
      '.settings-page .settings-row :where(label, .settings-row__label)'
    );

    expect(label.get('font-size')).toBe('0.8125rem');
    expect(description.get('font-size')).toBe('0.75rem');

    const pairingDescription = declarationsFor(
      '.settings-page .settings-pairing-devices__row .settings-row__description'
    );
    expect(pairingDescription.get('font-size')).toBe('0.75rem');
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

  it('keeps section heading actions above the collapse control and aligns actions with the description subrow', () => {
    const heading = declarationsFor('.settings-page .agent-section-heading');
    const describedHeading = declarationsFor(
      '.settings-page .agent-section-heading.has-description'
    );
    const subrow = declarationsFor(
      '.settings-page .agent-section-heading-subrow'
    );
    const description = declarationsFor(
      '.settings-page .agent-section-description'
    );
    const toggle = declarationsFor(
      '.settings-page .agent-section-heading-toggle'
    );
    const actions = declarationsFor(
      '.settings-page .agent-section-heading-actions'
    );

    expect(heading.get('display')).toBe('flex');
    expect(describedHeading.get('flex-direction')).toBe('column');
    expect(describedHeading.get('align-items')).toBe('stretch');
    expect(subrow.get('display')).toBe('flex');
    expect(subrow.get('align-items')).toBe('center');
    expect(subrow.get('justify-content')).toBe('space-between');
    expect(subrow.get('min-height')).toBe('32px');
    expect(description.get('color')).toBe('var(--text-muted)');
    expect(description.get('font-size')).toBe('0.75rem');
    expect(toggle.get('min-width')).toBe('0');
    expect(toggle.get('overflow')).toBe('hidden');
    expect(actions.get('position')).toBe('relative');
    expect(actions.get('z-index')).toBe('1');
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
    expect(pane.get('scrollbar-width')).toBeUndefined();
    expect(pane.get('scrollbar-color')).toBeUndefined();
    expect(agentScroll.get('padding-inline-end')).toBe('0.75rem');
    expect(agentScroll.get('scrollbar-width')).toBeUndefined();
    expect(agentScroll.get('scrollbar-color')).toBeUndefined();
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

  it('nests OpenCode catalog and form flush inside the standard provider form', () => {
    const nested = declarationsMatching(
      '.agent-model-provider-form .agent-provider-catalog'
    );
    expect(nested.get('margin')).toBe('0 0 16px');
    expect(nested.get('padding-top')).toBe('0');
    expect(nested.get('border-top')).toBe('0');
  });

  it('keeps the OpenCode catalog search icon out of the typed text', () => {
    const field = declarationsFor(
      '.settings-page .opencode-provider-catalog-search input'
    );
    expect(field.get('padding')).toBe('0 12px 0 38px');
    expect(field.get('appearance')).toBe('none');
    expect(field.get('-webkit-appearance')).toBe('none');
  });

  it('paints the plugin catalog list with the settings item surface', () => {
    const list = declarationsFor('.settings-page .product-plugin-list');
    const surface = declarationsFor('.settings-surface');
    const card = declarationsFor('.settings-page .settings-card');

    expect(list.get('background')).toBe(surface.get('background'));
    expect(list.get('background')).toBe('var(--surface-card-strong)');
    expect(list.get('border-radius')).toBe(surface.get('border-radius'));
    expect(list.get('border-radius')).toBe('var(--radius)');
    expect(card.get('background')).toBe('var(--surface-content)');
  });

  it('stacks saved Host rows as independent control surfaces', () => {
    const list = declarationsFor('.settings-page .settings-saved-hosts');
    const row = declarationsFor(
      '.settings-page .settings-saved-hosts .settings-host-row'
    );

    expect(list.get('background')).toBe('transparent');
    expect(list.get('gap')).toBe('8px');
    expect(row.get('background')).toBe('var(--surface-control)');
  });

  it('keeps the Host update action beside the saved-host summary', () => {
    const header = declarationsFor('.settings-page .settings-host-row__header');
    const summary = declarationsFor(
      '.settings-page .settings-host-row__summary'
    );
    const update = declarationsFor('.settings-page .settings-host-row__update');

    expect(header.get('display')).toBe('flex');
    expect(summary.get('flex')).toBe('1');
    expect(update.get('flex-shrink')).toBe('0');
  });

  it('keeps grouped settings surfaces lifted so loading shells show their shadow', () => {
    const surface = declarationsFor('.settings-surface');
    expect(surface.get('border-radius')).toBe('var(--radius)');
    expect(surface.get('box-shadow')?.replace(/\s+/g, ' ')).toBe(
      'var(--shadow-surface)'
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

  it('renders the preflight update action as a transparent primary action chip', () => {
    const update = declarationsFor(
      '.settings-page .agent-preflight-status.is-update'
    );
    const hover = declarationsFor(
      '.settings-page button.agent-preflight-status.is-update:hover:not(:disabled)'
    );

    expect(update.get('background')).toBe('transparent');
    expect(update.get('border')).toBe('0');
    expect(update.get('color')).toBe('hsl(var(--primary))');
    expect(hover.get('background')).toBe('hsl(var(--foreground) / 0.1)');
    expect(hover.get('border-color')).toBe('transparent');
  });

  it('aligns preflight status badges and circular icons with the high-contrast agent-auth-status badge style', () => {
    const authSuccess = declarationsFor(
      '.settings-page .agent-auth-status.is-success'
    );
    const authWarning = declarationsFor(
      '.settings-page .agent-auth-status.is-warning'
    );
    const passChip = declarationsFor(
      '.settings-page .agent-preflight-status.is-pass'
    );
    const warningChip = declarationsFor(
      '.settings-page .agent-preflight-status.is-warning'
    );
    const failChip = declarationsFor(
      '.settings-page .agent-preflight-status.is-fail'
    );
    const passIcon = declarationsFor(
      '.settings-page .agent-preflight-status-icon.is-pass'
    );
    const warningIcon = declarationsFor(
      '.settings-page .agent-preflight-status-icon'
    );
    const failIcon = declarationsFor(
      '.settings-page .agent-preflight-status-icon.is-fail'
    );

    expect(passChip.get('border-color')).toBe(authSuccess.get('border-color'));
    expect(passChip.get('background')).toBe(authSuccess.get('background'));
    expect(passChip.get('color')).toBe(authSuccess.get('color'));
    expect(passIcon.get('border-color')).toBe(authSuccess.get('border-color'));
    expect(passIcon.get('background')).toBe(authSuccess.get('background'));
    expect(passIcon.get('color')).toBe(authSuccess.get('color'));

    expect(warningChip.get('border-color')).toBe(
      authWarning.get('border-color')
    );
    expect(warningChip.get('background')).toBe(authWarning.get('background'));
    expect(warningChip.get('color')).toBe(authWarning.get('color'));
    expect(warningIcon.get('background')).toBe(authWarning.get('background'));
    expect(warningIcon.get('color')).toBe(authWarning.get('color'));

    expect(failChip.get('background')).toBe('hsl(var(--destructive) / 0.1)');
    expect(failChip.get('color')).toBe('var(--status-danger-text)');
    expect(failIcon.get('background')).toBe('hsl(var(--destructive) / 0.1)');
    expect(failIcon.get('color')).toBe('var(--status-danger-text)');
  });

  it('paints the global settings search box with an opaque recessed gray fill while keeping non-input control surfaces translucent on Windows', () => {
    const searchInput = declarationsFor('.settings-search-input');
    const windowsTokens = declarationsFor('html.host-windows .legacy-design');

    expect(searchInput.get('background-color')).toBe(
      'var(--surface-control-solid)'
    );
    expect(windowsTokens.get('--surface-control')).toBeUndefined();
    expect(windowsTokens.get('--surface-control-hover')).toBeUndefined();
  });

  it('styles the settings sidebar as a floating rounded component with a gray-white wash and #1B1B1B / #E3E3E3 button bases', () => {
    const sidebar = declarationsFor('.settings-sidebar');
    const settingsPage = declarationsFor('.settings-page');
    const quickToggle = declarationsFor(
      '.settings-page .agent-codex-quick-toggle'
    );
    const statusChip = declarationsFor(
      '.settings-page .agent-preflight-status'
    );
    const updateButton = declarationsFor(
      '.settings-page button.agent-preflight-status'
    );

    const themeChoices = declarationsFor(
      '.settings-page .settings-theme-choices'
    );
    const selectedThemeCard = declarationsFor(
      ".settings-page .settings-theme-card[data-selected='true']"
    );

    const sidebarScrollbar = declarationsFor(
      ':is( .settings-sidebar, .settings-nav-groups, .settings-search-results )::-webkit-scrollbar'
    );
    const navGroups = declarationsFor('.settings-nav-groups');
    const searchResults = declarationsFor('.settings-search-results');
    const sectionTitle = declarationsFor('.settings-nav-section__title');
    const sectionDivider = declarationsFor(
      '.settings-nav-section + .settings-nav-section::before'
    );
    const quickToggleLabel = declarationsFor(
      '.settings-page .agent-codex-quick-toggle strong'
    );

    expect(sidebar.get('border-radius')).toBe('var(--radius)');
    expect(sidebar.get('overflow')).toBe('hidden');
    expect(navGroups.get('overflow-y')).toBe('auto');
    expect(navGroups.get('margin-inline-end')).toBe('-0.5rem');
    expect(navGroups.get('padding-inline-end')).toBe('0.5rem');
    expect(searchResults.get('margin-inline-end')).toBe('-0.5rem');
    expect(searchResults.get('padding-inline-end')).toBe('0.5rem');
    expect(sidebar.get('background')).toBe(
      'var(--surface-wash), var(--surface-sidebar)'
    );
    expect(sidebarScrollbar.get('width')).toBe('3px');
    expect(navGroups.get('gap')).toBe('0.625rem');
    expect(sectionTitle.get('color')).toBe('var(--text-faint)');
    expect(sectionTitle.get('opacity')).toBe('0.65');
    expect(sectionDivider.size).toBe(0);
    expect(settingsPage.get('--surface-sidebar')).toBeUndefined();
    expect(settingsPage.get('--surface-wash')).toBeUndefined();
    expect(settingsPage.get('background-color')).toBe('var(--surface-shell)');
    for (const surface of [
      '--surface-content',
      '--surface-card',
      '--surface-card-strong',
    ]) {
      expect(settingsPage.get(surface)).toBe('var(--surface-settings-item)');
    }
    expect(declarationsFor('.settings-titlebar').get('background')).toBe(
      'var(--surface-shell)'
    );
    expect(settingsPage.get('--settings-button-primary-bg')).toBe(
      'hsl(var(--primary))'
    );
    expect(settingsPage.get('--settings-button-secondary-bg')).toBe(
      'var(--surface-track)'
    );
    expect(quickToggle.get('background')).toBe('var(--surface-control)');
    expect(quickToggle.get('height')).toBe('40px');
    expect(quickToggle.get('max-height')).toBe('40px');
    expect(quickToggle.get('align-self')).toBe('end');
    expect(quickToggleLabel.get('white-space')).toBe('nowrap');
    expect(updateButton.get('font-size')).toBe(statusChip.get('font-size'));
    expect(updateButton.get('font-size')).toBe('0.6875rem');
    expect(themeChoices.get('grid-template-columns')).toBe(
      'repeat(3, minmax(0, 1fr))'
    );
    expect(selectedThemeCard.get('border-color')).toBe(
      'var(--settings-button-primary-bg)'
    );
  });

  it('lets the settings menu sit flush on the window background without a floating panel', () => {
    const flush = declarationsFor('.settings-sidebar.settings-sidebar--flush');

    expect(flush.get('border')).toBe('none');
    expect(flush.get('border-radius')).toBe('0');
    expect(flush.get('background')).toBe('transparent');
    expect(flush.get('box-shadow')).toBe('none');
    expect(flush.get('backdrop-filter')).toBe('none');
    expect(flush.get('-webkit-backdrop-filter')).toBe('none');
  });

  it('keeps list search inputs padded past the leading icon and styles top tab switchers like the Agent Bar', () => {
    const searchIcon = declarationsFor(
      '.settings-page .settings-list-search > svg'
    );
    const searchInput = declarationsMatching('.settings-list-search > input');
    const agentBar = declarationsMatching('.agent-management-bar');
    const topTabBar = declarationsMatching(
      '.agent-management-bar.settings-top-tab-bar'
    );
    const topTabItem = declarationsFor(
      '.settings-page .settings-top-tab-bar > .agent-management-bar-item'
    );
    const selectedItem = declarationsMatching(
      '.agent-management-bar-item.is-selected'
    );

    expect(searchIcon.get('left')).toBe('10px');
    expect(searchIcon.get('pointer-events')).toBe('none');
    expect(searchInput.get('padding-left')).toBe('32px');
    expect(searchInput.get('padding-inline')).toBe('32px 10px');

    expect(agentBar.get('--agent-bar-item-size')).toBe('32px');
    expect(agentBar.get('border-radius')).toBe('9999px');
    expect(agentBar.get('background')).toBe('var(--surface-content)');
    expect(topTabBar.get('gap')).toBe('4px');
    expect(topTabItem.get('flex')).toBe('1 1 0%');
    expect(topTabItem.get('justify-content')).toBe('center');
    expect(selectedItem.get('background')).toBe(
      'var(--surface-raised-control)'
    );
    expect(selectedItem.get('box-shadow')).toBe('var(--shadow-card)');
  });

  it('styles the selected settings sidebar item with an accent fill and contrasting label instead of a thin border', () => {
    const activeNav = declarationsFor('.settings-nav-button.is-active');
    const activeNavHover = declarationsFor(
      '.settings-nav-button.is-active:hover'
    );

    expect(activeNav.get('background')).toBe('hsl(var(--primary))');
    expect(activeNav.get('background-color')).toBe('hsl(var(--primary))');
    expect(activeNav.get('color')).toBe('hsl(var(--primary-foreground))');
    expect(activeNav.get('border-color')).toBe('transparent');
    expect(activeNav.get('font-weight')).toBe('500');
    expect(activeNavHover.get('background')).toBe('hsl(var(--primary) / 0.92)');
    expect(activeNavHover.get('color')).toBe('hsl(var(--primary-foreground))');
    expect(activeNavHover.get('border-color')).toBe('transparent');
  });

  it('blurs only the settings content pane and excludes the left sidebar when the custom role modal is open', () => {
    const collaborationCss = parse(
      readFileSync(
        resolve(process.cwd(), 'src/features/collaboration/collaboration.css'),
        'utf8'
      )
    );
    const rules = new Map<string, Map<string, string>>();
    collaborationCss.walkRules((rule) => {
      const normalized = rule.selector.replace(/\s+/g, ' ').trim();
      const decls = rules.get(normalized) ?? new Map<string, string>();
      rule.walkDecls((decl) => {
        decls.set(decl.prop, decl.value);
      });
      rules.set(normalized, decls);
    });

    expect(
      rules.get('.settings-page.collaboration-settings-window-blurred')
    ).toBeUndefined();
    const contentBlurred = rules.get(
      '.settings-page.collaboration-settings-window-blurred [data-settings-content]'
    );
    expect(contentBlurred?.get('filter')).toBe('blur(10px)');
    const overlay = rules.get('.collaboration-settings-modal-overlay');
    expect(overlay?.get('left')).toBe(
      'var(--settings-modal-overlay-left, 12.5rem)'
    );
  });

  it('caps custom role and remote connection lists at 5 rows with a flush right-edge scrollbar', () => {
    const boundedList = declarationsMatching('.settings-bounded-list');
    expect(boundedList.get('max-height')).toBe('14rem');
    expect(boundedList.get('overflow-y')).toBe('auto');
    expect(boundedList.get('padding')).toBe('0');
    expect(boundedList.get('padding-inline-end')).toBe('0');
    expect(boundedList.get('margin')).toBe('0');
    expect(boundedList.get('scrollbar-gutter')).toBe('auto');
  });

  it('fills Agent settings containers with white raised surface and distinct outer/inner border hierarchy', () => {
    const legacyTokens = declarationsFor('.legacy-design');
    const settingsPage = declarationsFor('.settings-page');
    const agentContentScope = declarationsFor(
      '.settings-page .agent-settings-scroll > :not(.agent-management-bar)'
    );
    const flatSurfaces = declarationsMatching('.agent-flat-section');
    const authFrame = declarationsFor('.settings-page .agent-auth-mode-frame');
    const providerList = declarationsFor(
      '.settings-page .agent-model-provider-list'
    );
    const openCodePlans = declarationsFor(
      '.settings-page .agent-opencode-plans > li'
    );
    const operationProgress = declarationsFor(
      '.settings-page .agent-operation-progress'
    );
    const operationLog = declarationsFor('.settings-page .agent-operation-log');
    const configBlock = declarationsFor('.settings-page .agent-config-block');
    const configFileBody = declarationsFor(
      '.settings-page .agent-config-file-body'
    );
    const dshSessionBody = declarationsFor('.settings-page .dsh-session-body');
    const environmentBody = declarationsMatching('.agent-environment-body');
    const preflightGrid = declarationsFor(
      '.settings-page .agent-preflight-grid'
    );
    const preflightItem = declarationsFor(
      '.settings-page .agent-preflight-grid > li'
    );

    expect(legacyTokens.get('--surface-raised-control')).toBe('#ffffff');
    expect(settingsPage.get('--surface-raised-control')).toBeUndefined();
    for (const surface of [
      '--surface-content',
      '--surface-card',
      '--surface-card-strong',
    ]) {
      expect(agentContentScope.get(surface)).toBe(
        'var(--surface-raised-control)'
      );
      expect(flatSurfaces.get(surface)).toBe('var(--surface-raised-control)');
    }
    expect(agentContentScope.get('--border-content')).toContain(
      'var(--border-strong) 76%'
    );
    expect(flatSurfaces.get('--border-content')).toContain(
      'var(--border-strong) 76%'
    );
    expect(agentContentScope.get('--agent-container-border')).toContain(
      'var(--border-strong) 94%'
    );
    expect(agentContentScope.get('--agent-container-shadow')).toContain(
      'hsl(var(--shadow-ink) / 0.055)'
    );

    const expectedOuterBorder =
      '1px solid var(--agent-container-border, var(--border-strong))';
    for (const outer of [
      authFrame,
      operationProgress,
      configBlock,
      dshSessionBody,
      environmentBody,
      preflightItem,
    ]) {
      expect(outer.get('border')).toBe(expectedOuterBorder);
      expect(outer.get('box-shadow')).toBe(
        'var(--agent-container-shadow, none)'
      );
    }

    for (const inner of [
      providerList,
      openCodePlans,
      operationLog,
      configFileBody,
    ]) {
      expect(inner.get('border')).toBe('1px solid var(--border-content)');
    }

    expect(authFrame.get('background')).toBe('var(--surface-content)');
    expect(openCodePlans.get('background')).toBe('var(--surface-content)');
    expect(operationProgress.get('background')).toBe('var(--surface-content)');
    expect(configBlock.get('background')).toBe('var(--surface-content)');
    expect(dshSessionBody.get('background')).toBe('var(--surface-content)');
    expect(environmentBody.get('background')).toBe('var(--surface-content)');
    expect(preflightGrid.get('margin')).toBe('0');
    expect(preflightItem.get('background')).toBe(
      'var(--surface-raised-control)'
    );
  });

  it('keeps ProviderCatalogPicker rows non-overlapping, icons horizontal, and search input padded past its icons', () => {
    const bar = declarationsFor('.agent-model-provider-catalog-bar');
    const toggle = declarationsFor('.agent-model-provider-catalog-toggle');
    const list = declarationsFor('.agent-model-provider-catalog-list');
    const option = declarationsFor('.agent-model-provider-catalog-option');
    const main = declarationsFor('.agent-model-provider-catalog-option-main');
    const searchInput = declarationsFor(
      '.agent-model-provider-catalog-search-field input'
    );

    expect(bar.get('display')).toBe('flex');
    expect(bar.get('align-items')).toBe('center');
    expect(toggle.get('right')).toBe('4px');
    expect(list.get('display')).toBe('flex');
    expect(list.get('flex-direction')).toBe('column');
    expect(list.get('overflow-y')).toBe('auto');
    expect(list.get('padding')).toBe('4px');
    expect(option.get('flex')).toBe('0 0 auto');
    expect(option.get('min-height')).toBeUndefined();
    expect(main.get('display')).toBe('flex');
    expect(main.get('align-items')).toBe('center');
    expect(searchInput.get('padding-inline')).toBe('28px');

    const urlOpenLink = declarationsFor(
      '.settings-page .agent-model-provider-secret > a'
    );
    expect(urlOpenLink.get('display')).toBe('inline-flex');
    expect(urlOpenLink.get('width')).toBe('32px');
    expect(urlOpenLink.get('height')).toBe('32px');
  });
});
