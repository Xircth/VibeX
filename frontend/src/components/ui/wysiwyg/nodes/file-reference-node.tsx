import { useCallback, useState } from 'react';
import type { JSX } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import type { TextMatchTransformer } from '@lexical/markdown';
import {
  $createTextNode,
  $getNodeByKey,
  DecoratorNode,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import { AtSign, File, Folder, X } from 'lucide-react';
import type { FileReferenceKind } from '@/utils/fileReferences';

export interface FileReferenceData {
  fileName: string;
  relativePath: string;
  kind: FileReferenceKind;
}

type SerializedFileReferenceNode = Spread<
  {
    fileName: string;
    relativePath: string;
    kind: FileReferenceKind;
  },
  SerializedLexicalNode
>;

export class FileReferenceNode extends DecoratorNode<JSX.Element> {
  __fileName: string;
  __relativePath: string;
  __kind: FileReferenceKind;

  static getType(): string {
    return 'file-reference';
  }

  static clone(node: FileReferenceNode): FileReferenceNode {
    return new FileReferenceNode(
      node.__fileName,
      node.__relativePath,
      node.__kind,
      node.__key
    );
  }

  constructor(
    fileName: string,
    relativePath: string,
    kind: FileReferenceKind,
    key?: NodeKey
  ) {
    super(key);
    this.__fileName = fileName;
    this.__relativePath = relativePath;
    this.__kind = kind;
  }

  createDOM(): HTMLElement {
    const el = document.createElement('span');
    el.style.display = 'inline';
    return el;
  }

  updateDOM(): false {
    return false;
  }

  static importJSON(json: SerializedFileReferenceNode): FileReferenceNode {
    return new FileReferenceNode(json.fileName, json.relativePath, json.kind);
  }

  exportJSON(): SerializedFileReferenceNode {
    return {
      type: 'file-reference',
      version: 1,
      fileName: this.__fileName,
      relativePath: this.__relativePath,
      kind: this.__kind,
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
      <FileReferenceChip
        fileName={this.__fileName}
        relativePath={this.__relativePath}
        kind={this.__kind}
        nodeKey={this.__key}
      />
    );
  }
}

export function $createFileReferenceNode(
  data: FileReferenceData
): FileReferenceNode {
  return new FileReferenceNode(data.fileName, data.relativePath, data.kind);
}

export function $isFileReferenceNode(
  node: LexicalNode | null | undefined
): node is FileReferenceNode {
  return node instanceof FileReferenceNode;
}

export const FILE_REFERENCE_TRANSFORMER: TextMatchTransformer = {
  dependencies: [FileReferenceNode],
  export: (node) => {
    if ($isFileReferenceNode(node)) {
      return `@${node.__relativePath}`;
    }

    return null;
  },
  importRegExp: /(^|[\s(])@([^\s#@]+)/,
  regExp: /(^|[\s(])@([^\s#@]+)$/,
  replace: (textNode, match) => {
    const prefix = match[1] ?? '';
    const relativePath = match[2];
    if (!relativePath) return;

    const fileName =
      relativePath.split(/[\\/]/).filter(Boolean).pop() ?? relativePath;
    const node = $createFileReferenceNode({
      fileName,
      relativePath,
      kind:
        relativePath.endsWith('/') || relativePath.endsWith('\\')
          ? 'directory'
          : 'file',
    });
    textNode.replace(node);
    if (prefix) {
      node.insertBefore($createTextNode(prefix));
    }
  },
  trigger: '',
  type: 'text-match',
};

function FileReferenceChip({
  fileName,
  relativePath,
  kind,
  nodeKey,
}: {
  fileName: string;
  relativePath: string;
  kind: FileReferenceKind;
  nodeKey: NodeKey;
}) {
  const [editor] = useLexicalComposerContext();
  const [showTooltip, setShowTooltip] = useState(false);
  const isEditable = editor.isEditable();
  const ItemIcon = kind === 'directory' ? Folder : File;

  const handleRemove = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      editor.update(() => {
        const node = $getNodeByKey(nodeKey);
        if ($isFileReferenceNode(node)) {
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
        if ($isFileReferenceNode(node)) {
          const textNode = $createTextNode(relativePath);
          node.replace(textNode);
          const textLength = textNode.getTextContentSize();
          textNode.select(textLength, textLength);
        }
      });
    },
    [editor, isEditable, nodeKey, relativePath]
  );

  return (
    <span
      className="relative mx-0.5 inline-flex cursor-default select-none items-center gap-1 rounded-md border border-[hsl(var(--info)/0.25)] bg-[hsl(var(--info)/0.1)] px-1.5 py-0.5 align-baseline text-sm text-[hsl(var(--info))]"
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
      onDoubleClick={handleDoubleClick}
    >
      <AtSign className="h-3 w-3 shrink-0" />
      <ItemIcon className="h-3 w-3 shrink-0 opacity-80" />
      <span className="max-w-[220px] truncate font-medium">{fileName}</span>
      {isEditable ? (
        <button
          type="button"
          className="ml-0.5 rounded-sm p-0.5 transition-colors hover:bg-[hsl(var(--info)/0.18)]"
          onClick={handleRemove}
          tabIndex={-1}
          aria-label={`Remove file reference ${relativePath}`}
        >
          <X className="h-2.5 w-2.5" />
        </button>
      ) : null}
      {showTooltip ? (
        <div className="pointer-events-none absolute bottom-full left-0 z-50 mb-1.5 max-w-[360px] rounded-md border border-border bg-popover px-2 py-1.5 text-xs text-foreground shadow-lg">
          {relativePath}
        </div>
      ) : null}
    </span>
  );
}
