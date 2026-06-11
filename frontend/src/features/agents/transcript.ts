import type { NormalizedEntry } from 'shared/types';
import type { PatchTypeWithKey } from '@/hooks/useConversationHistory/types';
import type { AgentContentBlock, AgentEventEnvelope } from './types';

function textFromContentBlock(content: AgentContentBlock): string {
  switch (content.kind) {
    case 'text':
      return content.text;
    case 'image':
      return content.uri ? `[image] ${content.uri}` : '[image]';
    case 'resource':
      return content.title ? `[resource] ${content.title}: ${content.uri}` : `[resource] ${content.uri}`;
  }
}

function normalizedEntry(
  envelope: AgentEventEnvelope,
  entry_type: NormalizedEntry['entry_type'],
  content: string
): PatchTypeWithKey {
  return {
    type: 'NORMALIZED_ENTRY',
    content: {
      timestamp: envelope.created_at,
      entry_type,
      content,
    },
    patchKey: `agent:${envelope.sequence}`,
    executionProcessId: envelope.session_id ?? envelope.connection_id,
  };
}

function appendOrMergeTextEntry(
  entries: PatchTypeWithKey[],
  envelope: AgentEventEnvelope,
  entryType: Extract<
    NormalizedEntry['entry_type'],
    { type: 'assistant_message' } | { type: 'thinking' }
  >,
  content: string
) {
  const last = entries.at(-1);
  if (
    last?.type === 'NORMALIZED_ENTRY' &&
    last.executionProcessId === (envelope.session_id ?? envelope.connection_id) &&
    last.content.entry_type.type === entryType.type
  ) {
    entries[entries.length - 1] = {
      ...last,
      content: {
        ...last.content,
        timestamp: envelope.created_at,
        content: `${last.content.content}${content}`,
      },
      patchKey: `${last.patchKey}-${envelope.sequence}`,
    };
    return;
  }

  entries.push(normalizedEntry(envelope, entryType, content));
}

export function buildAgentTranscriptEntries(
  envelopes: AgentEventEnvelope[]
): PatchTypeWithKey[] {
  const entries: PatchTypeWithKey[] = [];

  for (const envelope of envelopes) {
    switch (envelope.event.kind) {
      case 'prompt_started':
        entries.push(
          normalizedEntry(
            envelope,
            { type: 'user_message' },
            envelope.event.snapshot.text_preview
          )
        );
        break;
      case 'message_chunk':
        appendOrMergeTextEntry(
          entries,
          envelope,
          { type: 'assistant_message' },
          textFromContentBlock(envelope.event.content)
        );
        break;
      case 'thought_chunk':
        appendOrMergeTextEntry(
          entries,
          envelope,
          { type: 'thinking' },
          textFromContentBlock(envelope.event.content)
        );
        break;
      case 'tool_call':
        entries.push(
          normalizedEntry(
            envelope,
            {
              type: 'tool_use',
              tool_name: envelope.event.tool_call.title,
              action_type: {
                action: 'other',
                description: envelope.event.tool_call.kind ?? envelope.event.tool_call.title,
              },
              status: { status: 'created' },
            },
            envelope.event.tool_call.title
          )
        );
        break;
      case 'tool_call_update':
        entries.push(
          normalizedEntry(
            envelope,
            {
              type: 'tool_use',
              tool_name: envelope.event.update.id,
              action_type: {
                action: 'tool',
                tool_name: envelope.event.update.id,
                arguments: null,
                result: envelope.event.update.content
                  ? { type: { type: 'markdown' }, value: envelope.event.update.content }
                  : null,
              },
              status:
                envelope.event.update.status === 'failed'
                  ? { status: 'failed' }
                  : { status: 'success' },
            },
            envelope.event.update.content ?? envelope.event.update.status ?? envelope.event.update.id
          )
        );
        break;
      case 'plan':
        entries.push(
          normalizedEntry(
            envelope,
            {
              type: 'tool_use',
              tool_name: 'plan',
              action_type: {
                action: 'plan_presentation',
                plan: envelope.event.plan.entries.join('\n'),
              },
              status: { status: 'success' },
            },
            envelope.event.plan.entries.join('\n')
          )
        );
        break;
      case 'usage':
        entries.push(
          normalizedEntry(
            envelope,
            {
              type: 'token_usage_info',
              total_tokens: envelope.event.usage.used,
              model_context_window: envelope.event.usage.limit ?? envelope.event.usage.used,
            },
            `${envelope.event.usage.used}`
          )
        );
        break;
      case 'permission_requested':
        entries.push(
          normalizedEntry(
            envelope,
            { type: 'system_message' },
            `Permission requested: ${envelope.event.request.title} (${envelope.event.request.options.length} option${envelope.event.request.options.length === 1 ? '' : 's'})`
          )
        );
        break;
      case 'terminal_created': {
        const command = [
          envelope.event.terminal.command,
          ...envelope.event.terminal.args,
        ].join(' ');
        entries.push(
          normalizedEntry(
            envelope,
            {
              type: 'tool_use',
              tool_name: 'terminal',
              action_type: {
                action: 'command_run',
                command,
                result: null,
              },
              status: { status: 'created' },
            },
            command
          )
        );
        break;
      }
      case 'terminal_output':
        entries.push(
          normalizedEntry(
            envelope,
            {
              type: 'tool_use',
              tool_name: 'terminal',
              action_type: {
                action: 'command_run',
                command: envelope.event.output.terminal_id,
                result: {
                  exit_status:
                    envelope.event.output.exit_status == null
                      ? null
                      : {
                          type: 'exit_code',
                          code: envelope.event.output.exit_status,
                        },
                  output: envelope.event.output.output,
                },
              },
              status:
                envelope.event.output.exit_status == null ||
                envelope.event.output.exit_status === 0
                  ? { status: 'success' }
                  : { status: 'failed' },
            },
            envelope.event.output.output
          )
        );
        break;
      case 'error':
        entries.push(
          normalizedEntry(
            envelope,
            { type: 'error_message', error_type: { type: 'other' } },
            envelope.event.error.message
          )
        );
        break;
      case 'raw_acp_diagnostic':
        entries.push(
          normalizedEntry(
            envelope,
            { type: 'system_message' },
            JSON.stringify(envelope.event.raw)
          )
        );
        break;
      case 'connection_status_changed':
      case 'session_created':
      case 'permission_responded':
      case 'prompt_finished':
        break;
    }
  }

  return entries;
}
