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

// ====== Data Types ======

export interface SlashCommandData {
  commandName: string;
  description?: string;
  displayName?: string;
}

type SerializedSlashCommandNode = Spread<
  {
    commandName: string;
    description?: string;
    displayName?: string;
  },
  SerializedLexicalNode
>;

// ====== Node Class ======

export class SlashCommandNode extends DecoratorNode<JSX.Element> {
  __commandName: string;
  __description: string;
  __displayName: string;

  static getType(): string {
    return 'slash-command';
  }

  static clone(node: SlashCommandNode): SlashCommandNode {
    return new SlashCommandNode(
      node.__commandName,
      node.__description,
      node.__displayName,
      node.__key
    );
  }

  constructor(
    commandName: string,
    description?: string,
    displayName?: string,
    key?: NodeKey
  ) {
    super(key);
    this.__commandName = commandName;
    this.__description = description ?? '';
    this.__displayName = displayName ?? '';
  }

  createDOM(): HTMLElement {
    const el = document.createElement('span');
    el.style.display = 'inline';
    return el;
  }

  updateDOM(): false {
    return false;
  }

  static importJSON(json: SerializedSlashCommandNode): SlashCommandNode {
    return new SlashCommandNode(
      json.commandName,
      json.description,
      json.displayName
    );
  }

  exportJSON(): SerializedSlashCommandNode {
    return {
      type: 'slash-command',
      version: 1,
      commandName: this.__commandName,
      description: this.__description || undefined,
      displayName:
        this.__displayName && this.__displayName !== this.__commandName
          ? this.__displayName
          : undefined,
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
      <SlashCommandChip
        commandName={this.__commandName}
        description={this.__description}
        displayName={this.__displayName}
        nodeKey={this.__key}
      />
    );
  }
}

// ====== Factory & Guards ======

export function $createSlashCommandNode(
  data: SlashCommandData
): SlashCommandNode {
  return new SlashCommandNode(
    data.commandName,
    data.description,
    data.displayName
  );
}

export function $isSlashCommandNode(
  node: LexicalNode | null | undefined
): node is SlashCommandNode {
  return node instanceof SlashCommandNode;
}

// ====== Transformer (export-only) ======
// Exports as /commandName in markdown so the command is sent to the AI agent.

export const SLASH_COMMAND_TRANSFORMER: TextMatchTransformer = {
  dependencies: [SlashCommandNode],
  export: (node) => {
    if ($isSlashCommandNode(node)) {
      return `/${node.__commandName}`;
    }
    return null;
  },
  importRegExp: /(?!)/, // Never match — commands are created via typeahead only
  regExp: /(^|[\s(])\/([A-Za-z][A-Za-z0-9:_-]*)$/,
  replace: (textNode, match) => {
    const prefix = match[1] ?? '';
    const commandName = match[2];
    if (!commandName) return;

    const commandNode = $createSlashCommandNode({ commandName });
    textNode.replace(commandNode);
    if (prefix) {
      commandNode.insertBefore($createTextNode(prefix));
    }
  },
  trigger: '',
  type: 'text-match',
};

export const SLASH_COMMAND_DISPLAY_TRANSFORMER: TextMatchTransformer = {
  ...SLASH_COMMAND_TRANSFORMER,
  importRegExp: /(^|[\s(])\/([A-Za-z][A-Za-z0-9:_-]*)/,
};

// ====== React Component ======

function SlashCommandChip({
  commandName,
  description,
  displayName,
  nodeKey,
}: {
  commandName: string;
  description: string;
  displayName: string;
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
        if ($isSlashCommandNode(node)) {
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
        if ($isSlashCommandNode(node)) {
          const textNode = $createTextNode(`/${commandName}`);
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
      className="inline-flex items-center gap-1 px-1.5 py-0.5 mx-0.5 rounded-md bg-purple-500/15 text-purple-400 text-sm cursor-default select-none align-baseline relative"
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
      onDoubleClick={handleDoubleClick}
    >
      <CommandIcon className="h-3 w-3 shrink-0" />
      <span className="font-medium">{displayName || `/${commandName}`}</span>
      {isEditable && (
        <button
          type="button"
          className="ml-0.5 rounded-sm hover:bg-purple-500/30 p-0.5 transition-colors"
          onClick={handleRemove}
          tabIndex={-1}
          aria-label={`Remove command /${commandName}`}
        >
          <X className="h-2.5 w-2.5" />
        </button>
      )}
      {showTooltip && description && (
        <div className="absolute bottom-full left-0 mb-1.5 z-50 max-w-[300px] p-2 rounded-md bg-popover border border-border text-xs text-foreground shadow-lg whitespace-pre-wrap pointer-events-none">
          {description}
        </div>
      )}
    </span>
  );
}
