import { useCallback } from 'react';
import type { JSX } from 'react';
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
import { MousePointerClick, X } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

// ====== Data Types ======

export interface ClickedElementData {
  entryId: string;
  componentName: string;
  filePath: string;
  htmlPreview?: string;
  componentChain: string[];
  fullMarkdown: string;
}

type SerializedClickedElementNode = Spread<
  {
    entryId: string;
    componentName: string;
    filePath: string;
    htmlPreview: string;
    componentChain: string[];
    fullMarkdown: string;
  },
  SerializedLexicalNode
>;

// ====== Node Class ======

export class ClickedElementNode extends DecoratorNode<JSX.Element> {
  __entryId: string;
  __componentName: string;
  __filePath: string;
  __htmlPreview: string;
  __componentChain: string[];
  __fullMarkdown: string;

  static getType(): string {
    return 'clicked-element';
  }

  static clone(node: ClickedElementNode): ClickedElementNode {
    return new ClickedElementNode(
      node.__entryId,
      node.__componentName,
      node.__filePath,
      node.__htmlPreview,
      node.__componentChain,
      node.__fullMarkdown,
      node.__key
    );
  }

  constructor(
    entryId: string,
    componentName: string,
    filePath: string,
    htmlPreview: string,
    componentChain: string[],
    fullMarkdown: string,
    key?: NodeKey
  ) {
    super(key);
    this.__entryId = entryId;
    this.__componentName = componentName;
    this.__filePath = filePath;
    this.__htmlPreview = htmlPreview;
    this.__componentChain = componentChain;
    this.__fullMarkdown = fullMarkdown;
  }

  createDOM(): HTMLElement {
    const el = document.createElement('span');
    el.style.display = 'inline';
    return el;
  }

  updateDOM(): false {
    return false;
  }

  static importJSON(json: SerializedClickedElementNode): ClickedElementNode {
    return new ClickedElementNode(
      json.entryId,
      json.componentName,
      json.filePath,
      json.htmlPreview,
      json.componentChain,
      json.fullMarkdown
    );
  }

  exportJSON(): SerializedClickedElementNode {
    return {
      type: 'clicked-element',
      version: 1,
      entryId: this.__entryId,
      componentName: this.__componentName,
      filePath: this.__filePath,
      htmlPreview: this.__htmlPreview,
      componentChain: this.__componentChain,
      fullMarkdown: this.__fullMarkdown,
    };
  }

  isInline(): boolean {
    return true;
  }

  isKeyboardSelectable(): boolean {
    return true;
  }

  getTextContent(): string {
    // Fallback for clipboard, selection, and any export path that bypasses
    // the TextMatchTransformer (e.g., DecoratorNode default in $convertToMarkdownString).
    return this.__fullMarkdown;
  }

  decorate(): JSX.Element {
    return (
      <ClickedElementChip
        componentName={this.__componentName}
        filePath={this.__filePath}
        htmlPreview={this.__htmlPreview}
        componentChain={this.__componentChain}
        nodeKey={this.__key}
      />
    );
  }
}

// ====== Factory & Guards ======

export function $createClickedElementNode(
  data: ClickedElementData
): ClickedElementNode {
  return new ClickedElementNode(
    data.entryId,
    data.componentName,
    data.filePath,
    data.htmlPreview ?? '',
    data.componentChain,
    data.fullMarkdown
  );
}

export function $isClickedElementNode(
  node: LexicalNode | null | undefined
): node is ClickedElementNode {
  return node instanceof ClickedElementNode;
}

// ====== Transformer (export-only) ======

export const CLICKED_ELEMENT_TRANSFORMER: TextMatchTransformer = {
  dependencies: [ClickedElementNode],
  export: (node) => {
    if ($isClickedElementNode(node)) {
      return node.__fullMarkdown;
    }
    return null;
  },
  importRegExp: /(?!)/,
  regExp: /(?!)$/,
  replace: () => {},
  trigger: '',
  type: 'text-match',
};

// ====== React Component ======

function ClickedElementChip({
  componentName,
  filePath,
  htmlPreview,
  componentChain,
  nodeKey,
}: {
  componentName: string;
  filePath: string;
  htmlPreview: string;
  componentChain: string[];
  nodeKey: NodeKey;
}) {
  const [editor] = useLexicalComposerContext();
  const isEditable = editor.isEditable();

  const handleRemove = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      editor.update(() => {
        const node = $getNodeByKey(nodeKey);
        if ($isClickedElementNode(node)) {
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
        if ($isClickedElementNode(node)) {
          const textNode = $createTextNode(`> ${componentName}`);
          node.replace(textNode);
          const len = textNode.getTextContentSize();
          textNode.select(len, len);
        }
      });
    },
    [editor, nodeKey, componentName, isEditable]
  );

  const tooltipText = buildTooltipContent(
    filePath,
    htmlPreview,
    componentChain
  );

  const chip = (
    <span
      className="mx-0.5 inline-flex cursor-default select-none items-center gap-1 rounded-md bg-[hsl(var(--success)/0.14)] px-1.5 py-0.5 align-baseline text-sm text-[hsl(var(--success))]"
      onDoubleClick={handleDoubleClick}
    >
      <MousePointerClick className="h-3 w-3 shrink-0" />
      <span className="font-medium">&gt; {componentName}</span>
      {isEditable && (
        <button
          type="button"
          className="ml-0.5 rounded-sm p-0.5 transition-colors hover:bg-[hsl(var(--success)/0.22)]"
          onClick={handleRemove}
          tabIndex={-1}
          aria-label={`Remove element ${componentName}`}
        >
          <X className="h-2.5 w-2.5" />
        </button>
      )}
    </span>
  );

  if (!tooltipText) return chip;

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>{chip}</TooltipTrigger>
        <TooltipContent
          side="top"
          align="start"
          className="max-w-[400px] max-h-[240px] overflow-y-auto whitespace-pre-wrap text-xs"
        >
          {tooltipText}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function buildTooltipContent(
  filePath: string,
  htmlPreview: string,
  componentChain: string[]
): string {
  const parts: string[] = [];

  if (filePath) {
    parts.push(filePath);
  }

  if (htmlPreview) {
    parts.push(htmlPreview);
  }

  if (componentChain.length > 1) {
    parts.push(componentChain.join(' \u2190 ')); // ←
  }

  return parts.join('\n---\n');
}
