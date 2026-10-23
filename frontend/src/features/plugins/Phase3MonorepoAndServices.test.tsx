import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  commandRegistry,
  providerRegistry,
  serviceContainer,
  settingsPageRegistry,
  slashCommandRegistry,
  slotRegistry,
  viewRegistry,
} from '@vibex/plugin-sdk';
import { agentManagementApi } from '@/features/agent-management/api';
import type { PlanUsageResult } from 'shared/types';
import { pluginRuntimeLoader } from './PluginRuntimeLoader';
import {
  MONOREPO_OFFICIAL_PLUGIN_BUNDLES,
  bootstrapMonorepoOfficialPlugins,
} from './monorepoPluginBootstrap';
import {
  getEditorOpenerService,
  getModelCatalogService,
  getUsageProviderService,
  resetHostProviderServicesForTest,
} from './providers/hostProviderServices';

vi.mock('@/lib/backendTransport', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/backendTransport')>();
  return {
    ...actual,
    backendCall: vi.fn(async (cmd: string) => {
      if (cmd === 'agent_plan_usage') {
        return {
          status: 'available',
          agent_id: 'claude-code',
          plan_name: 'Claude Max (Default)',
        };
      }
      return {};
    }),
  };
});

describe('Phase 3: Monorepo Official Plugins, Host Provider Services & Cross-Plugin Dependency Lifecycle', () => {
  beforeEach(() => {
    pluginRuntimeLoader.deactivateAll();
    resetHostProviderServicesForTest();
  });

  it('bootstraps all 13 monorepo official & capability plugins offline with zero network calls', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Offline mode: network fetch is forbidden'));

    try {
      const activated = await bootstrapMonorepoOfficialPlugins();
      expect(activated).toHaveLength(13);
      expect(activated).toEqual(
        MONOREPO_OFFICIAL_PLUGIN_BUNDLES.map((b) => b.id)
      );
      expect(fetchSpy).not.toHaveBeenCalled();

      // Verify provider-switch registered providers and model catalog templates
      expect(providerRegistry.getIds()).toEqual(
        expect.arrayContaining([
          'anthropic-official',
          'openai-official',
          'deepseek-official',
        ])
      );
      const catalogView = await getModelCatalogService().listCatalog('opencode');
      expect(catalogView.templates.map((t) => t.id)).toEqual(
        expect.arrayContaining(['openrouter', 'siliconflow'])
      );

      // Verify slash commands from official & built-in plugins
      const slashNames = slashCommandRegistry.getAll().map((s) => s.name);
      expect(slashNames).toEqual(
        expect.arrayContaining([
          'browse',
          'office-summary',
          'workflow',
          'ssh-connect',
          'connector',
          'science-literature',
          'computer-use',
          'note',
          'enhance',
        ])
      );

      // Verify @ composer actions from prompt-enhancer
      const composerIds = slotRegistry
        .getBySlot('composer.actions')
        .map((s) => s.id);
      expect(composerIds).toEqual(
        expect.arrayContaining(['enhance-prompt'])
      );

      // Verify context menu from notes plugin
      const contextMenuIds = slotRegistry
        .getBySlot('message.context-menu')
        .map((s) => s.id);
      expect(contextMenuIds).toContain('vibex.notes.capture-selection');

      // Verify services provided by monorepo plugins
      expect(serviceContainer.has('vibex.provider-catalog')).toBe(true);
      expect(serviceContainer.has('vibex.session-enhance')).toBe(true);
      expect(slotRegistry.has('session-enhance-status')).toBe(true);
      expect(slotRegistry.get('session-enhance-status')?.label).toBe(
        'Session Enhance (2 templates)'
      );
      expect(serviceContainer.has('vibex.browser')).toBe(true);
      expect(serviceContainer.has('vibex.office')).toBe(true);
      expect(serviceContainer.has('vibex.workflow-creator')).toBe(true);
      expect(serviceContainer.has('vibex.remote-ssh')).toBe(true);
      expect(serviceContainer.has('vibex.open-connector')).toBe(true);
      expect(serviceContainer.has('vibex.science')).toBe(true);
      expect(serviceContainer.has('vibex.computer-use')).toBe(true);
      expect(serviceContainer.has('vibex.kanban-views')).toBe(true);
      expect(serviceContainer.has('vibex.notes')).toBe(true);
      expect(serviceContainer.has('vibex.prompt-enhancer')).toBe(true);

      // Verify in-process React views registered natively onto the v2 foundation
      expect(
        settingsPageRegistry.get('vibex.browser:browser-settings')?.component
      ).toBeTypeOf('function');
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
        settingsPageRegistry.get('vibex.remote-ssh:connect-panel')?.component
      ).toBeTypeOf('function');

      // Disabling upstream vibex.provider-switch automatically suspends vibex.session-enhance
      pluginRuntimeLoader.deactivate('vibex.provider-switch');
      expect(serviceContainer.has('vibex.provider-catalog')).toBe(false);
      expect(serviceContainer.has('vibex.session-enhance')).toBe(false);
      expect(slotRegistry.has('session-enhance-status')).toBe(false);

      // Re-enabling vibex.provider-switch automatically resumes vibex.session-enhance
      await bootstrapMonorepoOfficialPlugins({
        onlyIds: ['vibex.provider-switch'],
      });
      expect(serviceContainer.has('vibex.provider-catalog')).toBe(true);
      expect(serviceContainer.has('vibex.session-enhance')).toBe(true);
      expect(slotRegistry.has('session-enhance-status')).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('suspends Plugin B registrations when upstream Plugin A is disabled and automatically resumes when A is re-enabled via ctx.services.inject', async () => {
    const pluginA = {
      apiVersion: '2.0' as const,
      id: 'plugin.usage-provider',
      activate(ctx: import('@vibex/plugin-sdk').VibeXPluginContext) {
        ctx.services.provide('custom.usage-feed', {
          getQuotaRemaining: () => 88,
        });
      },
    };

    const pluginB = {
      apiVersion: '2.0' as const,
      id: 'plugin.usage-consumer',
      activate(ctx: import('@vibex/plugin-sdk').VibeXPluginContext) {
        ctx.services.inject(
          ['custom.usage-feed'],
          ([feed]: [{ getQuotaRemaining: () => number }]) => {
            const quota = feed.getQuotaRemaining();
            ctx.ui.registerStatusItem({
              id: 'quota-badge',
              label: `Quota: ${quota}%`,
            });
            ctx.services.provide('custom.usage-summary', {
              summaryText: `Remaining quota is ${quota}%`,
            });
          }
        );
      },
    };

    // Activate B before A: B waits until A's service is available
    await pluginRuntimeLoader.activateModule('plugin.usage-consumer', pluginB);
    expect(slotRegistry.has('quota-badge')).toBe(false);
    expect(serviceContainer.has('custom.usage-summary')).toBe(false);

    // Activate A: B immediately activates its injected sub-scope
    await pluginRuntimeLoader.activateModule('plugin.usage-provider', pluginA);
    expect(slotRegistry.has('quota-badge')).toBe(true);
    expect(slotRegistry.get('quota-badge')?.label).toBe('Quota: 88%');
    expect(
      serviceContainer.get<{ summaryText: string }>('custom.usage-summary')
        ?.summaryText
    ).toBe('Remaining quota is 88%');

    // Disable A: B's injected child scope automatically disposes (suspending B's status item & service)
    pluginRuntimeLoader.deactivate('plugin.usage-provider');
    expect(slotRegistry.has('quota-badge')).toBe(false);
    expect(serviceContainer.has('custom.usage-summary')).toBe(false);

    // Re-enable A: B automatically resumes!
    await pluginRuntimeLoader.activateModule('plugin.usage-provider', pluginA);
    expect(slotRegistry.has('quota-badge')).toBe(true);
    expect(
      serviceContainer.get<{ summaryText: string }>('custom.usage-summary')
        ?.summaryText
    ).toBe('Remaining quota is 88%');
  });

  it('suspends and resumes dependent plugin automatically when manifest dependencies.kind=plugin is declared', async () => {
    const upstreamModule = {
      apiVersion: '2.0' as const,
      id: 'vibex.base-toolkit',
      activate(ctx: import('@vibex/plugin-sdk').VibeXPluginContext) {
        ctx.ui.registerCommand({
          id: 'vibex.base-toolkit.ping',
          title: 'Base Toolkit Ping',
          handler: () => undefined,
        });
      },
    };

    const dependentModule = {
      apiVersion: '2.0' as const,
      id: 'vibex.dependent-feature',
      activate(ctx: import('@vibex/plugin-sdk').VibeXPluginContext) {
        ctx.ui.registerCommand({
          id: 'vibex.dependent-feature.run',
          title: 'Run Dependent Feature',
          handler: () => undefined,
        });
      },
    };

    await pluginRuntimeLoader.activateModule(
      'vibex.base-toolkit',
      upstreamModule
    );
    await pluginRuntimeLoader.activateModule(
      'vibex.dependent-feature',
      dependentModule,
      {
        spec: {
          id: 'vibex.dependent-feature',
          dependencies: [
            { kind: 'plugin', id: 'vibex.base-toolkit', required: true },
          ],
        },
      }
    );

    expect(commandRegistry.has('vibex.dependent-feature.run')).toBe(true);

    // Disable upstream -> dependent is automatically suspended
    pluginRuntimeLoader.deactivate('vibex.base-toolkit');
    expect(commandRegistry.has('vibex.dependent-feature.run')).toBe(false);

    // Re-enable upstream -> dependent automatically resumes
    await pluginRuntimeLoader.activateModule(
      'vibex.base-toolkit',
      upstreamModule
    );
    expect(commandRegistry.has('vibex.dependent-feature.run')).toBe(true);
  });

  it('allows plugins to extend and intercept vibex.usage, vibex.model-catalog, and vibex.editor host services', async () => {
    const extenderPlugin = {
      apiVersion: '2.0' as const,
      id: 'plugin.host-provider-extender',
      activate(ctx: import('@vibex/plugin-sdk').VibeXPluginContext) {
        // 1. Extend vibex.usage via registerUsageProber + service intercept
        const usageService = getUsageProviderService();
        const disposeProber = usageService.registerUsageProber({
          id: 'custom-usage-prober',
          label: 'Custom Usage Prober',
          agents: ['claude-code'],
          async probe({ current }) {
            return {
              ...(current ?? {}),
              status: 'available',
              plan_name: 'Claude Enterprise (Probed by Plugin)',
            } as unknown as PlanUsageResult;
          },
        });
        ctx.effect(() => disposeProber);

        ctx.services.intercept(
          'vibex.usage',
          (
            prev: import('./providers/hostProviderServices').UsageProviderService
          ) => ({
            ...prev,
            async probeAgentUsage(
              agentId: string,
              fallback?: (
                id: import('shared/types').AgentId
              ) => Promise<PlanUsageResult>
            ) {
              const res = await prev.probeAgentUsage(agentId, fallback);
              return {
                ...res,
                interceptedBy: 'plugin.host-provider-extender',
              } as unknown as PlanUsageResult;
            },
          })
        );

        // 2. Extend vibex.editor with a custom external editor opener
        const editorService = getEditorOpenerService();
        const disposeEditor = editorService.registerEditorOpener({
          id: 'NEOVIM_GUI',
          label: 'Neovide (Plugin)',
          hint: 'neovide',
          isAvailable: () => true,
          openAttempt: async ({ attemptId, filePath }) => ({
            url: `neovide://open?attempt=${attemptId}&file=${filePath ?? ''}`,
          }),
        });
        ctx.effect(() => disposeEditor);
      },
    };

    await pluginRuntimeLoader.activateModule(
      'plugin.host-provider-extender',
      extenderPlugin
    );

    const usage = (await agentManagementApi.planUsage(
      'claude-code' as import('shared/types').AgentId
    )) as unknown as Record<string, unknown>;
    expect(usage.plan_name).toBe('Claude Enterprise (Probed by Plugin)');
    expect(usage.interceptedBy).toBe('plugin.host-provider-extender');

    const editorService = getEditorOpenerService();
    expect(await editorService.checkAvailability('NEOVIM_GUI')).toBe(true);
    const openRes = await editorService.openAttemptInEditor('attempt-42', {
      editorType: 'NEOVIM_GUI',
      filePath: 'src/main.rs',
    });
    expect(openRes.url).toBe('neovide://open?attempt=attempt-42&file=src/main.rs');

    // Deactivating the plugin cleanly restores default host provider behavior
    pluginRuntimeLoader.deactivate('plugin.host-provider-extender');
    expect(editorService.listEditorOpeners()).toHaveLength(0);
    const restoredUsage = (await agentManagementApi.planUsage(
      'claude-code' as import('shared/types').AgentId
    )) as unknown as Record<string, unknown>;
    expect(restoredUsage.plan_name).toBe('Claude Max (Default)');
    expect(restoredUsage.interceptedBy).toBeUndefined();
  });
});
