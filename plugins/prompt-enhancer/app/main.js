const DEFAULT_CONSTRAINT_TEMPLATE =
  '[Constraints: Complete implementation, verify with tests.]';

const DEFAULT_CONFIG = {
  mode: 'structured',
  autoEnhanceBeforeTurn: false,
  customConstraintTemplate: DEFAULT_CONSTRAINT_TEMPLATE,
  includeAcceptanceCriteria: true,
};

function normalizeConfig(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_CONFIG };
  }
  const mode =
    raw.mode === 'custom-template' ||
    raw.mode === 'host-service' ||
    raw.mode === 'structured'
      ? raw.mode
      : DEFAULT_CONFIG.mode;
  const autoEnhanceBeforeTurn =
    typeof raw.autoEnhanceBeforeTurn === 'boolean'
      ? raw.autoEnhanceBeforeTurn
      : DEFAULT_CONFIG.autoEnhanceBeforeTurn;
  const customConstraintTemplate =
    typeof raw.customConstraintTemplate === 'string' &&
    raw.customConstraintTemplate.trim().length > 0
      ? raw.customConstraintTemplate.trim()
      : DEFAULT_CONFIG.customConstraintTemplate;
  const includeAcceptanceCriteria =
    typeof raw.includeAcceptanceCriteria === 'boolean'
      ? raw.includeAcceptanceCriteria
      : DEFAULT_CONFIG.includeAcceptanceCriteria;

  return {
    mode,
    autoEnhanceBeforeTurn,
    customConstraintTemplate,
    includeAcceptanceCriteria,
  };
}

function formatEnhancedPromptSync(promptText, configInput) {
  const config = normalizeConfig(configInput);
  const trimmed = String(promptText ?? '').trim();
  const constraintLine =
    config.customConstraintTemplate || DEFAULT_CONSTRAINT_TEMPLATE;

  if (!trimmed) {
    return constraintLine;
  }

  if (config.mode === 'custom-template') {
    if (constraintLine.includes('{prompt}')) {
      return constraintLine.replace(/\{prompt\}/g, trimmed);
    }
    return `${trimmed}\n\n${constraintLine}`;
  }

  const sections = [trimmed];
  if (config.includeAcceptanceCriteria) {
    sections.push(
      [
        'Execution Expectations:',
        '1. Identify root causes before applying fixes.',
        '2. Deliver a complete, production-ready implementation with no dead code.',
        '3. Verify behavior with automated tests and type/lint checks.',
      ].join('\n')
    );
  }
  sections.push(constraintLine);
  return sections.join('\n\n');
}

