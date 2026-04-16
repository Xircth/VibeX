import { useState, useCallback } from 'react';
import {
  DecoratorNode,
  LexicalNode,
  NodeKey,
  SerializedLexicalNode,
  Spread,
  $getNodeByKey,
  $createTextNode,
} from 'lexical';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import type { TextMatchTransformer } from '@lexical/markdown';
import { Tag as TagIcon, X } from 'lucide-react';

// ====== Data Types ======

export interface TagReferenceData {
  tagId: string;
  tagName: string;
  content: string;
}

type SerializedTagReferenceNode = Spread<
  {
    tagId: string;
    tagName: string;
    content: string;
  },
  SerializedLexicalNode
>;

// ====== Node Class ======

export class TagReferenceNode extends DecoratorNode<JSX.Element> {
  __tagId: string;
  __tagName: string;
  __content: string;

  static getType(): string {
    return 'tag-reference';
  }

  static clone(node: TagReferenceNode): TagReferenceNode {
    return new TagReferenceNode(
      node.__tagId,
      node.__tagName,
      node.__content,
      node.__key
    );
  }

  constructor(tagId: string, tagName: string, content: string, key?: NodeKey) {
    super(key);
    this.__tagId = tagId;
    this.__tagName = tagName;
    this.__content = content;
  }

  createDOM(): HTMLElement {
    const el = document.createElement('span');
    el.style.display = 'inline';
    return el;
  }

  updateDOM(): false {
    return false;
  }

  static importJSON(json: SerializedTagReferenceNode): TagReferenceNode {
    return new TagReferenceNode(json.tagId, json.tagName, json.content);
  }

  exportJSON(): SerializedTagReferenceNode {
    return {
      type: 'tag-reference',
      version: 1,
      tagId: this.__tagId,
      tagName: this.__tagName,
      content: this.__content,
    };
  }

  isInline(): boolean {
    return true;
  }

  isKeyboardSelectable(): boolean {
    return true;
  }

  decorate(): JSX.Element {
    return (
      <TagReferenceChip
        tagId={this.__tagId}
        tagName={this.__tagName}
        content={this.__content}
        nodeKey={this.__key}
      />
    );
  }
}

// ====== Factory & Guards ======

export function $createTagReferenceNode(
  data: TagReferenceData
): TagReferenceNode {
  return new TagReferenceNode(data.tagId, data.tagName, data.content);
}

export function $isTagReferenceNode(
  node: LexicalNode | null | undefined
): node is TagReferenceNode {
  return node instanceof TagReferenceNode;
}

// ====== Transformer (export-only) ======
// Exports tag content as markdown so AI agents can read the full content.
// Import uses a pattern that never matches — tags are inserted only via typeahead.

export const TAG_REFERENCE_TRANSFORMER: TextMatchTransformer = {
  dependencies: [TagReferenceNode],
  export: (node) => {
    if ($isTagReferenceNode(node)) {
      // Output the tag content for AI consumption, prefixed with tag name for context
      const content = node.__content;
      if (content) {
        return `[#${node.__tagName}]:\n${content}`;
      }
      return `#${node.__tagName}`;
    }
    return null;
  },
  importRegExp: /(?!)/, // Never match — tags are created via typeahead only
  regExp: /(?!)$/, // Never match
  replace: () => {},
  trigger: '',
  type: 'text-match',
};

// ====== React Component ======

function TagReferenceChip({
  tagName,
  content,
  nodeKey,
}: {
  tagId: string;
  tagName: string;
  content: string;
  nodeKey: NodeKey;
}) {
  const [editor] = useLexicalComposerContext();
  const [showTooltip, setShowTooltip] = useState(false);
  const isEditable = editor.isEditable();

  const handleRemove = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      editor.update(() => {
        const node = $getNodeByKey(nodeKey);
        if ($isTagReferenceNode(node)) {
          node.remove();
        }
      });
    },
    [editor, nodeKey]
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (!isEditable) return;
      e.preventDefault();
      e.stopPropagation();
      // Convert back to plain text on double-click
      editor.update(() => {
        const node = $getNodeByKey(nodeKey);
        if ($isTagReferenceNode(node)) {
          const textNode = $createTextNode(node.__content || `#${tagName}`);
          node.replace(textNode);
          const len = textNode.getTextContentSize();
          textNode.select(len, len);
        }
      });
    },
    [editor, nodeKey, tagName, isEditable]
  );

  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 mx-0.5 rounded-md bg-blue-500/15 text-blue-400 text-sm cursor-default select-none align-baseline relative"
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
      onDoubleClick={handleDoubleClick}
    >
      <TagIcon className="h-3 w-3 shrink-0" />
      <span className="font-medium">#{tagName}</span>
      {isEditable && (
        <button
          type="button"
          className="ml-0.5 rounded-sm hover:bg-blue-500/30 p-0.5 transition-colors"
          onClick={handleRemove}
          tabIndex={-1}
          aria-label={`Remove tag #${tagName}`}
        >
          <X className="h-2.5 w-2.5" />
        </button>
      )}
      {showTooltip && content && (
        <div className="absolute bottom-full left-0 mb-1.5 z-50 max-w-[400px] max-h-[200px] overflow-y-auto p-2 rounded-md bg-popover border border-border text-xs text-foreground shadow-lg whitespace-pre-wrap pointer-events-none">
          {content}
        </div>
      )}
    </span>
  );
}
