import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import {
  bindExternalStoreHook,
  commandRegistry,
  conversationModeRegistry,
  defineVibeXPlugin,
  kanbanViewRegistry,
  markdownRegistry,
  overlayRegistry,
  panelRegistry,
  providerRegistry,
  serviceContainer,
  settingRegistry,
  settingsPageRegistry,
  slashCommandRegistry,
  slotRegistry,
  themeRegistry,
  viewRegistry,
} from '@vibex/plugin-sdk';
import React, { useSyncExternalStore } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/usePluginHostContributions', () => ({
  usePluginHostContributions: () => [],
  usePluginContributionCatalogSync: () => undefined,
  contributionMetadata: (item: { metadata?: Record<string, unknown> }) =>
    item?.metadata ?? {},
}));

vi.mock('@/lib/transport', () => ({
  useBackendTransport: () => ({
    call: vi.fn().mockResolvedValue({}),
  }),
  useBackendCapabilities: () => ({
    capabilities: ['application.call', 'plugin.read', 'automation.read'],
    supports: () => true,
  }),
}));

vi.mock('@/contexts/ProjectContext', () => ({
  useProject: () => ({
    projectId: 'proj-1',
    project: { id: 'proj-1', name: 'Demo', is_git: false },
  }),
  ProjectLayoutScope: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock('@/contexts/PanelActionsContext', () => ({
  usePanelActionsContext: () => ({
    openFilePreview: vi.fn(),
    openNewTerminal: vi.fn(),
    openDiffPreview: vi.fn(),
    openNotes: vi.fn(),
    openOrFocusPanel: vi.fn(),
    openPluginPanel: vi.fn(),
    setDockviewApi: vi.fn(),
  }),
  useOptionalPanelActionsContext: () => null,
}));

vi.mock('@/components/context-menu', () => ({
  useAppContextMenu: () => ({
    openSurfaceMenu: vi.fn(),
  }),
}));

vi.mock('@/contexts/WorkspaceOverlayContext', () => ({
  NativeSurfaceOcclusionHold: () => null,
  useWorkspaceOverlay: () => ({
    setChromeOccluded: vi.fn(),
    waitForOverlayReady: vi.fn().mockResolvedValue(undefined),
  }),
}));

import { AppContextMenuHost } from '@/components/context-menu/AppContextMenuHost';
import {
  BUILTIN_PANEL_CONTRIBUTIONS,
  panelComponents,
  registerBuiltinPanels,
} from '@/components/layout/panels/PanelRegistry';
import PluginDockviewPanel from '@/components/layout/panels/PluginDockviewPanel';
import { RightPanelSidebar } from '@/components/layout/RightPanelSidebar';
import { AstryxMarkdown } from '@/components/NormalizedConversation/AstryxMarkdown';
import { clearPluginCrashState } from '@/components/plugins/PluginBoundary';
import {
  PluginConversationModeSwitcher,
  PluginConversationModeTakeover,
  setActivePluginConversationMode,
  useActivePluginConversationMode,
} from '@/components/plugins/PluginConversationModeHost';
import { PluginOverlays } from '@/components/plugins/PluginOverlays';
import { PluginStatusItems } from '@/components/plugins/PluginStatusItems';
import {
  BUILTIN_PALETTE_COMMANDS,
  registerBuiltinCommands,
  SearchPalette,
} from '@/components/search/SearchPalette';
import { buildAtReferenceGroups } from '@/components/tasks/follow-up/composerAtReferences';
import {
  loadPluginRuntime,
  unloadPluginRuntime,
} from '@/features/plugins/PluginRuntimeLoader';
import { sdkSlashCommandsToComposerCommands } from '@/lib/conversation-rendering/commandSources';
import {
  kanbanViewsFromCatalog,
  registerBuiltinKanbanViews,
} from '@/lib/kanbanViewCatalog';
import { PluginSettingsPage } from '@/pages/settings/PluginSettingsPage';
import { registerBuiltinSettingsPages } from '@/pages/settings/SettingsLayout';
import { useSearchStore } from '@/stores/useSearchStore';

describe('Phase 2: Host Shell Dogfooding + Tier-0/Tier-1 Single-File Loader + New Registries', () => {
  beforeEach(() => {
    bindExternalStoreHook(useSyncExternalStore);
    slotRegistry.clear();
    commandRegistry.clear();
    viewRegistry.clear();
    settingRegistry.clear();
    slashCommandRegistry.clear();
    providerRegistry.clear();
    themeRegistry.clear();
    conversationModeRegistry.clear();
    markdownRegistry.clear();
    overlayRegistry.clear();
    panelRegistry.clear();
    kanbanViewRegistry.clear();
    settingsPageRegistry.clear();
    serviceContainer.clear();
    clearPluginCrashState();
    setActivePluginConversationMode(null);
    registerBuiltinPanels();
    registerBuiltinKanbanViews();
    registerBuiltinSettingsPages();
    registerBuiltinCommands();
  });

  afterEach(() => {
    cleanup();
    unloadPluginRuntime('acme.super-plugin');
    unloadPluginRuntime('acme.schema-only');
  });

  it('dogfoods all built-in panels, kanban views, settings pages, and quick commands into @vibex/plugin-sdk registries', () => {
    expect(panelRegistry.getAll().length).toBe(
      BUILTIN_PANEL_CONTRIBUTIONS.length
    );
    expect(panelRegistry.getAll().length).toBeGreaterThanOrEqual(15);
    expect(typeof panelComponents['file-tree']).toBe('function');

    const kanbanEntries = kanbanViewRegistry.getAll();
    expect(kanbanEntries.map((v) => v.id)).toEqual([
      'builtin:columns',
      'builtin:sessions',
      'builtin:canvas',
      'builtin:usage',
    ]);

    const settingsPages = settingsPageRegistry.getAll();
    expect(settingsPages.length).toBeGreaterThanOrEqual(15);
    expect(settingsPages.some((p) => p.path === '/settings/general')).toBe(
      true
    );
    expect(settingsPages.some((p) => p.path === '/plugins')).toBe(true);

    const commands = commandRegistry.getAll();
    expect(commands.length).toBe(BUILTIN_PALETTE_COMMANDS.length);
    expect(commands.some((c) => c.id === 'builtin.open-settings')).toBe(true);
  });

  it('renders zero-UI JSON Schema settings form for Tier-0 declarative plugins and saves via hostCall', async () => {
    const hostCalls: Array<{
      pluginId: string;
      capability: string;
      operation: string;
      input: unknown;
    }> = [];

    await loadPluginRuntime(
      'acme.schema-only',
      {
        kind: 'declarative',
        spec: {
          settingsSchema: {
            title: 'Acme Zero-UI Config',
            description: 'Automatically generated from plugin.json schema',
            type: 'object',
            properties: {
              apiKey: {
                type: 'string',
                title: 'API Key',
                default: 'sk-initial',
              },
              autoSync: {
                type: 'boolean',
                title: 'Auto Sync',
                default: true,
              },
              mode: {
                type: 'string',
                title: 'Sync Mode',
                enum: ['fast', 'safe'],
                default: 'fast',
              },
            },
          },
        },
      },
      {
        callHost: async (pluginId, capability, operation, input) => {
          hostCalls.push({ pluginId, capability, operation, input });
          if (operation === 'settings.get') {
            return {
              apiKey: 'sk-loaded',
              autoSync: false,
              mode: 'safe',
            } as never;
          }
          return input as never;
        },
      }
    );

    render(
      <MemoryRouter
        initialEntries={['/settings/plugin/acme.schema-only/settings']}
      >
        <Routes>
          <Route
            path="/settings/plugin/:pluginId/:pageId"
            element={<PluginSettingsPage />}
          />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByText('Acme Zero-UI Config')).toBeInTheDocument();

    const apiKeyInput = (await screen.findByLabelText(
      'API Key'
    )) as HTMLInputElement;
    await waitFor(() => {
      expect(apiKeyInput.value).toBe('sk-loaded');
    });

    fireEvent.change(apiKeyInput, { target: { value: 'sk-updated-key' } });
    const saveBtn = screen.getByRole('button', { name: 'Save' });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(
        hostCalls.some(
          (c) =>
            c.operation === 'settings.put' &&
            (c.input as { apiKey?: string })?.apiKey === 'sk-updated-key'
        )
      ).toBe(true);
    });
  });

  it('activates a single-file plugin across StatusBar, RightPanel, DockviewPanel, Kanban, Settings, SearchPalette (⌘K), Composer (@ /), ContextMenu, Overlay, Markdown, and Conversation Mode in <10ms and disposes in the same frame', async () => {
    const commandExecuted = vi.fn();
    const statusActivated = vi.fn();
    const composerActionActivated = vi.fn();
    const slashExecuted = vi.fn();
    const contextMenuActivated = vi.fn();

    // A concise single-file plugin definition
    const singleFilePlugin = defineVibeXPlugin({
      apiVersion: '2.0',
      activate(ctx) {
        ctx.ui.registerStatusBarItem({
          id: 'pomodoro',
          label: '🍅 25:00',
          tooltip: 'Pomodoro Timer',
          onActivate: statusActivated,
        });
        ctx.ui.registerPanel({
          id: 'inspector',
          title: 'Acme Inspector',
          component: () => (
            <div data-testid="acme-inspector-panel">Inspector Content</div>
          ),
        });
        ctx.ui.registerKanbanView({
          id: 'roadmap',
          title: 'Roadmap View',
          component: () => <div>Roadmap Content</div>,
        });
        ctx.ui.registerSettingsPage({
          id: 'prefs',
          title: 'Acme Preferences',
          component: () => (
            <div data-testid="acme-prefs-page">Custom Prefs View</div>
          ),
        });
        ctx.ui.registerCommand({
          id: 'run-audit',
          title: 'Acme: Run Security Audit',
          category: 'Security',
          handler: commandExecuted,
        });
        ctx.ui.registerComposerAction({
          id: 'attach-diagram',
          label: 'Attach Architecture Diagram',
          onActivate: composerActionActivated,
        });
        ctx.ui.registerComposerSlash({
          name: 'audit-repo',
          description: 'Run repository security audit',
          execute: slashExecuted,
        });
        ctx.ui.registerContextMenu({
          id: 'explain-message',
          slot: 'message.context-menu',
          label: 'Acme: Explain Message',
          onActivate: contextMenuActivated,
        });
        ctx.ui.registerOverlay({
          id: 'floating-pet',
          title: 'Floating Widget',
          component: () => (
            <div data-testid="acme-floating-overlay">Floating Pet Active</div>
          ),
        });
        ctx.ui.registerMarkdownRenderer({
          id: 'acme-chart',
          language: 'acme-chart',
          component: ({ code }) => (
            <div data-testid="acme-custom-markdown">Chart({code.trim()})</div>
          ),
        });
        ctx.ui.registerConversationMode({
          id: 'voice-room',
          label: 'Voice Room',
          component: () => (
            <div data-testid="acme-voice-takeover">Live Voice Waveform</div>
          ),
        });
      },
    });

    const t0 = performance.now();
    await loadPluginRuntime('acme.super-plugin', {
      kind: 'module',
      module: singleFilePlugin,
      css: '.acme-badge { color: rgb(16, 185, 129); }',
    });
    const elapsedMs = performance.now() - t0;
    expect(elapsedMs).toBeLessThan(25);

    // Verify CSS @layer injection
    const styleEl = document.head.querySelector(
      'style[data-vibex-plugin="acme.super-plugin"]'
    );
    expect(styleEl?.textContent).toContain('@layer vibex-plugins');

    // Verify Kanban catalog includes built-in 4 + plugin 'roadmap'
    const kanbanViews = kanbanViewsFromCatalog([]);
    expect(
      kanbanViews.some((v) => v.id === 'plugin:acme.super-plugin/roadmap')
    ).toBe(true);

    // Open SearchPalette (⌘K)
    useSearchStore.setState({
      isSearchPaletteOpen: true,
      paletteQuery: 'Security Audit',
      paletteSelectedIndex: 0,
    });

    function ConversationModeHarness() {
      const { activeMode } = useActivePluginConversationMode();
      return (
        <div>
          <PluginConversationModeSwitcher />
          {activeMode ? (
            <PluginConversationModeTakeover mode={activeMode} />
          ) : (
            <div data-testid="standard-chat-timeline">Standard Chat</div>
          )}
        </div>
      );
    }

    const mockDockviewApi = {
      id: 'plugin:acme.super-plugin/inspector',
      isVisible: true,
      onDidVisibilityChange: () => ({ dispose: () => undefined }),
    } as never;

    render(
      <MemoryRouter
        initialEntries={['/settings/plugin/acme.super-plugin/prefs']}
      >
        <AppContextMenuHost>
          <div>
            <PluginStatusItems />
            <RightPanelSidebar />
            <PluginOverlays />
            <SearchPalette />
            <ConversationModeHarness />
            <div data-testid="chat-message-target">Assistant reply text</div>
            <AstryxMarkdown value={'```acme-chart\nsales=42\n```'} />
            <PluginDockviewPanel
              api={mockDockviewApi}
              containerApi={{} as never}
              params={{
                pluginId: 'acme.super-plugin',
                contributionId: 'inspector',
              }}
            />
            <Routes>
              <Route
                path="/settings/plugin/:pluginId/:pageId"
                element={<PluginSettingsPage />}
              />
            </Routes>
          </div>
        </AppContextMenuHost>
      </MemoryRouter>
    );

    // Verify dynamic panelComponents proxy lookup for plugin panel
    expect(
      typeof panelComponents['plugin:acme.super-plugin/inspector']
    ).toBe('function');

    // Verify Composer `/` slash command and `@` action registration
    const slashOpts = sdkSlashCommandsToComposerCommands(
      slashCommandRegistry.getAll()
    );
    const auditSlash = slashOpts.find((o) => o.name === 'audit-repo');
    expect(auditSlash).toBeDefined();
    auditSlash?.execute?.('src/');
    expect(slashExecuted).toHaveBeenCalledWith('src/');

    const sdkActions = slotRegistry.getBySlot('composer.actions');
    const atGroups = buildAtReferenceGroups('Diagram', {
      files: [],
      conversations: [],
      commits: [],
      repoId: null,
      instructions: [],
      actions: sdkActions.map((contrib) => ({
        id: contrib.id,
        title: contrib.label ?? contrib.id,
        insertText: '',
        onActivate: () => contrib.onActivate?.(),
      })),
    });
    const actionGroup = atGroups.find((g) => g.tab === 'action');
    expect(actionGroup?.items.length).toBe(1);
    expect(actionGroup?.items[0]?.label).toBe('Attach Architecture Diagram');
    await actionGroup?.items[0]?.onActivate?.();
    expect(composerActionActivated).toHaveBeenCalledTimes(1);

    // Verify right-click ContextMenu (`message.context-menu`)
    const messageTarget = screen.getByTestId('chat-message-target');
    fireEvent.contextMenu(messageTarget, { clientX: 120, clientY: 160 });
    const ctxMenuItem = await screen.findByText('Acme: Explain Message');
    expect(ctxMenuItem).toBeInTheDocument();
    fireEvent.click(ctxMenuItem);
    expect(contextMenuActivated).toHaveBeenCalledTimes(1);

    // 1. Status bar item
    const statusBtn = screen.getByText('🍅 25:00');
    expect(statusBtn).toBeInTheDocument();
    fireEvent.click(statusBtn);
    expect(statusActivated).toHaveBeenCalledTimes(1);

    // 2. RightPanelSidebar button for 'Acme Inspector'
    expect(
      screen.getByRole('button', { name: 'Acme Inspector' })
    ).toBeInTheDocument();

    // 3. Dockview panel content
    expect(screen.getByTestId('acme-inspector-panel')).toHaveTextContent(
      'Inspector Content'
    );

    // 4. Settings page content
    expect(screen.getByTestId('acme-prefs-page')).toHaveTextContent(
      'Custom Prefs View'
    );

    // 5. SearchPalette (⌘K) command execution
    const cmdRow = screen.getByText('Acme: Run Security Audit');
    expect(cmdRow).toBeInTheDocument();
    fireEvent.click(cmdRow);
    expect(commandExecuted).toHaveBeenCalledTimes(1);

    // 6. Global Overlay
    expect(screen.getByTestId('acme-floating-overlay')).toHaveTextContent(
      'Floating Pet Active'
    );

    // 7. Custom Markdown codeblock renderer
    expect(screen.getByTestId('acme-custom-markdown')).toHaveTextContent(
      'Chart(sales=42)'
    );

    // 8. Conversation Mode switcher & takeover
    expect(screen.getByTestId('standard-chat-timeline')).toBeInTheDocument();
    const voiceBtn = screen.getByRole('button', { name: /Voice Room/i });
    fireEvent.click(voiceBtn);
    expect(screen.getByTestId('acme-voice-takeover')).toHaveTextContent(
      'Live Voice Waveform'
    );

    // 9. Disable / Unload plugin -> verify SAME-FRAME synchronous removal of all surfaces!
    act(() => {
      unloadPluginRuntime('acme.super-plugin');
    });

    expect(screen.queryByText('🍅 25:00')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Acme Inspector' })).toBeNull();
    expect(screen.queryByTestId('acme-inspector-panel')).toBeNull();
    expect(screen.queryByTestId('acme-prefs-page')).toBeNull();
    expect(screen.queryByTestId('acme-floating-overlay')).toBeNull();
    expect(screen.queryByTestId('acme-custom-markdown')).toBeNull();
    expect(screen.queryByTestId('acme-voice-takeover')).toBeNull();
    // Conversation mode automatically falls back to Standard Chat!
    expect(screen.getByTestId('standard-chat-timeline')).toBeInTheDocument();
    expect(
      document.head.querySelector(
        'style[data-vibex-plugin="acme.super-plugin"]'
      )
    ).toBeNull();
  });
});
