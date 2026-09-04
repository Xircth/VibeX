import { describe, expect, it } from 'vitest';

import type { AgentKind } from 'shared/types';

import {
  getAgentName,
  normalizeAgentIconKey,
} from '@/components/agents/AgentIcon';

import { SLOT_A, SLOT_B } from './EquationLine';

/**
 * Typed against `AgentKind`, so an agent that leaves the Rust identity enum
 * fails to compile here rather than silently staying on the landing page.
 */
const RUNNABLE_AGENTS: AgentKind[] = [
  'claude_code',
  'codex',
  'antigravity',
  'openclaw',
  'opencode',
  'cline',
  'hermes',
  'codebuddy',
  'kimi_code',
  'pi',
  'grok',
  'cursor',
  'deepseek_harness',
  'qoder',
];

describe('onboarding equation slots', () => {
  it('only advertises agents VibeX can run', () => {
    const advertised = SLOT_B.map((item) => normalizeAgentIconKey(item.id));
    expect(advertised).toEqual(RUNNABLE_AGENTS);
  });

  it('renders every advertised agent with its own brand mark', () => {
    for (const item of SLOT_B) {
      expect(item.kind).toBe('agent');
      expect(getAgentName(item.id)).not.toBe(item.id);
    }
  });

  it('treats Qoder as both an origin IDE and a runnable agent', () => {
    const originEntry = SLOT_A.find((item) => item.id === 'qoder');
    expect(originEntry?.kind).toBe('agent');
    expect(SLOT_B.some((item) => item.id === 'qoder')).toBe(true);
  });
});
