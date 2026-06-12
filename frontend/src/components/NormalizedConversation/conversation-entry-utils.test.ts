import { describe, expect, it } from 'vitest';
import {
  buildDisplayEntries,
  getCompactMetaNoticeText,
  getCompactVerboseErrorText,
  getToolSummary,
  isInternalTracingLogContent,
  isNeutralTransportNotice,
  normalizeMetaNoticeText,
  repairTokenizedStreamContent,
  sanitizeConversationContent,
  shouldHideInitializationNotice,
  splitAssistantCommandOutput,
  splitAssistantFinalMessage,
  splitLeadingCodexUnstableFeatureNotice,
  splitLeadingImpeccablePreflightNotice,
  splitLeadingTransportNotice,
} from './conversation-entry-utils';
import type { PatchTypeWithKey } from '@/hooks/useConversationHistory/types';

describe('conversation meta notices', () => {
  it('hides hook initialization config entries', () => {
    const shouldHide = shouldHideInitializationNotice(
      { type: 'system_message' } as never,
      'model: gpt-5.2\nreasoning effort: high'
    );

    expect(shouldHide).toBe(true);
  });

  it('does not hide normal assistant replies', () => {
    const shouldHide = shouldHideInitializationNotice(
      { type: 'assistant_message' } as never,
      'I updated the component and added tests.'
    );

    expect(shouldHide).toBe(false);
  });

  it('compacts model resume notices into one line', () => {
    const compactText = getCompactMetaNoticeText(
      { type: 'assistant_message' } as never,
      'This session was recorded with model `gpt-5.4` but is resuming with `gpt-5.2`.\nConsider switching back to `gpt-5.4` as it may affect Codex performance.'
    );

    expect(compactText).toBe(
      'This session was recorded with model gpt-5.4 but is resuming with gpt-5.2. Consider switching back to gpt-5.4 as it may affect Codex performance.'
    );
  });

  it('keeps rich formatted system content out of compact mode', () => {
    const compactText = getCompactMetaNoticeText(
      { type: 'system_message' } as never,
      '## Setup required\n- Install dependencies\n- Retry the task'
    );

    expect(compactText).toBeNull();
  });

  it('normalizes inline markdown markers in notices', () => {
    expect(
      normalizeMetaNoticeText('Recorded with `gpt-5.4` and **high** effort')
    ).toBe('Recorded with gpt-5.4 and high effort');
  });

  it('compacts transport fallback notices as neutral metadata', () => {
    const content =
      'Falling back from WebSockets to HTTPS transport. timeout waiting for child process to exit';

    expect(isNeutralTransportNotice(content)).toBe(true);
    expect(
      getCompactMetaNoticeText({ type: 'assistant_message' } as never, content)
    ).toBe(content);
  });

  it('splits transport fallback prefix from assistant output', () => {
    const content =
      'Falling back from WebSockets to HTTPS transport. timeout waiting for child process to exit我会先快速扫一遍项目结构和关键文档';

    expect(isNeutralTransportNotice(content)).toBe(false);
    expect(
      getCompactMetaNoticeText({ type: 'assistant_message' } as never, content)
    ).toBeNull();
    expect(splitLeadingTransportNotice(content)).toEqual({
      notice:
        'Falling back from WebSockets to HTTPS transport. timeout waiting for child process to exit',
      remainder: '我会先快速扫一遍项目结构和关键文档',
    });
  });

  it('compacts impeccable preflight notices as neutral metadata', () => {
    const content =
      'IMPECCABLE_PREFLIGHT: context=pass product=pass command_reference=pass shape=not_required image_gate=skipped:user gave explicit IA/layout and this is direct product-surface refactor mutation=open';

    expect(
      getCompactMetaNoticeText({ type: 'assistant_message' } as never, content)
    ).toBe(content);
    expect(splitLeadingImpeccablePreflightNotice(content)).toEqual({
      notice: content,
      remainder: '',
    });
  });

  it('splits impeccable preflight notices from assistant output', () => {
    const content =
      'IMPECCABLE_PREFLIGHT: context=pass product=pass command_reference=pass\nI will update the layout.';

    expect(
      getCompactMetaNoticeText({ type: 'assistant_message' } as never, content)
    ).toBeNull();
    expect(splitLeadingImpeccablePreflightNotice(content)).toEqual({
      notice:
        'IMPECCABLE_PREFLIGHT: context=pass product=pass command_reference=pass',
      remainder: 'I will update the layout.',
    });
  });

  it('splits Codex unstable feature warnings from assistant output', () => {
    const warning =
      'Under-development features enabled: child_agents_md. Under-development features are incomplete and may behave unpredictably. To suppress this warning, set suppress_unstable_features_warning = true in C:\\Users\\Administrator\\.codex\\config.toml.';
    const content = `${warning} 我是 Codex，一个基于 GPT 5 的编码代理。`;

    expect(
      getCompactMetaNoticeText({ type: 'assistant_message' } as never, content)
    ).toBeNull();
    expect(splitLeadingCodexUnstableFeatureNotice(content)).toEqual({
      notice: warning,
      remainder: '我是 Codex，一个基于 GPT 5 的编码代理。',
    });
    expect(
      getCompactMetaNoticeText({ type: 'assistant_message' } as never, warning)
    ).toBe(warning);
  });

  it('splits Codex unstable feature warnings when config flag is inline code', () => {
    const expectedNotice =
      'Under-development features enabled: child_agents_md. Under-development features are incomplete and may behave unpredictably. To suppress this warning, set suppress_unstable_features_warning = true in C:\\Users\\Administrator\\.codex\\config.toml.';
    const content =
      'Under-development features enabled: child_agents_md. Under-development features are incomplete and may behave unpredictably. To suppress this warning, set `suppress_unstable_features_warning = true` in C:\\Users\\Administrator\\.codex\\config.toml. I am Codex.';

    expect(splitLeadingCodexUnstableFeatureNotice(content)).toEqual({
      notice: expectedNotice,
      remainder: 'I am Codex.',
    });
    expect(
      getCompactMetaNoticeText({ type: 'assistant_message' } as never, content)
    ).toBeNull();
  });

  it('summarizes verbose command errors for hover-only detail', () => {
    const content = [
      'Wall time: 1.7 seconds Output:',
      'Set-PSReadLineOption : The predictive suggestion feature cannot be enabled because the console output does not support virtual terminal processing.',
      'CategoryInfo : NotSpecified: (:) [Set-PSReadLineOption], ArgumentException',
      'rg : The term rg is not recognized as the name of a cmdlet, function, script file, or operable program.',
      'FullyQualifiedErrorId : CommandNotFoundException',
    ].join('\n');

    expect(getCompactVerboseErrorText(content)).toBe(
      'Command failed: rg is not recognized'
    );
  });

  it('repairs persisted assistant messages that were split per stream token', () => {
    const content = [
      '我是基于 **GPT',
      '-5** 的 Codex',
      ' 编码代理。',
      '具体型号是 `gpt',
      '-5.5`。',
    ].join('\n');

    expect(repairTokenizedStreamContent(content)).toBe(
      '我是基于 **GPT-5** 的 Codex 编码代理。具体型号是 `gpt-5.5`。'
    );
  });

  it('does not flatten normal multiline assistant prose', () => {
    const content = [
      '第一段内容比较完整，不像是 token delta。',
      '',
      '第二段内容也比较完整，需要保留换行。',
    ].join('\n');

    expect(repairTokenizedStreamContent(content)).toBe(content);
  });

  it('splits literal command output assistant messages', () => {
    expect(
      splitAssistantCommandOutput('log before\nCommand output: Final answer')
    ).toEqual({
      prefix: 'log before',
      output: 'Final answer',
    });

    expect(
      splitAssistantCommandOutput('log before\nCommand output：Final answer')
    ).toEqual({
      prefix: 'log before',
      output: 'Final answer',
    });
  });

  it('splits shell output envelopes for assistant messages', () => {
    expect(
      splitAssistantCommandOutput(
        'Exit code: 0\nWall time: 1.7 seconds\nOutput:\nFinal answer'
      )
    ).toEqual({
      prefix: 'Exit code: 0\nWall time: 1.7 seconds\nOutput:',
      output: 'Final answer',
    });
  });

  it('falls back to collapsing earlier assistant paragraphs into a final message block', () => {
    expect(
      splitAssistantFinalMessage(
        '先检查前端入口与环境配置。\n\n再核对 dev server 端口映射与代理配置。\n\n前端已恢复访问。'
      )
    ).toEqual({
      prefix:
        '先检查前端入口与环境配置。\n\n再核对 dev server 端口映射与代理配置。',
      output: '前端已恢复访问。',
    });
  });

  it('collapses prior AI-side entries and keeps the final assistant message visible', () => {
    const entries: PatchTypeWithKey[] = [
      {
        type: 'NORMALIZED_ENTRY',
        patchKey: 'proc-1:user',
        executionProcessId: 'proc-1',
        content: {
          entry_type: { type: 'user_message' },
          content: '请启动项目',
          timestamp: null,
        },
      },
      {
        type: 'NORMALIZED_ENTRY',
        patchKey: 'proc-1:tool',
        executionProcessId: 'proc-1',
        content: {
          entry_type: {
            type: 'tool_use',
            tool_name: 'terminal',
            action_type: {
              action: 'command_run',
              command: 'pnpm run dev',
              result: null,
            },
            status: { status: 'success' },
          },
          content: 'pnpm run dev',
          timestamp: null,
        },
      },
      {
        type: 'NORMALIZED_ENTRY',
        patchKey: 'proc-1:assistant-1',
        executionProcessId: 'proc-1',
        content: {
          entry_type: { type: 'assistant_message' },
          content: '我先检查启动脚本。',
          timestamp: null,
        },
      },
      {
        type: 'NORMALIZED_ENTRY',
        patchKey: 'proc-1:subagent',
        executionProcessId: 'proc-1',
        content: {
          entry_type: {
            type: 'tool_use',
            tool_name: 'spawn_agent',
            action_type: {
              action: 'task_create',
              description: 'Inspect related components',
              subagent_type: 'explorer',
              result: null,
            },
            status: { status: 'created' },
          },
          content: 'Inspect related components',
          timestamp: null,
        },
      },
      {
        type: 'NORMALIZED_ENTRY',
        patchKey: 'proc-1:assistant-2',
        executionProcessId: 'proc-1',
        content: {
          entry_type: { type: 'assistant_message' },
          content: '项目已启动完成。',
          timestamp: null,
        },
      },
    ];

    const displayEntries = buildDisplayEntries(entries, {
      collapseAiMessagesByDefault: true,
    });

    expect(displayEntries).toHaveLength(3);
    expect(displayEntries[0]).toMatchObject({
      type: 'NORMALIZED_ENTRY',
      content: {
        entry_type: { type: 'user_message' },
      },
    });
    expect(displayEntries[1]).toMatchObject({
      type: 'COLLAPSED_ASSISTANT_MESSAGES',
      hiddenCount: 3,
      entries: expect.arrayContaining([
        expect.objectContaining({ patchKey: 'proc-1:subagent' }),
      ]),
    });
    expect(displayEntries[2]).toMatchObject({
      type: 'NORMALIZED_ENTRY',
      content: {
        entry_type: { type: 'assistant_message' },
        content: '项目已启动完成。',
      },
    });
  });

  it('aggregates consecutive command tool calls from the same tool', () => {
    const entries: PatchTypeWithKey[] = [
      {
        type: 'NORMALIZED_ENTRY',
        patchKey: 'proc-1:1',
        executionProcessId: 'proc-1',
        content: {
          entry_type: {
            type: 'tool_use',
            tool_name: 'bash',
            action_type: {
              action: 'command_run',
              command: 'pwd',
              result: null,
            },
            status: { status: 'success' },
          },
          content: 'pwd',
          timestamp: null,
        },
      },
      {
        type: 'NORMALIZED_ENTRY',
        patchKey: 'proc-1:2',
        executionProcessId: 'proc-1',
        content: {
          entry_type: {
            type: 'tool_use',
            tool_name: 'bash',
            action_type: {
              action: 'command_run',
              command: 'ls',
              result: null,
            },
            status: { status: 'success' },
          },
          content: 'ls',
          timestamp: null,
        },
      },
    ];

    const displayEntries = buildDisplayEntries(entries);

    expect(displayEntries).toHaveLength(1);
    expect(displayEntries[0]).toMatchObject({
      type: 'AGGREGATED_GROUP',
      aggregationType: 'command_run',
    });
  });

  it('summarizes Codex subagent status tools as status components', () => {
    const summary = getToolSummary(
      {
        type: 'tool_use',
        tool_name: 'wait_agent',
        action_type: {
          action: 'tool',
          tool_name: 'wait_agent',
          arguments: null,
          result: null,
        },
        status: { status: 'success' },
      },
      'agent-7: completed\nagent-8: running'
    );

    expect(summary).toEqual({
      label: '子代理状态',
      detail: 'agent-7: completed',
    });
  });

  it('aggregates consecutive command tool calls even when tool names differ', () => {
    const entries: PatchTypeWithKey[] = [
      {
        type: 'NORMALIZED_ENTRY',
        patchKey: 'proc-1:1',
        executionProcessId: 'proc-1',
        content: {
          entry_type: {
            type: 'tool_use',
            tool_name: 'shell_command',
            action_type: {
              action: 'command_run',
              command: 'pwd',
              result: null,
            },
            status: { status: 'success' },
          },
          content: 'pwd',
          timestamp: null,
        },
      },
      {
        type: 'NORMALIZED_ENTRY',
        patchKey: 'proc-1:2',
        executionProcessId: 'proc-1',
        content: {
          entry_type: {
            type: 'tool_use',
            tool_name: 'powershell',
            action_type: {
              action: 'command_run',
              command: 'ls',
              result: null,
            },
            status: { status: 'success' },
          },
          content: 'ls',
          timestamp: null,
        },
      },
    ];

    const displayEntries = buildDisplayEntries(entries);

    expect(displayEntries).toHaveLength(1);
    expect(displayEntries[0]).toMatchObject({
      type: 'AGGREGATED_GROUP',
      aggregationType: 'command_run',
    });
  });

  it('keeps script command tool calls separate', () => {
    const entries: PatchTypeWithKey[] = [
      {
        type: 'NORMALIZED_ENTRY',
        patchKey: 'proc-1:1',
        executionProcessId: 'proc-1',
        content: {
          entry_type: {
            type: 'tool_use',
            tool_name: 'bash',
            action_type: {
              action: 'command_run',
              command: 'pwd',
              result: null,
            },
            status: { status: 'success' },
          },
          content: 'pwd',
          timestamp: null,
        },
      },
      {
        type: 'NORMALIZED_ENTRY',
        patchKey: 'proc-1:2',
        executionProcessId: 'proc-1',
        content: {
          entry_type: {
            type: 'tool_use',
            tool_name: 'Setup Script',
            action_type: {
              action: 'command_run',
              command: 'pnpm install',
              result: null,
            },
            status: { status: 'success' },
          },
          content: 'pnpm install',
          timestamp: null,
        },
      },
    ];

    const displayEntries = buildDisplayEntries(entries);

    expect(displayEntries).toHaveLength(2);
    expect(displayEntries[0]?.type).toBe('NORMALIZED_ENTRY');
    expect(displayEntries[1]?.type).toBe('NORMALIZED_ENTRY');
  });

  it('keeps web fetch tool entries visible in the conversation display', () => {
    const entries: PatchTypeWithKey[] = [
      {
        type: 'NORMALIZED_ENTRY',
        patchKey: 'proc-1:web',
        executionProcessId: 'proc-1',
        content: {
          entry_type: {
            type: 'tool_use',
            tool_name: 'fetch',
            action_type: {
              action: 'web_fetch',
              url: 'https://example.com',
            },
            status: { status: 'success' },
          },
          content: 'https://example.com',
          timestamp: null,
        },
      },
      {
        type: 'NORMALIZED_ENTRY',
        patchKey: 'proc-1:assistant',
        executionProcessId: 'proc-1',
        content: {
          entry_type: { type: 'assistant_message' },
          content: 'Fetched the page.',
          timestamp: null,
        },
      },
    ];

    const displayEntries = buildDisplayEntries(entries);

    expect(displayEntries).toHaveLength(2);
    expect(displayEntries[0]).toMatchObject({
      type: 'NORMALIZED_ENTRY',
      content: {
        entry_type: {
          type: 'tool_use',
          action_type: { action: 'web_fetch' },
        },
      },
    });
    expect(displayEntries[1]).toMatchObject({
      type: 'NORMALIZED_ENTRY',
      content: {
        entry_type: { type: 'assistant_message' },
        content: 'Fetched the page.',
      },
    });
  });

  it('strips ansi and visible sgr fragments from conversation content', () => {
    expect(
      sanitizeConversationContent(
        '\u001b[31mERROR\u001b[0m [2mcodex_acp::thread[0m'
      )
    ).toBe('ERROR codex_acp::thread');
  });

  it('filters internal codex tracing logs out of display entries', () => {
    const entries: PatchTypeWithKey[] = [
      {
        type: 'NORMALIZED_ENTRY',
        patchKey: 'proc-1:1',
        executionProcessId: 'proc-1',
        content: {
          entry_type: { type: 'system_message' },
          content:
            '[2m2026-04-29T08:22:34.695492Z[0m [31mERROR[0m [2mcodex_acp::thread[0m[2m:[0m Handled error during turn',
          timestamp: null,
        },
      },
      {
        type: 'NORMALIZED_ENTRY',
        patchKey: 'proc-1:2',
        executionProcessId: 'proc-1',
        content: {
          entry_type: { type: 'assistant_message' },
          content: '正常回复',
          timestamp: null,
        },
      },
    ];

    const firstEntry = entries[0]!;
    expect(firstEntry.type).toBe('NORMALIZED_ENTRY');
    if (firstEntry.type !== 'NORMALIZED_ENTRY') {
      throw new Error('expected normalized entry');
    }
    expect(isInternalTracingLogContent(firstEntry.content.content)).toBe(true);
    const displayEntries = buildDisplayEntries(entries);

    expect(displayEntries).toHaveLength(1);
    expect(displayEntries[0]).toMatchObject({ patchKey: 'proc-1:2' });
  });

  it('aggregates consecutive file edits into an edit tool group', () => {
    const entries: PatchTypeWithKey[] = [
      {
        type: 'NORMALIZED_ENTRY',
        patchKey: 'proc-1:1',
        executionProcessId: 'proc-1',
        content: {
          entry_type: {
            type: 'tool_use',
            tool_name: 'edit',
            action_type: {
              action: 'file_edit',
              path: 'src/App.tsx',
              changes: [
                {
                  action: 'edit',
                  unified_diff: '@@\\n-a\\n+b',
                  has_line_numbers: true,
                },
              ],
            },
            status: { status: 'success' },
          },
          content: 'src/App.tsx',
          timestamp: null,
        },
      },
      {
        type: 'NORMALIZED_ENTRY',
        patchKey: 'proc-1:2',
        executionProcessId: 'proc-1',
        content: {
          entry_type: {
            type: 'tool_use',
            tool_name: 'edit',
            action_type: {
              action: 'file_edit',
              path: 'src/main.tsx',
              changes: [{ action: 'write', content: 'console.log(1);' }],
            },
            status: { status: 'success' },
          },
          content: 'src/main.tsx',
          timestamp: null,
        },
      },
    ];

    const displayEntries = buildDisplayEntries(entries);

    expect(displayEntries).toHaveLength(1);
    expect(displayEntries[0]).toMatchObject({
      type: 'AGGREGATED_FILE_EDIT_GROUP',
      executionProcessId: 'proc-1',
    });
  });

  it('adds one process change summary after a completed assistant turn', () => {
    const entries: PatchTypeWithKey[] = [
      {
        type: 'NORMALIZED_ENTRY',
        patchKey: 'proc-1:1',
        executionProcessId: 'proc-1',
        content: {
          entry_type: {
            type: 'tool_use',
            tool_name: 'edit',
            action_type: {
              action: 'file_edit',
              path: 'src/App.tsx',
              changes: [
                {
                  action: 'edit',
                  unified_diff: '@@\\n-a\\n+b',
                  has_line_numbers: true,
                },
              ],
            },
            status: { status: 'success' },
          },
          content: 'src/App.tsx',
          timestamp: null,
        },
      },
      {
        type: 'NORMALIZED_ENTRY',
        patchKey: 'proc-1:2',
        executionProcessId: 'proc-1',
        content: {
          entry_type: { type: 'assistant_message' },
          content: '已完成修改。',
          timestamp: null,
        },
      },
    ];

    const displayEntries = buildDisplayEntries(entries, {
      completedExecutionProcessIds: new Set(['proc-1']),
    });

    expect(displayEntries).toHaveLength(3);
    expect(displayEntries[0]?.type).toBe('NORMALIZED_ENTRY');
    expect(displayEntries[1]?.type).toBe('NORMALIZED_ENTRY');
    expect(displayEntries[2]).toMatchObject({
      type: 'PROCESS_CHANGE_SUMMARY',
      executionProcessId: 'proc-1',
    });
  });

  it('keeps a single completed file edit as an edit entry', () => {
    const entries: PatchTypeWithKey[] = [
      {
        type: 'NORMALIZED_ENTRY',
        patchKey: 'proc-1:1',
        executionProcessId: 'proc-1',
        content: {
          entry_type: {
            type: 'tool_use',
            tool_name: 'edit',
            action_type: {
              action: 'file_edit',
              path: 'src/App.tsx',
              changes: [
                {
                  action: 'edit',
                  unified_diff: '@@\\n-a\\n+b',
                  has_line_numbers: true,
                },
              ],
            },
            status: { status: 'success' },
          },
          content: 'src/App.tsx',
          timestamp: null,
        },
      },
    ];

    const displayEntries = buildDisplayEntries(entries);

    expect(displayEntries).toHaveLength(1);
    expect(displayEntries[0]?.type).toBe('NORMALIZED_ENTRY');
  });

  it('filters thinking entries out of the conversation display', () => {
    const entries: PatchTypeWithKey[] = [
      {
        type: 'NORMALIZED_ENTRY',
        patchKey: 'proc-1:1',
        executionProcessId: 'proc-1',
        content: {
          entry_type: { type: 'thinking' },
          content: 'first thought',
          timestamp: null,
        },
      },
      {
        type: 'NORMALIZED_ENTRY',
        patchKey: 'proc-1:2',
        executionProcessId: 'proc-1',
        content: {
          entry_type: { type: 'thinking' },
          content: 'second thought',
          timestamp: null,
        },
      },
    ];

    const displayEntries = buildDisplayEntries(entries, {
      aggregateThinking: true,
    });

    expect(displayEntries).toHaveLength(0);
  });

  it('does not create a collapsed assistant group for hidden metadata entries', () => {
    const entries: PatchTypeWithKey[] = [
      {
        type: 'NORMALIZED_ENTRY',
        patchKey: 'proc-1:1',
        executionProcessId: 'proc-1',
        content: {
          entry_type: {
            type: 'token_usage_info',
            total_tokens: 1,
            model_context_window: 100,
          },
          content: 'input: 1',
          timestamp: null,
        },
      },
      {
        type: 'NORMALIZED_ENTRY',
        patchKey: 'proc-1:2',
        executionProcessId: 'proc-1',
        content: {
          entry_type: {
            type: 'next_action',
            failed: false,
            execution_processes: 0,
            needs_setup: false,
          },
          content: '',
          timestamp: null,
        },
      },
    ];

    const displayEntries = buildDisplayEntries(entries, {
      collapseAiMessagesByDefault: true,
    });

    expect(displayEntries).toHaveLength(0);
  });

  it('keeps a pending loading entry visible instead of folding it as process output', () => {
    const entries: PatchTypeWithKey[] = [
      {
        type: 'NORMALIZED_ENTRY',
        patchKey: 'proc-1:user',
        executionProcessId: 'proc-1',
        content: {
          entry_type: { type: 'user_message' },
          content: 'hello',
          timestamp: null,
        },
      },
      {
        type: 'NORMALIZED_ENTRY',
        patchKey: 'proc-1:loading',
        executionProcessId: 'proc-1',
        content: {
          entry_type: { type: 'loading' },
          content: '',
          timestamp: null,
        },
      },
    ];

    const displayEntries = buildDisplayEntries(entries, {
      collapseAiMessagesByDefault: true,
    });

    expect(displayEntries).toHaveLength(2);
    expect(displayEntries[0]).toMatchObject({
      type: 'NORMALIZED_ENTRY',
      content: { entry_type: { type: 'user_message' } },
    });
    expect(displayEntries[1]).toMatchObject({
      type: 'NORMALIZED_ENTRY',
      content: { entry_type: { type: 'loading' } },
    });
  });
});
