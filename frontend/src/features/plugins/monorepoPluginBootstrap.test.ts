import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  commandRegistry,
  internalMessageCaptureRegistry,
  kanbanViewRegistry,
  panelRegistry,
  promptContextRegistry,
  providerRegistry,
  serviceContainer,
  settingRegistry,
  settingsPageRegistry,
  slashCommandRegistry,
  slotRegistry,
  viewRegistry,
} from '@vibex/plugin-sdk';
import {
  pluginRuntimeLoader,
  unloadPluginRuntime,
} from './PluginRuntimeLoader';
import {
  MONOREPO_OFFICIAL_PLUGIN_BUNDLES,
   bootstrapMonorepoOfficialPlugins,
  getMonorepoPluginBundle,
  getMonorepoPluginLoadCount,
  isMonorepoPluginModuleLoaded,
  reloadMonorepoPlugin,
  resetMonorepoPluginLoaderStateForTest,
  syncMonorepoPluginRuntime,
} from './monorepoPluginBootstrap';
import { resetHostProviderServicesForTest } from './providers/hostProviderServices';

const kvStoreByPlugin = new Map<string, Map<string, unknown>>();
const settingsByPlugin = new Map<string, unknown>();

vi.mock('@/lib/backendTransport', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/backendTransport')>();
  const mockCall = vi.fn(async (cmd: string, payload?: unknown) => {
    if (cmd === 'plugin_host_call' && payload && typeof payload === 'object') {
      const req = payload as {
        pluginId: string;
        capability: string;
        operation: string;
        input?: Record<string, unknown>;
      };
      if (req.capability === 'storage') {
        let kv = kvStoreByPlugin.get(req.pluginId);
        if (!kv) {
          kv = new Map<string, unknown>();
          kvStoreByPlugin.set(req.pluginId, kv);
        }
        if (req.operation === 'kv.get') {
          const key = String(req.input?.key ?? '');
          return kv.get(key) ?? null;
        }
        if (req.operation === 'kv.put') {
          const key = String(req.input?.key ?? '');
          kv.set(key, req.input?.value);
          return req.input?.value ?? null;
        }
        if (req.operation === 'kv.delete') {
          const key = String(req.input?.key ?? '');
          kv.delete(key);
          return null;
        }
        if (req.operation === 'settings.get') {
          return settingsByPlugin.get(req.pluginId) ?? {};
        }
        if (req.operation === 'settings.put') {
          settingsByPlugin.set(req.pluginId, req.input ?? {});
          return req.input ?? {};
        }
      }
      if (
        req.capability === 'conversation' &&
        req.operation === 'enhance_prompt'
      ) {
        const rawPrompt = String(req.input?.prompt ?? '').trim();
        return {
          enhancedPrompt: `[Host LLM Enhanced] ${rawPrompt} [Constraints: Complete implementation, verify with tests.]`,
        };
      }
    }
    return {};
  });
  return {
    ...actual,
    backendCall: mockCall,
    configuredBackendTransport: {
      ...actual.configuredBackendTransport,
      call: mockCall,
    },
  };
});

