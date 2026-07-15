import type { ContentBlock, ImageData, PlanEntry } from 'shared/types';

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
  | { kind: 'plan'; entries: PlanEntry[] }
  | { kind: 'tool'; use: ToolUseBlock | null; result: ToolResultBlock | null };

type ToolRenderItem = Extract<TurnRenderItem, { kind: 'tool' }>;

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
  // Tool cards still awaiting a result, in document order. The persisted
  // projection (conversation_projection.rs) emits a ToolResult with a null
  // tool_use_id immediately after its ToolUse, so an id-less result attaches to
  // the most recent unmatched tool card — restoring its output and status dot
  // on reload. The live/stream path carries ids on both and pairs by id below.
  const pendingTools: ToolRenderItem[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        // Whitespace-only blocks (e.g. a trailing "\n\n" from the stream)
        // would render as an empty, selectable element that pads the turn.
        if (block.text.trim().length > 0) {
          items.push({ kind: 'markdown', text: block.text });
        }
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
      case 'plan':
        items.push({ kind: 'plan', entries: block.entries });
        break;
      case 'tool_use': {
        const result = block.tool_use_id
          ? (resultByToolId.get(block.tool_use_id) ?? null)
          : null;
        const item: ToolRenderItem = { kind: 'tool', use: block, result };
        items.push(item);
        if (!result) pendingTools.push(item);
        break;
      }
      case 'tool_result': {
        // Already attached to its tool_use by id at creation — consume silently.
        if (block.tool_use_id != null && toolUseIds.has(block.tool_use_id)) {
          break;
        }
        // Id-less result: attach to the most recent unmatched tool card; a truly
        // orphaned result (no preceding tool_use) still renders standalone.
        const owner = pendingTools.pop();
        if (owner) {
          // LIFO positional pairing is lossy when tool_uses interleave: if more
          // than one was still pending we may be misattributing the result.
          if (pendingTools.length > 0) {
            console.warn(
              '[conversation] pairing id-less tool_result by position with multiple ' +
                'pending tool calls; result may be misattributed'
            );
          }
          owner.result = block;
        } else {
          items.push({ kind: 'tool', use: null, result: block });
        }
        break;
      }
    }
  }
  return items;
}