export default {
  apiVersion: '2.0',
  id: 'vibex.prompt-enhancer',
  activate(ctx) {
    let currentConfig = { ...DEFAULT_CONFIG };
    let lastEnhancedDraft = '';
    const history = [];

    ctx.effect(() => () => {
      history.length = 0;
      lastEnhancedDraft = '';
    });

    async function resolveConfig(overrides) {
      let storedSettings = null;
      let storedKvConfig = null;
      try {
        if (typeof ctx.settings?.get === 'function') {
          storedSettings = await ctx.settings.get();
        } else if (typeof ctx.storage?.settings?.get === 'function') {
          storedSettings = await ctx.storage.settings.get();
        }
      } catch {
        storedSettings = null;
      }
      try {
        storedKvConfig = await ctx.storage.kv.get('config');
      } catch {
        storedKvConfig = null;
      }
      currentConfig = normalizeConfig({
        ...currentConfig,
        ...(storedSettings && typeof storedSettings === 'object'
          ? storedSettings
          : {}),
        ...(storedKvConfig && typeof storedKvConfig === 'object'
          ? storedKvConfig
          : {}),
        ...(overrides && typeof overrides === 'object' ? overrides : {}),
      });
      return currentConfig;
    }

    async function callHostEnhanceService(rawPrompt, config) {
      const hostService =
        ctx.services.get('enhance_prompt') ??
        ctx.services.get('vibex.prompt-enhancer.host');
      if (hostService) {
        if (typeof hostService === 'function') {
          const out = await hostService(rawPrompt, config);
          if (typeof out === 'string' && out.trim()) return out.trim();
        } else if (typeof hostService.enhance_prompt === 'function') {
          const out = await hostService.enhance_prompt(rawPrompt, config);
          if (typeof out === 'string' && out.trim()) return out.trim();
        } else if (typeof hostService.enhancePrompt === 'function') {
          const out = await hostService.enhancePrompt(rawPrompt, config);
          if (typeof out === 'string' && out.trim()) return out.trim();
        }
      }

      try {
        const res = await ctx.conversation.call('enhance_prompt', {
          prompt: rawPrompt,
          mode: config.mode,
          constraints: config.customConstraintTemplate,
        });
        if (typeof res === 'string' && res.trim()) {
          return res.trim();
        }
        if (res && typeof res === 'object') {
          const candidate =
            res.enhancedPrompt ?? res.prompt ?? res.text ?? res.content;
          if (typeof candidate === 'string' && candidate.trim()) {
            return candidate.trim();
          }
        }
      } catch {
        // Fallback to local structured enhancement when host LLM endpoint is offline.
      }

      return formatEnhancedPromptSync(rawPrompt, config);
    }

    function enhance(promptText, options) {
      const mergedConfig = normalizeConfig({
        ...currentConfig,
        ...(options && typeof options === 'object' ? options : {}),
      });
      const result = formatEnhancedPromptSync(promptText, mergedConfig);
      lastEnhancedDraft = result;
      history.push({
        original: String(promptText ?? ''),
        enhanced: result,
        mode: mergedConfig.mode,
        timestamp: Date.now(),
      });
      return result;
    }

    async function enhanceAsync(promptText, options) {
      const config = await resolveConfig(options);
      const raw = String(promptText ?? '').trim();
      const enhanced =
        config.mode === 'host-service'
          ? await callHostEnhanceService(raw, config)
          : formatEnhancedPromptSync(raw, config);
      lastEnhancedDraft = enhanced;
      const entry = {
        original: raw,
        enhanced,
        mode: config.mode,
        timestamp: Date.now(),
      };
      history.push(entry);
      try {
        await ctx.storage.kv.set('lastEnhanced', entry);
      } catch {
        // Ignore KV persistence errors in read-only environments.
      }
      ctx.events.emit('prompt-enhancer:enhanced', entry);
      return enhanced;
    }

    ctx.hooks.beforeTurn(async (turn, next) => {
      const config = await resolveConfig();
      const shouldEnhance =
        config.autoEnhanceBeforeTurn || Boolean(turn && turn.autoEnhance);
      if (!shouldEnhance) {
        return typeof next === 'function' ? await next(turn) : turn;
      }

      const rawPrompt =
        typeof turn === 'string'
          ? turn
          : String(
              turn?.prompt ?? turn?.content ?? turn?.text ?? turn?.input ?? ''
            );
      const enhancedPrompt = await enhanceAsync(rawPrompt, config);
      const constraintDirective =
        config.customConstraintTemplate || DEFAULT_CONSTRAINT_TEMPLATE;

      if (typeof turn === 'string') {
        return typeof next === 'function'
          ? await next(enhancedPrompt)
          : enhancedPrompt;
      }
      if (!turn || typeof turn !== 'object') {
        const fallbackTurn = {
          prompt: enhancedPrompt,
          text: enhancedPrompt,
          prependSystemPrompt: constraintDirective,
          hiddenContext: constraintDirective,
        };
        return typeof next === 'function'
          ? await next(fallbackTurn)
          : fallbackTurn;
      }

      const enrichedTurn = {
        ...turn,
        prompt: enhancedPrompt,
        content:
          typeof turn.content === 'string' ? enhancedPrompt : turn.content,
        text: enhancedPrompt,
        prependSystemPrompt: [
          turn.prependSystemPrompt,
          constraintDirective,
        ]
          .filter(Boolean)
          .join('\n'),
        hiddenContext: [turn.hiddenContext, constraintDirective]
          .filter(Boolean)
          .join('\n'),
      };
      return typeof next === 'function'
        ? await next(enrichedTurn)
        : enrichedTurn;
    });

    ctx.ui.registerSlashCommand({
      id: 'enhance',
      name: 'enhance',
      title: 'Enhance Prompt',
      description:
        'Refine prompt with explicit acceptance criteria and verification steps',
      argumentHint: '<prompt to refine>',
      prompt:
        'Please structure and execute this request with root-cause analysis and verification:',
      execute: async (args) => {
        const input = String(args ?? '').trim();
        if (!input) {
          return 'Please structure and execute this request with root-cause analysis and verification:';
        }
        return await enhanceAsync(input);
      },
    });

    ctx.ui.registerComposerAction({
      id: 'enhance-prompt',
      label: 'Enhance Prompt',
      title: 'Enhance Prompt',
      tooltip:
        'Refine composer prompt with engineering constraints and verification steps',
      icon: 'sparkles',
      prompt:
        'Ensure the implementation is complete, root-cause-driven, and verified with tests. ',
      onActivate: async () => {
        const draft =
          (await ctx.storage.kv.get('composerDraft')) ||
          'Ensure the implementation is complete, root-cause-driven, and verified with tests.';
        return await enhanceAsync(draft);
      },
    });

    ctx.ui.registerCommand({
      id: 'enhance-prompt-command',
      title: 'Enhance Composer Prompt',
      category: 'Prompt',
      icon: 'sparkles',
      handler: async () => {
        const draft =
          (await ctx.storage.kv.get('composerDraft')) ||
          lastEnhancedDraft ||
          'Refine the current task with explicit root-cause analysis and verification.';
        return await enhanceAsync(draft);
      },
    });

    ctx.ui.registerSettingsSection({
      id: 'prompt-enhancer-settings',
      title: 'Prompt Enhancer',
      description:
        'Configure prompt enhancement mode, custom constraints, and automatic beforeTurn refinement.',
      category: 'Agent',
      icon: 'sparkles',
    });

    ctx.services.provide('vibex.prompt-enhancer', {
      enhance,
      enhanceAsync,
      getConfig() {
        return { ...currentConfig };
      },
      async loadConfig() {
        return await resolveConfig();
      },
      async setConfig(patch) {
        currentConfig = normalizeConfig({
          ...currentConfig,
          ...(patch && typeof patch === 'object' ? patch : {}),
        });
        try {
          await ctx.storage.kv.set('config', currentConfig);
        } catch {
          // Ignore storage error when transport is mocked.
        }
        try {
          await ctx.storage.settings.set(currentConfig);
        } catch {
          // Ignore if settings transport is not configured.
        }
        ctx.events.emit('prompt-enhancer:config-changed', currentConfig);
        return { ...currentConfig };
      },
      getHistory() {
        return [...history];
      },
    });
  },
};
