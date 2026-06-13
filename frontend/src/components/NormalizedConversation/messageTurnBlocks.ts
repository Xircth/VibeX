import type { ContentBlock, ImageData } from 'shared/types';

/**
 * Render planning for a unified-timeline `MessageTurn` (codeg-aligned model).
 *
 * Turns a turn's `ContentBlock[]` into a flat, render-ready item list: a
 * `tool_use` block is paired with its matching `tool_result` (by `tool_use_id`)
 * into one tool item, while an unmatched `tool_result` renders standalone. Text,
 * thinking, and image blocks pass through in order. Kept pure so the pairing
 * logic is unit-testable without rendering. VibeX-authored.
 */

export type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>;
export type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>;

export type TurnRenderItem =
  | { kind: 'markdown'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'image'; data: string; mimeType: string; uri: string | null }
  | {
      kind: 'image_generation';
      image: ImageData | null;
      revisedPrompt: string | null;
    }
  | { kind: 'tool'; use: ToolUseBlock | null; result: ToolResultBlock | null };

export function planTurnBlocks(blocks: ContentBlock[]): TurnRenderItem[] {
  const toolUseIds = new Set<string>();
  const resultByToolId = new Map<string, ToolResultBlock>();
  for (const block of blocks) {
    if (block.type === 'tool_use' && block.tool_use_id) {
      toolUseIds.add(block.tool_use_id);
    } else if (block.type === 'tool_result' && block.tool_use_id) {
      resultByToolId.set(block.tool_use_id, block);
    }
  }

  const items: TurnRenderItem[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        items.push({ kind: 'markdown', text: block.text });
        break;
      case 'thinking':
        items.push({ kind: 'thinking', text: block.text });
        break;
      case 'image':
        items.push({
          kind: 'image',
          data: block.data,
          mimeType: block.mime_type,
          uri: block.uri ?? null,
        });
        break;
      case 'image_generation':
        items.push({
          kind: 'image_generation',
          image: block.image ?? null,
          revisedPrompt: block.revised_prompt ?? null,
        });
        break;
      case 'tool_use':
        items.push({
          kind: 'tool',
          use: block,
          result: block.tool_use_id
            ? resultByToolId.get(block.tool_use_id) ?? null
            : null,
        });
        break;
      case 'tool_result':
        // Consumed by its tool_use above; render standalone only when orphaned.
        if (!(block.tool_use_id != null && toolUseIds.has(block.tool_use_id))) {
          items.push({ kind: 'tool', use: null, result: block });
        }
        break;
    }
  }
  return items;
}
