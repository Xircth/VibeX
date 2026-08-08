import { useCallback } from 'react';
import type { JSX } from 'react';
import {
  $createTextNode,
  $getNodeByKey,
  DecoratorNode,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import type { TextMatchTransformer } from '@lexical/markdown';
import { TagReferenceChip } from '@/components/ui/tag-reference-chip';
import {
  parseTagReferenceMarker,
  serializeTagReferenceMarker,
} from '@/lib/tagReferenceMarkers';

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
    const element = document.createElement('span');
    element.style.display = 'inline';
    return element;
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
      <EditableTagReferenceChip
        tagName={this.__tagName}
        content={this.__content}
        nodeKey={this.__key}
      />
    );
  }
}

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

export const TAG_REFERENCE_TRANSFORMER: TextMatchTransformer = {
  dependencies: [TagReferenceNode],
  export: (node) => {
    if (!$isTagReferenceNode(node)) {
      return null;
    }

    return serializeTagReferenceMarker({
      tagId: node.__tagId,
      tagName: node.__tagName,
      content: node.__content,
    });
  },
  importRegExp: /\[\[tag:[^[\]]+\]\]/,
  regExp: /(?!)$/,
  replace: (textNode, match) => {
    const payload = parseTagReferenceMarker(match[0]);
    if (!payload) {
      return;
    }

    textNode.replace($createTagReferenceNode(payload));
  },
  trigger: '',
  type: 'text-match',
};

function EditableTagReferenceChip({
  tagName,
  content,
  nodeKey,
}: {
  tagName: string;
  content: string;
  nodeKey: NodeKey;
}) {
  const [editor] = useLexicalComposerContext();
  const isEditable = editor.isEditable();

  const handleRemove = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
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
    (event: React.MouseEvent) => {
      if (!isEditable) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      editor.update(() => {
        const node = $getNodeByKey(nodeKey);
        if ($isTagReferenceNode(node)) {
          const textNode = $createTextNode(`#${tagName}`);
          node.replace(textNode);
          const textLength = textNode.getTextContentSize();
          textNode.select(textLength, textLength);
        }
      });
    },
    [editor, isEditable, nodeKey, tagName]
  );

  return (
    <TagReferenceChip
      tagName={tagName}
      content={content}
      isEditable={isEditable}
      onRemove={handleRemove}
      onDoubleClick={handleDoubleClick}
    />
  );
}
