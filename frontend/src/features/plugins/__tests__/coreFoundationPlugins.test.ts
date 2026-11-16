import {
  commandRegistry,
  conversationModeRegistry,
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
} from '@dimoai/plugin-sdk';
import { beforeEach, describe, expect, it } from 'vitest';

import { PANEL_IDS } from '@/stores/useLayoutStore';
import {
  bootstrapCoreFoundationPlugins,
  CORE_FOUNDATION_PLUGIN_DESCRIPTORS,
  type CoreFoundationServiceBase,
  ensureCoreFoundationPluginsBootstrapped,
  getCoreFoundationInventory,
  getCoreFoundationPluginSource,
  loadCoreFoundationPlugin,
} from '../coreFoundationPlugins';
import {
  getPluginRuntimeMetadata,
  isPluginLocked,
  isPluginRuntimeActive,
  isSystemBundlePlugin,
  loadPluginRuntime,
  unloadAllPluginRuntimes,
  unloadPluginRuntime,
} from '../PluginRuntimeLoader';

function resetAllRegistries(): void {
  unloadAllPluginRuntimes();
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
}

describe('System Bundle (coreFoundationPlugins) lifecycle & EffectScope isolation', () => {
  beforeEach(() => {
    resetAllRegistries();
  });

  it('does not leak permanent registrations when all plugin runtimes are unloaded', () => {
    expect(panelRegistry.getAll()).toHaveLength(0);
    expect(settingsPageRegistry.getAll()).toHaveLength(0);
    expect(kanbanViewRegistry.getAll()).toHaveLength(0);
    expect(commandRegistry.getAll()).toHaveLength(0);
    expect(serviceContainer.has('dimo.model-catalog')).toBe(false);
    expect(serviceContainer.has('dimo.usage')).toBe(false);
    expect(serviceContainer.has('dimo.editor')).toBe(false);
  });

  it('marks all System Bundle plugins with bundle="system", locked=true, and a real onActivate implementation', async () => {
    const activatedIds = await bootstrapCoreFoundationPlugins();
    expect(activatedIds).toHaveLength(
      CORE_FOUNDATION_PLUGIN_DESCRIPTORS.length
    );
    expect(CORE_FOUNDATION_PLUGIN_DESCRIPTORS.length).toBeGreaterThanOrEqual(
      18
    );

    for (const descriptor of CORE_FOUNDATION_PLUGIN_DESCRIPTORS) {
      expect(typeof descriptor.onActivate).toBe('function');
      expect(descriptor.bundle).toBe('system');
      expect(descriptor.locked).toBe(true);
      expect(isSystemBundlePlugin(descriptor.id)).toBe(true);
      expect(isPluginLocked(descriptor.id)).toBe(true);
      expect(isPluginRuntimeActive(descriptor.id)).toBe(true);

      const meta = getPluginRuntimeMetadata(descriptor.id);
      expect(meta).toMatchObject({
        pluginId: descriptor.id,
        bundle: 'system',
        locked: true,
        canUninstallInUi: false,
      });
    }

    const inventory = getCoreFoundationInventory();
    for (const snap of inventory) {
      expect(snap.bundle).toBe('system');
      expect(snap.locked).toBe(true);
      expect(snap.canUninstall).toBe(false);
      expect(snap.active).toBe(true);
      expect(snap.dependenciesSatisfied).toBe(true);
    }
  });

  it('decomposes panels, settings pages, commands, slash commands, and domain services across their respective System Bundle plugins', () => {
    ensureCoreFoundationPluginsBootstrapped();

    // 1. dimo.core.workspace-git
    expect(panelRegistry.get(PANEL_IDS.GIT)?.pluginId).toBe(
      'dimo.core.workspace-git'
    );
    expect(panelRegistry.get(PANEL_IDS.DIFFS)?.pluginId).toBe(
      'dimo.core.workspace-git'
    );
    expect(panelRegistry.get(PANEL_IDS.MERGE)?.pluginId).toBe(
      'dimo.core.workspace-git'
    );
    expect(
      settingsPageRegistry.get('builtin:/settings/version-control')?.pluginId
    ).toBe('dimo.core.workspace-git');
    expect(
      settingsPageRegistry.get('builtin:/settings/worktrees')?.pluginId
    ).toBe('dimo.core.workspace-git');
    const gitService = serviceContainer.get<{
      getGitPanelId: () => string;
      getWorktreeSettingsPath: () => string;
    }>('dimo.core.workspace-git');
    expect(gitService?.getGitPanelId()).toBe(PANEL_IDS.GIT);
    expect(gitService?.getWorktreeSettingsPath()).toBe('/settings/worktrees');

    // 2. dimo.core.shell
    expect(panelRegistry.get(PANEL_IDS.TERMINAL)?.pluginId).toBe(
      'dimo.core.shell'
    );
    expect(panelRegistry.get(PANEL_IDS.PROCESSES)?.pluginId).toBe(
      'dimo.core.shell'
    );
    expect(commandRegistry.get('builtin.shell.new-terminal')?.pluginId).toBe(
      'dimo.core.shell'
    );
    const shellService = serviceContainer.get<{
      getTerminalPanelId: () => string;
      openNewTerminal: () => void;
    }>('dimo.core.shell');
    expect(shellService?.getTerminalPanelId()).toBe(PANEL_IDS.TERMINAL);
    expect(typeof shellService?.openNewTerminal).toBe('function');

    // 3. dimo.core.filesystem
    expect(panelRegistry.get(PANEL_IDS.FILE_TREE)?.pluginId).toBe(
      'dimo.core.filesystem'
    );
    expect(panelRegistry.get(PANEL_IDS.SEARCH)?.pluginId).toBe(
      'dimo.core.filesystem'
    );
    expect(panelRegistry.get(PANEL_IDS.PREVIEW)?.pluginId).toBe(
      'dimo.core.filesystem'
    );
    expect(panelRegistry.get(PANEL_IDS.EXTERNAL_DIRECTORY)?.pluginId).toBe(
      'dimo.core.filesystem'
    );
    expect(serviceContainer.has('dimo.provider.editor-opener')).toBe(true);
    expect(serviceContainer.has('provider.editor.opener')).toBe(true);

    // 4. dimo.webui.conversation & dimo.core.session
    expect(panelRegistry.get(PANEL_IDS.AI_CHAT)?.pluginId).toBe(
      'dimo.webui.conversation'
    );
    expect(panelRegistry.get(PANEL_IDS.SESSION_DETAILS)?.pluginId).toBe(
      'dimo.webui.conversation'
    );
    expect(panelRegistry.get(PANEL_IDS.SESSION_LIST)?.pluginId).toBe(
      'dimo.core.session'
    );
    expect(
      slashCommandRegistry.get('dimo.webui.conversation:clear')?.pluginId
    ).toBe('dimo.webui.conversation');

    // 5. Domain-specific Settings Pages split across core plugins
    const expectedSettingsPageOwners: ReadonlyArray<[string, string]> = [
      ['builtin:/plugins', 'dimo.core.plugin-manager'],
      ['builtin:/settings/logs', 'dimo.core.hmr'],
      ['builtin:/settings/general', 'dimo.core.settings'],
      ['builtin:/settings/system', 'dimo.core.settings'],
      ['builtin:/settings/credentials', 'dimo.core.credentials'],
      ['builtin:/settings/agents', 'dimo.core.agent-runtime'],
      ['builtin:/settings/web-service', 'dimo.core.session'],
      ['builtin:/settings/models', 'dimo.core.llm-providers'],
      ['builtin:/settings/skills', 'dimo.core.skills'],
      ['builtin:/settings/mcp', 'dimo.core.mcp'],
      ['builtin:/settings/subagents', 'dimo.core.delegation'],
      ['builtin:/settings/compaction', 'dimo.core.compaction'],
      ['builtin:/settings/approval', 'dimo.core.approval'],
      ['builtin:/settings/automations', 'dimo.core.automation'],
      ['builtin:/settings/chat-channels', 'dimo.core.channels'],
      ['builtin:/settings/instructions', 'dimo.webui.conversation'],
      ['builtin:/settings/shortcuts', 'dimo.webui.commands'],
      ['builtin:/settings/appearance', 'dimo.webui.theme'],
    ];

    for (const [pageId, expectedOwner] of expectedSettingsPageOwners) {
      expect(
        settingsPageRegistry.get(pageId)?.pluginId,
        `Settings page ${pageId} should be owned by ${expectedOwner}`
      ).toBe(expectedOwner);
    }

    // 6. dimo.webui.theme
    const themeService = serviceContainer.get<{
      listThemes: () => readonly unknown[];
      toggleTheme: () => void;
    }>('dimo.webui.theme');
    expect(typeof themeService?.listThemes).toBe('function');
    expect(typeof themeService?.toggleTheme).toBe('function');

    // 7. dimo.webui.layout owns welcome & logs panels, NOT notes (notes belongs to dimo.notes)
    expect(panelRegistry.get(PANEL_IDS.WELCOME)?.pluginId).toBe(
      'dimo.webui.layout'
    );
    expect(panelRegistry.get(PANEL_IDS.LOGS)?.pluginId).toBe(
      'dimo.webui.layout'
    );
    expect(panelRegistry.has(PANEL_IDS.NOTES)).toBe(false);

    // 8. dimo.core.approval owns browser-eval-confirm overlay; dimo.core.delegation owns collaboration tab view
    expect(overlayRegistry.get('browser-eval-confirm')?.pluginId).toBe(
      'dimo.core.approval'
    );
    expect(viewRegistry.get('collaboration')?.pluginId).toBe(
      'dimo.core.delegation'
    );
  });

  it('cleanly unregisters every Panel, Settings Page, Kanban View, Command, Slash Command, and Service via EffectScope on unloadPluginRuntime and restores on reload', async () => {
    await bootstrapCoreFoundationPlugins();

    for (const descriptor of CORE_FOUNDATION_PLUGIN_DESCRIPTORS) {
      const pluginId = descriptor.id;
      const ownedPanelsBefore = panelRegistry
        .getAll()
        .filter((p) => p.pluginId === pluginId)
        .map((p) => p.id);
      const ownedPagesBefore = settingsPageRegistry
        .getAll()
        .filter((p) => p.pluginId === pluginId)
        .map((p) => p.id);
      const ownedKanbanBefore = kanbanViewRegistry
        .getAll()
        .filter((v) => v.pluginId === pluginId)
        .map((v) => v.id);
      const ownedCommandsBefore = commandRegistry
        .getAll()
        .filter((c) => c.pluginId === pluginId)
        .map((c) => c.id);
      const ownedSlashesBefore = slashCommandRegistry
        .getAll()
        .filter((s) => s.pluginId === pluginId)
        .map((s) => s.id);

      // Every foundation plugin must register at least one command or UI surface + its services
      expect(
        ownedPanelsBefore.length +
          ownedPagesBefore.length +
          ownedKanbanBefore.length +
          ownedCommandsBefore.length +
          ownedSlashesBefore.length,
        `${pluginId} must register at least one UI/command contribution`
      ).toBeGreaterThan(0);

      for (const serviceKey of [pluginId, ...descriptor.provides]) {
        expect(
          serviceContainer.has(serviceKey),
          `${pluginId} should provide service "${serviceKey}"`
        ).toBe(true);
      }

      // Unload the plugin runtime
      unloadPluginRuntime(pluginId);

      expect(isPluginRuntimeActive(pluginId)).toBe(false);
      for (const serviceKey of [pluginId, ...descriptor.provides]) {
        expect(
          serviceContainer.has(serviceKey),
          `Service "${serviceKey}" must be cleaned up when ${pluginId} is unloaded`
        ).toBe(false);
      }
      for (const panelId of ownedPanelsBefore) {
        expect(panelRegistry.has(panelId)).toBe(false);
      }
      for (const pageId of ownedPagesBefore) {
        expect(settingsPageRegistry.has(pageId)).toBe(false);
      }
      for (const viewId of ownedKanbanBefore) {
        expect(kanbanViewRegistry.has(viewId)).toBe(false);
      }
      for (const cmdId of ownedCommandsBefore) {
        expect(commandRegistry.has(cmdId)).toBe(false);
      }
      for (const slashId of ownedSlashesBefore) {
        expect(slashCommandRegistry.has(slashId)).toBe(false);
      }

      // Reload the plugin runtime via loadPluginRuntime and verify full recovery
      await loadPluginRuntime(
        pluginId,
        getCoreFoundationPluginSource(pluginId)
      );

      expect(isPluginRuntimeActive(pluginId)).toBe(true);
      for (const serviceKey of [pluginId, ...descriptor.provides]) {
        expect(serviceContainer.has(serviceKey)).toBe(true);
      }
      for (const panelId of ownedPanelsBefore) {
        expect(panelRegistry.get(panelId)?.pluginId).toBe(pluginId);
      }
      for (const pageId of ownedPagesBefore) {
        expect(settingsPageRegistry.get(pageId)?.pluginId).toBe(pluginId);
      }
      for (const viewId of ownedKanbanBefore) {
        expect(kanbanViewRegistry.get(viewId)?.pluginId).toBe(pluginId);
      }
      for (const cmdId of ownedCommandsBefore) {
        expect(commandRegistry.get(cmdId)?.pluginId).toBe(pluginId);
      }
      for (const slashId of ownedSlashesBefore) {
        expect(slashCommandRegistry.get(slashId)?.pluginId).toBe(pluginId);
      }
    }
  });

  it('wires real reactive dependency chains via ctx.services.inject (e.g. conversation -> session & agent-runtime -> llm-providers)', async () => {
    await bootstrapCoreFoundationPlugins();

    const conversationSvc = serviceContainer.get<CoreFoundationServiceBase>(
      'dimo.webui.conversation'
    );
    const agentRuntimeSvc = serviceContainer.get<CoreFoundationServiceBase>(
      'dimo.core.agent-runtime'
    );

    expect(conversationSvc?.isDependencyGraphReady()).toBe(true);
    expect(agentRuntimeSvc?.isDependencyGraphReady()).toBe(true);
    expect(
      serviceContainer.has('dimo.dep-graph:dimo.webui.conversation')
    ).toBe(true);
    expect(
      serviceContainer.has('dimo.dep-graph:dimo.core.agent-runtime')
    ).toBe(true);

    // Unload dimo.core.llm-providers -> agent-runtime's injected sub-scope tears down
    unloadPluginRuntime('dimo.core.llm-providers');
    expect(agentRuntimeSvc?.isDependencyGraphReady()).toBe(false);
    expect(
      serviceContainer.has('dimo.dep-graph:dimo.core.agent-runtime')
    ).toBe(false);

    // Reload dimo.core.llm-providers -> agent-runtime's injected sub-scope automatically recovers
    await loadCoreFoundationPlugin('dimo.core.llm-providers');
    expect(agentRuntimeSvc?.isDependencyGraphReady()).toBe(true);
    expect(
      serviceContainer.has('dimo.dep-graph:dimo.core.agent-runtime')
    ).toBe(true);

    // Unload dimo.core.session -> conversation's injected sub-scope tears down
    unloadPluginRuntime('dimo.core.session');
    expect(conversationSvc?.isDependencyGraphReady()).toBe(false);
    expect(
      serviceContainer.has('dimo.dep-graph:dimo.webui.conversation')
    ).toBe(false);

    // Reload dimo.core.session -> conversation's injected sub-scope automatically recovers
    await loadCoreFoundationPlugin('dimo.core.session');
    expect(conversationSvc?.isDependencyGraphReady()).toBe(true);
    expect(
      serviceContainer.has('dimo.dep-graph:dimo.webui.conversation')
    ).toBe(true);
  });
});
