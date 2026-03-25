import { describe, expect, it } from 'vitest';
import type { ExecutorConfigs } from 'shared/types';
import {
  getClaudeVariantFromSelection,
  getCodexVariantConfig,
  getCodexVariantFromConfigSelection,
  getOpenCodeVariantConfig,
  getOpenCodeVariantFromSelection,
} from './executor';

const profiles = {
  CLAUDE_CODE: {
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
  CODEX: {
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
  OPENCODE: {
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

  it('derives Codex config from the selected variant', () => {
    expect(getCodexVariantConfig(profiles, 'GPT_5_2_APPROVALS')).toMatchObject({
      model: 'gpt-5.2',
      sandbox: 'workspace-write',
      approvalPolicy: 'unless-trusted',
    });
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

  it('derives OpenCode config from the selected variant', () => {
    expect(getOpenCodeVariantConfig(profiles, 'PLAN')).toMatchObject({
      agentMode: 'plan',
      permissionMode: 'auto',
    });
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
