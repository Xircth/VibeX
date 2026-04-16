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
import { Command as CommandIcon, X } from 'lucide-react';

export interface DollarCommandData {
  commandName: string;
  description?: string;
}

type SerializedDollarCommandNode = Spread<
  {
    commandName: string;
    description?: string;
  },
  SerializedLexicalNode
>;

export class DollarCommandNode extends DecoratorNode<JSX.Element> {
  __commandName: string;
  __description: string;

  static getType(): string {
    return 'dollar-command';
  }

  static clone(node: DollarCommandNode): DollarCommandNode {
    return new DollarCommandNode(
      node.__commandName,
      node.__description,
      node.__key
    );
  }

  constructor(commandName: string, description?: string, key?: NodeKey) {
    super(key);
    this.__commandName = commandName;
    this.__description = description ?? '';
  }

  createDOM(): HTMLElement {
    const el = document.createElement('span');
    el.style.display = 'inline';
    return el;
  }

  updateDOM(): false {
    return false;
  }

  static importJSON(json: SerializedDollarCommandNode): DollarCommandNode {
    return new DollarCommandNode(json.commandName, json.description);
  }

  exportJSON(): SerializedDollarCommandNode {
    return {
      type: 'dollar-command',
      version: 1,
      commandName: this.__commandName,
      description: this.__description || undefined,
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
      <DollarCommandChip
        commandName={this.__commandName}
        description={this.__description}
        nodeKey={this.__key}
      />
    );
  }
}

export function $createDollarCommandNode(
  data: DollarCommandData
): DollarCommandNode {
  return new DollarCommandNode(data.commandName, data.description);
}

export function $isDollarCommandNode(
  node: LexicalNode | null | undefined
): node is DollarCommandNode {
  return node instanceof DollarCommandNode;
}

export const DOLLAR_COMMAND_TRANSFORMER: TextMatchTransformer = {
  dependencies: [DollarCommandNode],
  export: (node) => {
    if ($isDollarCommandNode(node)) {
      return `$${node.__commandName}`;
    }
    return null;
  },
  importRegExp: /(?!)/,
  regExp: /(?!)$/,
  replace: () => {},
  trigger: '',
  type: 'text-match',
};

function DollarCommandChip({
  commandName,
  description,
  nodeKey,
}: {
  commandName: string;
  description: string;
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
        if ($isDollarCommandNode(node)) {
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
      editor.update(() => {
        const node = $getNodeByKey(nodeKey);
        if ($isDollarCommandNode(node)) {
          const textNode = $createTextNode(`$${commandName}`);
          node.replace(textNode);
          const len = textNode.getTextContentSize();
          textNode.select(len, len);
        }
      });
    },
    [editor, nodeKey, commandName, isEditable]
  );

  return (
    <span
      className="relative mx-0.5 inline-flex cursor-default select-none items-center gap-1 rounded-md bg-emerald-500/15 px-1.5 py-0.5 align-baseline text-sm text-emerald-400"
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
      onDoubleClick={handleDoubleClick}
    >
      <CommandIcon className="h-3 w-3 shrink-0" />
      <span className="font-mono font-medium">${commandName}</span>
      {isEditable && (
        <button
          type="button"
          className="ml-0.5 rounded-sm p-0.5 transition-colors hover:bg-emerald-500/30"
          onClick={handleRemove}
          tabIndex={-1}
          aria-label={`Remove command $${commandName}`}
        >
          <X className="h-2.5 w-2.5" />
        </button>
      )}
      {showTooltip && description && (
        <div className="pointer-events-none absolute bottom-full left-0 z-50 mb-1.5 max-w-[300px] whitespace-pre-wrap rounded-md border border-border bg-popover p-2 text-xs text-foreground shadow-lg">
          {description}
        </div>
      )}
    </span>
  );
}
