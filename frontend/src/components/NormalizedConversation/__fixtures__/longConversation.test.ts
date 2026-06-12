import { describe, expect, it } from 'vitest';
import {
  createLongConversationFixture,
  mixedRenderingConversationFixture,
} from './longConversation';

describe('long conversation fixture', () => {
  it('keeps the default 1,000 row pressure fixture', () => {
    expect(createLongConversationFixture()).toHaveLength(1000);
  });

  it('covers the Phase 2 rendering surfaces', () => {
    const entries = mixedRenderingConversationFixture;
    const text = entries
      .map((entry) =>
        entry.type === 'NORMALIZED_ENTRY' ? entry.content.content : ''
      )
      .join('\n');
    const serialized = JSON.stringify(entries);
    const toolActions = new Set(
      entries
        .map((entry) =>
          entry.type === 'NORMALIZED_ENTRY' &&
          entry.content.entry_type.type === 'tool_use'
            ? entry.content.entry_type.action_type.action
            : null
        )
        .filter(Boolean)
    );

    expect(text).toContain('中文');
    expect(text).toContain('日本語');
    expect(text).toContain('한국어');
    expect(text).toContain('```tsx');
    expect(text).toContain('$E = mc^2$');
    expect(text).toContain('```mermaid');
    expect(text).toContain('.vibe-images/t2-dashboard-preview.png');
    expect(text).toContain('Thinking');
    expect(serialized).toContain('diff --git');
    expect(toolActions).toEqual(
      new Set([
        'command_run',
        'file_read',
        'search',
        'web_fetch',
        'file_edit',
        'plan_presentation',
        'tool',
      ])
    );
  });
});
