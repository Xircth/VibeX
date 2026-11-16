import { describe, expect, it } from 'vitest';
import type { PatchTypeWithKey } from '@/hooks/conversationEntries';
import { buildPromptEnhancementContext } from './promptEnhancement';

function normalizedEntry(
  key: string,
  entry_type: Record<string, unknown>,
  content: string,
  timestamp: string | null = '2026-06-01T12:00:00.000Z'
): PatchTypeWithKey {
  return {
    type: 'NORMALIZED_ENTRY',
    patchKey: key,
    executionProcessId: 'proc-1',
    content: {
      timestamp,
      entry_type: entry_type as never,
      content,
    },
  };
}

describe('buildPromptEnhancementContext', () => {
  it('returns empty when maxChars <= 0 or entries have no meaningful content', () => {
    const entries = [
      normalizedEntry('k1', { type: 'user_message' }, '   '),
      normalizedEntry('k2', { type: 'assistant_message' }, 'hello'),
    ];
    expect(buildPromptEnhancementContext(entries, 0)).toEqual([]);
    expect(buildPromptEnhancementContext(entries, -10)).toEqual([]);
    expect(
      buildPromptEnhancementContext([
        normalizedEntry('k1', { type: 'user_message' }, '   '),
      ])
    ).toEqual([]);
  });

  it('truncates an oversized latest message instead of exceeding maxChars', () => {
    const entries = [
      normalizedEntry('k1', { type: 'user_message' }, 'older message', null),
      normalizedEntry(
        'k2',
        { type: 'assistant_message' },
        'x'.repeat(200),
        null
      ),
    ];

    const result = buildPromptEnhancementContext(entries, 80);
    expect(result).toHaveLength(1);
    expect(result[0]?.role).toBe('assistant');
    expect(result[0]?.content.endsWith('…')).toBe(true);
    expect(
      result[0]!.role.length + result[0]!.content.length + 16
    ).toBeLessThanOrEqual(80);
  });

  it('summarizes tool_use entries and preserves chronological order', () => {
    const entries = [
      normalizedEntry('k1', { type: 'user_message' }, 'Check tests'),
      normalizedEntry(
        'k2',
        {
          type: 'tool_use',
          tool_name: 'Bash',
          action_type: { action: 'command_run', command: 'pnpm test' },
          status: { status: 'success' },
        },
        'All passed'
      ),
      normalizedEntry('k3', { type: 'error_message' }, 'Timeout'),
    ];

    const result = buildPromptEnhancementContext(entries);
    expect(result.map((item) => item.role)).toEqual(['user', 'tool', 'system']);
    expect(result[1]?.content).toContain('Tool: Bash');
    expect(result[1]?.content).toContain('Command: pnpm test');
    expect(result[2]?.content).toBe('[Error] Timeout');
  });
});
