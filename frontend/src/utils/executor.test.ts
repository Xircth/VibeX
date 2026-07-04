import { describe, expect, it } from 'vitest';
import type { ExecutorConfigs } from 'shared/types';
import {
  getClaudeModelOptions,
  getClaudeVariantConfig,
  getClaudeVariantFromSelection,
  getCodexModelOptions,
  getCodexVariantConfig,
  getCodexVariantFromConfigSelection,
  getOpenCodeVariantConfig,
  getOpenCodeVariantFromSelection,
  getOpenCodeModelOptions,
} from './executor';

const profiles = {
  claude_code: {
    DEFAULT: {
      CLAUDE_CODE: {
        append_prompt: null,
        dangerously_skip_permissions: true,
      },
    },
    PLAN: {
      CLAUDE_CODE: {
        append_prompt: null,
        plan: true,
      },
    },
    OPUS: {
      CLAUDE_CODE: {
        append_prompt: null,
        model: 'opus',
      },
    },
    APPROVALS: {
      CLAUDE_CODE: {
        append_prompt: null,
        approvals: true,
      },
    },
  },
  codex: {
    DEFAULT: {
      CODEX: {
        append_prompt: null,
        sandbox: 'danger-full-access',
      },
    },
    APPROVALS: {
      CODEX: {
        append_prompt: null,
        sandbox: 'workspace-write',
        ask_for_approval: 'unless-trusted',
      },
    },
    GPT_5_4: {
      CODEX: {
        append_prompt: null,
        model: 'gpt-5.4',
        sandbox: 'danger-full-access',
      },
    },
    GPT_5_4_APPROVALS: {
      CODEX: {
        append_prompt: null,
        model: 'gpt-5.4',
        sandbox: 'workspace-write',
        ask_for_approval: 'unless-trusted',
      },
    },
    GPT_5_2: {
      CODEX: {
        append_prompt: null,
        model: 'gpt-5.2',
        sandbox: 'danger-full-access',
      },
    },
    GPT_5_2_APPROVALS: {
      CODEX: {
        append_prompt: null,
        model: 'gpt-5.2',
        sandbox: 'workspace-write',
        ask_for_approval: 'unless-trusted',
      },
    },
  },
  opencode: {
    DEFAULT: {
      OPENCODE: {
        append_prompt: null,
        auto_compact: true,
        auto_approve: true,
      },
    },
    PLAN: {
      OPENCODE: {
        append_prompt: null,
        auto_compact: true,
        agent: 'plan',
        auto_approve: true,
      },
    },
    APPROVALS: {
      OPENCODE: {
        append_prompt: null,
        auto_compact: true,
        auto_approve: false,
      },
    },
  },
} as const satisfies ExecutorConfigs['executors'];

describe('executor utilities', () => {
  it('maps Claude controls back to real variants', () => {
    expect(getClaudeVariantFromSelection(profiles, 'auto', 'opus')).toBe(
      'OPUS'
    );
    expect(getClaudeVariantFromSelection(profiles, 'plan', null)).toBe('PLAN');
    expect(getClaudeVariantFromSelection(profiles, 'ask', null)).toBe(
      'APPROVALS'
    );
  });

  it('derives Claude Code model choices from profiles and local settings', () => {
    expect(getClaudeVariantConfig(profiles, null).model).toBe('sonnet');
    expect(
      getClaudeVariantFromSelection(profiles, 'auto', 'sonnet')
    ).toBeNull();
    expect(
      getClaudeModelOptions(profiles, {
        ANTHROPIC_MODEL: 'deepseek-v4-pro',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
      })
    ).toEqual([{ value: 'sonnet', label: 'deepseek-v4-pro' }]);
  });

  it('derives Codex config from the selected variant', () => {
    expect(getCodexVariantConfig(profiles, 'GPT_5_2_APPROVALS')).toMatchObject({
      model: 'gpt-5.2',
      sandbox: 'workspace-write',
      approvalPolicy: 'unless-trusted',
    });
  });

  it('uses GPT-5.3 Codex as the Codex model fallback without a Default option', () => {
    expect(getCodexVariantConfig(profiles, null).model).toBe('gpt-5.3-codex');

    const options = getCodexModelOptions(profiles);
    expect(options[0]).toEqual({
      value: 'gpt-5.3-codex',
      label: 'GPT-5.3 Codex',
    });
    expect(options.some((option) => option.value === null)).toBe(false);
    expect(options.some((option) => option.label === 'Default')).toBe(false);
  });

  it('maps Codex sandbox, approval and model back to real variants', () => {
    expect(
      getCodexVariantFromConfigSelection(profiles, {
        model: 'gpt-5.2',
        sandbox: 'workspace-write',
        approvalPolicy: 'unless-trusted',
        reasoningEffort: 'high',
      })
    ).toBe('GPT_5_2_APPROVALS');
  });

  it('maps GPT-5.4 back to a real Codex variant when available', () => {
    expect(
      getCodexVariantFromConfigSelection(profiles, {
        model: 'gpt-5.4',
        sandbox: 'danger-full-access',
        approvalPolicy: 'never',
        reasoningEffort: 'high',
      })
    ).toBe('GPT_5_4');
  });

  it('derives OpenCode config from the selected variant', () => {
    expect(getOpenCodeVariantConfig(profiles, 'PLAN')).toMatchObject({
      agentMode: 'plan',
      permissionMode: 'auto',
    });
  });

  it('keeps OpenCode model choices available before SDK metadata loads', () => {
    const options = getOpenCodeModelOptions(profiles);

    expect(options.some((option) => option.value === null)).toBe(false);
    expect(options.some((option) => option.label === 'Default')).toBe(false);
    expect(
      options.some((option) => option.value === 'opencode/gemini-3-flash')
    ).toBe(true);
    expect(options.length).toBeGreaterThan(1);
  });

  it('maps OpenCode mode and permission back to real variants', () => {
    expect(
      getOpenCodeVariantFromSelection(profiles, {
        model: null,
        agentMode: 'plan',
        permissionMode: 'auto',
      })
    ).toBe('PLAN');

    expect(
      getOpenCodeVariantFromSelection(profiles, {
        model: null,
        agentMode: null,
        permissionMode: 'ask',
      })
    ).toBe('APPROVALS');
  });
});