describe('monorepoPluginBootstrap (Dynamic Lazy Loading & Official Plugins Closed-Loop)', () => {
  const officialPluginIds = new Set(
    MONOREPO_OFFICIAL_PLUGIN_BUNDLES.map((b) => b.id)
  );

  beforeEach(() => {
    pluginRuntimeLoader.deactivateAll();
    resetHostProviderServicesForTest();
    resetMonorepoPluginLoaderStateForTest();
    kvStoreByPlugin.clear();
    settingsByPlugin.clear();
  });

  it('does not load or activate disabled official plugins and supports on-demand dynamic enable/disable', async () => {
    // 1. Before bootstrap, zero official plugin modules have been loaded
    for (const bundle of MONOREPO_OFFICIAL_PLUGIN_BUNDLES) {
      expect(isMonorepoPluginModuleLoaded(bundle.id)).toBe(false);
      expect(getMonorepoPluginLoadCount(bundle.id)).toBe(0);
    }

    const disabledIds = [
      'vibex.browser',
      'vibex.notes',
      'vibex.kanban-views',
      'vibex.prompt-enhancer',
    ];
    const browserBundle = getMonorepoPluginBundle('vibex.browser')!;
    const browserLoadSpy = vi.spyOn(browserBundle, 'loadModule');

    try {
      const activated = await bootstrapMonorepoOfficialPlugins({
        disabledIds,
      });

      expect(activated).toHaveLength(13 - disabledIds.length);
      for (const disabledId of disabledIds) {
        expect(activated).not.toContain(disabledId);
        expect(isMonorepoPluginModuleLoaded(disabledId)).toBe(false);
        expect(getMonorepoPluginLoadCount(disabledId)).toBe(0);
      }
      expect(browserLoadSpy).not.toHaveBeenCalled();
      expect(serviceContainer.has('vibex.browser')).toBe(false);
      expect(serviceContainer.has('vibex.notes')).toBe(false);
      expect(serviceContainer.has('vibex.kanban-views')).toBe(false);
      expect(serviceContainer.has('vibex.prompt-enhancer')).toBe(false);

      // 2. Dynamically enabling vibex.browser loads only its module on demand
      await syncMonorepoPluginRuntime('vibex.browser', true);
      expect(browserLoadSpy).toHaveBeenCalledTimes(1);
      expect(isMonorepoPluginModuleLoaded('vibex.browser')).toBe(true);
      expect(serviceContainer.has('vibex.browser')).toBe(true);
      expect(
        settingsPageRegistry.get('vibex.browser:browser-settings')?.component
      ).toBeTypeOf('function');
      expect(commandRegistry.has('vibex.browser.open-tab')).toBe(true);

      // Still disabled plugins remain unloaded
      expect(isMonorepoPluginModuleLoaded('vibex.notes')).toBe(false);

      // 3. Dynamically disabling vibex.browser immediately unloads all its contributions
      await syncMonorepoPluginRuntime('vibex.browser', false);
      expect(serviceContainer.has('vibex.browser')).toBe(false);
      expect(
        settingsPageRegistry.get('vibex.browser:browser-settings')
      ).toBeUndefined();
      expect(commandRegistry.has('vibex.browser.open-tab')).toBe(false);

      // 4. Hot-reloading an official plugin cleanly re-activates it
      await reloadMonorepoPlugin('vibex.browser', { generation: 2 });
      expect(serviceContainer.has('vibex.browser')).toBe(true);
      expect(commandRegistry.has('vibex.browser.open-tab')).toBe(true);
    } finally {
      browserLoadSpy.mockRestore();
    }
  });

  it('registers all views, panels, kanbanViews, commands, slashCommands, and services when all 13 plugins are enabled and cleans up 100% on unloadPluginRuntime', async () => {
    const activated = await bootstrapMonorepoOfficialPlugins();
    expect(activated).toHaveLength(13);

    for (const bundle of MONOREPO_OFFICIAL_PLUGIN_BUNDLES) {
      expect(isMonorepoPluginModuleLoaded(bundle.id)).toBe(true);
      expect(getMonorepoPluginLoadCount(bundle.id)).toBeGreaterThanOrEqual(1);
    }

    // Services from all 13 official plugins
    const expectedServices = [
      'vibex.provider-catalog',
      'vibex.plugin-dev',
      'vibex.session-enhance',
      'vibex.browser',
      'vibex.office',
      'vibex.workflow-creator',
      'vibex.remote-ssh',
      'vibex.open-connector',
      'vibex.science',
      'vibex.computer-use',
      'vibex.kanban-views',
      'vibex.notes',
      'vibex.prompt-enhancer',
    ];
    for (const serviceKey of expectedServices) {
      expect(serviceContainer.has(serviceKey)).toBe(true);
    }

    // Views, Panels, KanbanViews, SettingsPages self-registered by plugins
    expect(
      settingsPageRegistry.get('vibex.browser:browser-settings')?.component
    ).toBeTypeOf('function');
    expect(panelRegistry.get('vibex.browser:browser')?.component).toBeTypeOf(
      'function'
    );
    expect(
      settingsPageRegistry.get('vibex-plugin-computer-use:computer-use')
        ?.component
    ).toBeTypeOf('function');
    expect(
      viewRegistry.get('vibex-plugin-computer-use:computer-use-status')
        ?.component
    ).toBeTypeOf('function');
    expect(
      viewRegistry.get('vibex.open-connector:console')?.component
    ).toBeTypeOf('function');
    expect(
      settingsPageRegistry.get('vibex.open-connector:settings')?.component
    ).toBeTypeOf('function');
    expect(
      settingsPageRegistry.get('vibex.remote-ssh:connect-panel')?.component
    ).toBeTypeOf('function');
    expect(panelRegistry.get('vibex.notes:notes')?.component).toBeTypeOf(
      'function'
    );
    expect(
      kanbanViewRegistry.get('vibex.kanban-views:triage-board')?.component
    ).toBeTypeOf('function');
    expect(
      kanbanViewRegistry.get('vibex.kanban-views:velocity-timeline')?.component
    ).toBeTypeOf('function');

    // Commands
    const expectedCommands = [
      'vibex.provider-switch.open-catalog',
      'reload-plugins',
      'vibex.session-enhance.toggle-hints',
      'vibex.browser.open-tab',
      'vibex.office.preview',
      'vibex.workflow-creator.new',
      'vibex.remote-ssh.connect',
      'runtime-status-command',
      'vibex.science.configure-domains',
      'vibex.computer-use.emergency-stop',
      'vibex.kanban.triage',
      'kanban-filter-command',
      'open-notes',
      'vibex.notes.new',
      'vibex.notes.export-markdown',
      'enhance-prompt-command',
    ];
    for (const cmdId of expectedCommands) {
      expect(commandRegistry.has(cmdId)).toBe(true);
    }

    // Slash commands
    const slashNames = slashCommandRegistry.getAll().map((s) => s.name);
    expect(slashNames).toEqual(
      expect.arrayContaining([
        'plugin-dev',
        'browse',
        'office-summary',
        'workflow',
        'ssh-connect',
        'connector',
        'science-literature',
        'computer-use',
        'kanban-triage',
        'note',
        'enhance',
      ])
    );

    // Unload every official plugin one by one and verify 100% cleanup
    for (const bundle of MONOREPO_OFFICIAL_PLUGIN_BUNDLES) {
      unloadPluginRuntime(bundle.id);
    }

    for (const serviceKey of expectedServices) {
      expect(serviceContainer.has(serviceKey)).toBe(false);
    }
    for (const cmdId of expectedCommands) {
      expect(commandRegistry.has(cmdId)).toBe(false);
    }

    expect(
      viewRegistry
        .getAll()
        .filter((item) => officialPluginIds.has(item.pluginId ?? ''))
    ).toHaveLength(0);
    expect(
      panelRegistry
        .getAll()
        .filter((item) => officialPluginIds.has(item.pluginId ?? ''))
    ).toHaveLength(0);
    expect(
      kanbanViewRegistry
        .getAll()
        .filter((item) => officialPluginIds.has(item.pluginId ?? ''))
    ).toHaveLength(0);
    expect(
      settingsPageRegistry
        .getAll()
        .filter((item) => officialPluginIds.has(item.pluginId ?? ''))
    ).toHaveLength(0);
    expect(
      settingRegistry
        .getAll()
        .filter((item) => officialPluginIds.has(item.pluginId ?? ''))
    ).toHaveLength(0);
    expect(
      slashCommandRegistry
        .getAll()
        .filter((item) => officialPluginIds.has(item.pluginId ?? ''))
    ).toHaveLength(0);
    expect(
      slotRegistry
        .getAll()
        .filter((item) => officialPluginIds.has(item.pluginId ?? ''))
    ).toHaveLength(0);
    expect(
      providerRegistry
        .getAll()
        .filter((item) => officialPluginIds.has(item.pluginId ?? ''))
    ).toHaveLength(0);
    expect(
      promptContextRegistry
        .getAll()
        .filter((item) => officialPluginIds.has(item.pluginId ?? ''))
    ).toHaveLength(0);
    expect(
      internalMessageCaptureRegistry
        .getAll()
        .filter((item) => officialPluginIds.has(item.pluginId ?? ''))
    ).toHaveLength(0);
  });

  it('executes closed-loop capabilities for prompt-enhancer, notes, and kanban-views', async () => {
    await bootstrapMonorepoOfficialPlugins({
      onlyIds: [
        'vibex.prompt-enhancer',
        'vibex.notes',
        'vibex.kanban-views',
      ],
    });

    // 1. Prompt Enhancer closed loop: config modes + beforeTurn waterfall hook
    const promptEnhancer = serviceContainer.get<{
      enhance: (text: string) => string;
      enhanceAsync: (text: string) => Promise<string>;
      setConfig: (patch: Record<string, unknown>) => Promise<Record<string, unknown>>;
      getConfig: () => Record<string, unknown>;
    }>('vibex.prompt-enhancer')!;
    expect(promptEnhancer).toBeDefined();

    const syncEnhanced = promptEnhancer.enhance('Fix race condition');
    expect(syncEnhanced).toContain('Fix race condition');
    expect(syncEnhanced).toContain(
      '[Constraints: Complete implementation, verify with tests.]'
    );

    await promptEnhancer.setConfig({
      mode: 'host-service',
      autoEnhanceBeforeTurn: true,
    });
    const turnResult = await serviceContainer.runWaterfall<{
      conversationId: string;
      turnId: string;
      prompt: string;
      prependSystemPrompt?: string;
    }>('conversation.beforeTurn', {
      conversationId: 'conv-1',
      turnId: 'turn-1',
      prompt: 'Refactor plugin loader',
    });
    expect(turnResult.prompt).toContain('[Host LLM Enhanced]');
    expect(turnResult.prompt).toContain('Refactor plugin loader');
    expect(turnResult.prependSystemPrompt).toContain(
      '[Constraints: Complete implementation, verify with tests.]'
    );

    // 2. Workspace Notes closed loop: KV storage + selection capture + reactive subscription + Markdown export
    const notesService = serviceContainer.get<{
      listNotes: () => Promise<Array<{ id: string; text: string }>>;
      addNote: (text: string) => Promise<Array<{ id: string; text: string }>>;
      searchNotes: (query: string) => Promise<Array<{ id: string; text: string }>>;
      deleteNote: (idOrIdx: string | number) => Promise<Array<{ id: string; text: string }>>;
      exportMarkdown: () => Promise<string>;
      subscribe: (fn: (items: Array<{ id: string; text: string }>) => void) => () => void;
    }>('vibex.notes')!;
    expect(notesService).toBeDefined();

    const observedUpdates: number[] = [];
    const unsubscribeNotes = notesService.subscribe((items) => {
      observedUpdates.push(items.length);
    });

    await notesService.addNote('Architecture note: dynamic imports');
    const captureMenu = slotRegistry
      .getBySlot('message.context-menu')
      .find((item) => item.id === 'vibex.notes.capture-selection');
    expect(captureMenu).toBeDefined();
    await (
      captureMenu as unknown as {
        onActivate?: (ctx: { selectionText: string }) => Promise<void>;
      }
    )?.onActivate?.({ selectionText: 'Captured from selection context menu' });

    const allNotes = await notesService.listNotes();
    expect(allNotes).toHaveLength(2);
    expect(observedUpdates).toEqual([1, 2]);

    const searchMatches = await notesService.searchNotes('selection');
    expect(searchMatches).toHaveLength(1);
    expect(searchMatches[0]?.text).toBe('Captured from selection context menu');

    const markdown = await notesService.exportMarkdown();
    expect(markdown).toContain('# Workspace Notes');
    expect(markdown).toContain('Architecture note: dynamic imports');
    expect(markdown).toContain('Captured from selection context menu');

    await notesService.deleteNote(allNotes[0]!.id);
    expect(await notesService.listNotes()).toHaveLength(1);
    unsubscribeNotes();

    // 3. Kanban Views closed loop: registered views + triage execution + foundation coordination
    const kanbanService = serviceContainer.get<{
      defaultViews: string[];
      registeredViews: string[];
      triageTasks: (
        tasks?: Array<Record<string, unknown>>
      ) => Promise<{
        totalTasks: number;
        buckets: Record<string, unknown[]>;
        metrics: { completedCount: number; blockedCount: number; completionRate: number };
      }>;
      cycleFilterPreset: () => Promise<string>;
      getFoundationStatus: () => { connected: boolean; serviceKey: string };
    }>('vibex.kanban-views')!;
    expect(kanbanService).toBeDefined();
    expect(kanbanService.getFoundationStatus().connected).toBe(true);
    expect(kanbanService.registeredViews).toEqual([
      'triage-board',
      'velocity-timeline',
    ]);

    const report = await kanbanService.triageTasks([
      { id: 't1', title: 'Urgent production crash', priority: 'urgent', status: 'todo' },
      { id: 't2', title: 'Blocked migration [blocked]', priority: 'high', status: 'in_progress', blocked: true },
      { id: 't3', title: 'Completed unit tests', priority: 'normal', status: 'done' },
    ]);
    expect(report.totalTasks).toBe(3);
    expect(report.buckets.urgent.length).toBeGreaterThanOrEqual(1);
    expect(report.metrics.completedCount).toBe(1);
    expect(report.metrics.blockedCount).toBe(1);
    expect(report.metrics.completionRate).toBe(33);

    const nextPreset = await kanbanService.cycleFilterPreset();
    expect(nextPreset).toBe('priority');
  });
});
