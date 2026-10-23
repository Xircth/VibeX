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
} from '@vibex/plugin-sdk';
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
    expect(serviceContainer.has('vibex.model-catalog')).toBe(false);
    expect(serviceContainer.has('vibex.usage')).toBe(false);
    expect(serviceContainer.has('vibex.editor')).toBe(false);
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

    // 1. vibex.core.workspace-git
    expect(panelRegistry.get(PANEL_IDS.GIT)?.pluginId).toBe(
      'vibex.core.workspace-git'
    );
    expect(panelRegistry.get(PANEL_IDS.DIFFS)?.pluginId).toBe(
      'vibex.core.workspace-git'
    );
    expect(panelRegistry.get(PANEL_IDS.MERGE)?.pluginId).toBe(
      'vibex.core.workspace-git'
    );
    expect(
      settingsPageRegistry.get('builtin:/settings/version-control')?.pluginId
    ).toBe('vibex.core.workspace-git');
    expect(
      settingsPageRegistry.get('builtin:/settings/worktrees')?.pluginId
    ).toBe('vibex.core.workspace-git');
    const gitService = serviceContainer.get<{
      getGitPanelId: () => string;
      getWorktreeSettingsPath: () => string;
    }>('vibex.core.workspace-git');
    expect(gitService?.getGitPanelId()).toBe(PANEL_IDS.GIT);
    expect(gitService?.getWorktreeSettingsPath()).toBe('/settings/worktrees');

    // 2. vibex.core.shell
    expect(panelRegistry.get(PANEL_IDS.TERMINAL)?.pluginId).toBe(
      'vibex.core.shell'
    );
    expect(panelRegistry.get(PANEL_IDS.PROCESSES)?.pluginId).toBe(
      'vibex.core.shell'
    );
    expect(commandRegistry.get('builtin.shell.new-terminal')?.pluginId).toBe(
      'vibex.core.shell'
    );
    const shellService = serviceContainer.get<{
      getTerminalPanelId: () => string;
      openNewTerminal: () => void;
    }>('vibex.core.shell');
    expect(shellService?.getTerminalPanelId()).toBe(PANEL_IDS.TERMINAL);
    expect(typeof shellService?.openNewTerminal).toBe('function');

    // 3. vibex.core.filesystem
    expect(panelRegistry.get(PANEL_IDS.FILE_TREE)?.pluginId).toBe(
      'vibex.core.filesystem'
    );
    expect(panelRegistry.get(PANEL_IDS.SEARCH)?.pluginId).toBe(
      'vibex.core.filesystem'
    );
    expect(panelRegistry.get(PANEL_IDS.PREVIEW)?.pluginId).toBe(
      'vibex.core.filesystem'
    );
    expect(serviceContainer.has('vibex.provider.editor-opener')).toBe(true);
    expect(serviceContainer.has('provider.editor.opener')).toBe(true);

    // 4. vibex.webui.conversation & vibex.core.session
    expect(panelRegistry.get(PANEL_IDS.AI_CHAT)?.pluginId).toBe(
      'vibex.webui.conversation'
    );
    expect(panelRegistry.get(PANEL_IDS.SESSION_DETAILS)?.pluginId).toBe(
      'vibex.webui.conversation'
    );
    expect(panelRegistry.get(PANEL_IDS.SESSION_LIST)?.pluginId).toBe(
      'vibex.core.session'
    );
    expect(
      slashCommandRegistry.get('vibex.webui.conversation:clear')?.pluginId
    ).toBe('vibex.webui.conversation');

    // 5. Domain-specific Settings Pages split across core plugins
    const expectedSettingsPageOwners: ReadonlyArray<[string, string]> = [
      ['builtin:/plugins', 'vibex.core.plugin-manager'],
      ['builtin:/settings/logs', 'vibex.core.hmr'],
      ['builtin:/settings/general', 'vibex.core.settings'],
      ['builtin:/settings/system', 'vibex.core.settings'],
      ['builtin:/settings/credentials', 'vibex.core.credentials'],
      ['builtin:/settings/agents', 'vibex.core.agent-runtime'],
      ['builtin:/settings/web-service', 'vibex.core.session'],
      ['builtin:/settings/models', 'vibex.core.llm-providers'],
      ['builtin:/settings/skills', 'vibex.core.skills'],
      ['builtin:/settings/mcp', 'vibex.core.mcp'],
      ['builtin:/settings/subagents', 'vibex.core.delegation'],
      ['builtin:/settings/compaction', 'vibex.core.compaction'],
      ['builtin:/settings/approval', 'vibex.core.approval'],
      ['builtin:/settings/automations', 'vibex.core.automation'],
      ['builtin:/settings/chat-channels', 'vibex.core.channels'],
      ['builtin:/settings/instructions', 'vibex.webui.conversation'],
      ['builtin:/settings/shortcuts', 'vibex.webui.commands'],
      ['builtin:/settings/appearance', 'vibex.webui.theme'],
    ];

    for (const [pageId, expectedOwner] of expectedSettingsPageOwners) {
      expect(
        settingsPageRegistry.get(pageId)?.pluginId,
        `Settings page ${pageId} should be owned by ${expectedOwner}`
      ).toBe(expectedOwner);
    }

    // 6. vibex.webui.theme
    const themeService = serviceContainer.get<{
      listThemes: () => readonly unknown[];
      toggleTheme: () => void;
    }>('vibex.webui.theme');
    expect(typeof themeService?.listThemes).toBe('function');
    expect(typeof themeService?.toggleTheme).toBe('function');
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
      'vibex.webui.conversation'
    );
    const agentRuntimeSvc = serviceContainer.get<CoreFoundationServiceBase>(
      'vibex.core.agent-runtime'
    );

    expect(conversationSvc?.isDependencyGraphReady()).toBe(true);
    expect(agentRuntimeSvc?.isDependencyGraphReady()).toBe(true);
    expect(
      serviceContainer.has('vibex.dep-graph:vibex.webui.conversation')
    ).toBe(true);
    expect(
      serviceContainer.has('vibex.dep-graph:vibex.core.agent-runtime')
    ).toBe(true);

    // Unload vibex.core.llm-providers -> agent-runtime's injected sub-scope tears down
    unloadPluginRuntime('vibex.core.llm-providers');
    expect(agentRuntimeSvc?.isDependencyGraphReady()).toBe(false);
    expect(
      serviceContainer.has('vibex.dep-graph:vibex.core.agent-runtime')
    ).toBe(false);

    // Reload vibex.core.llm-providers -> agent-runtime's injected sub-scope automatically recovers
    await loadCoreFoundationPlugin('vibex.core.llm-providers');
    expect(agentRuntimeSvc?.isDependencyGraphReady()).toBe(true);
    expect(
      serviceContainer.has('vibex.dep-graph:vibex.core.agent-runtime')
    ).toBe(true);

    // Unload vibex.core.session -> conversation's injected sub-scope tears down
    unloadPluginRuntime('vibex.core.session');
    expect(conversationSvc?.isDependencyGraphReady()).toBe(false);
    expect(
      serviceContainer.has('vibex.dep-graph:vibex.webui.conversation')
    ).toBe(false);

    // Reload vibex.core.session -> conversation's injected sub-scope automatically recovers
    await loadCoreFoundationPlugin('vibex.core.session');
    expect(conversationSvc?.isDependencyGraphReady()).toBe(true);
    expect(
      serviceContainer.has('vibex.dep-graph:vibex.webui.conversation')
    ).toBe(true);
  });
});
