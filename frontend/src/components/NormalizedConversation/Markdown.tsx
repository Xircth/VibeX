import {
  memo,
  useMemo,
  useCallback,
  type ReactNode,
} from 'react';
import { useTemporaryFlag } from '@/hooks/useTemporaryFlag';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';
import { highlightLine } from '@/utils/syntax';
import { TagReferenceChip } from '@/components/ui/tag-reference-chip';
import {
  parseTagReferenceHref,
  replaceTagReferenceMarkersWithMarkdownLinks,
  stripTagReferenceAppendix,
} from '@/lib/tagReferenceMarkers';

type MarkdownProps = {
  value: string;
  className?: string;
};

type CodeBlockProps = {
  className?: string;
  value: string;
};

type PreProps = {
  node?: {
    tagName?: string;
    children?: Array<{
      tagName?: string;
      properties?: { className?: string[] | string };
      children?: Array<{ value?: string }>;
    }>;
  };
  children?: ReactNode;
};

function extractLanguageTag(className?: string): string | null {
  if (!className) return null;
  const match = className.match(/language-([\w-]+)/i);
  return match ? match[1] : null;
}

function extractCodeFromPre(node?: PreProps['node']): {
  className: string | undefined;
  value: string;
} {
  const codeNode = node?.children?.find((child) => child.tagName === 'code');
  const rawClass = codeNode?.properties?.className;
  const normalizedClassName = Array.isArray(rawClass)
    ? rawClass.join(' ')
    : rawClass;
  const value =
    codeNode?.children?.map((child) => child.value ?? '').join('') ?? '';
  return {
    className: normalizedClassName,
    value: value.replace(/\n$/, ''),
  };
}

function flattenNodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(flattenNodeText).join('');
  if (
    node &&
    typeof node === 'object' &&
    'props' in node &&
    node.props &&
    typeof node.props === 'object' &&
    'children' in node.props
  ) {
    return flattenNodeText(node.props.children as ReactNode);
  }
  return '';
}

function CodeBlock({ className, value }: CodeBlockProps) {
  const [copied, triggerCopied] = useTemporaryFlag(1200);

  const languageTag = extractLanguageTag(className);
  const languageLabel = languageTag ?? 'Code';
  const highlightedHtml = useMemo(
    () => highlightLine(value, languageTag),
    [value, languageTag]
  );

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      triggerCopied();
    } catch {
      // Clipboard access is best-effort only.
    }
  }, [triggerCopied, value]);

  return (
    <div className="conv-md-codeblock">
      <div className="conv-md-codeblock-header">
        <span className="conv-md-codeblock-language">{languageLabel}</span>
        <button
          type="button"
          className={`conv-md-codeblock-copy${copied ? ' is-copied' : ''}`}
          onClick={handleCopy}
          title={copied ? '已复制' : '复制'}
          aria-label={copied ? '已复制' : '复制'}
        >
          {copied ? (
            <Check className="h-3 w-3" />
          ) : (
            <Copy className="h-3 w-3" />
          )}
        </button>
      </div>
      <pre>
        <code
          className={className}
          dangerouslySetInnerHTML={{ __html: highlightedHtml }}
        />
      </pre>
    </div>
  );
}

function PreBlock({ node, children }: PreProps) {
  const { className, value } = extractCodeFromPre(node);

  if (!className && !value && children) {
    return <pre>{children}</pre>;
  }

  const languageTag = extractLanguageTag(className);
  const isSingleLine = !value.includes('\n');

  if (isSingleLine) {
    const html = highlightLine(value, languageTag);
    return (
      <pre className="conv-md-codeblock-single">
        <code
          className={className}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </pre>
    );
  }

  return <CodeBlock className={className} value={value} />;
}

function arePropsEqual(prev: MarkdownProps, next: MarkdownProps) {
  return prev.value === next.value && prev.className === next.className;
}

export const Markdown = memo(function Markdown({
  value,
  className,
}: MarkdownProps) {
  const normalizedValue = useMemo(
    () => replaceTagReferenceMarkersWithMarkdownLinks(stripTagReferenceAppendix(value)),
    [value]
  );

  const components = useMemo<Components>(
    () => ({
      pre: ({ node, children }) => (
        <PreBlock node={node as PreProps['node']}>{children}</PreBlock>
      ),
      code: ({ className: codeClass, children }) => {
        const text = flattenNodeText(children).trim();
        return (
          <code className={codeClass ?? undefined}>{text || children}</code>
        );
      },
      a: ({ href, children }) => {
        const tagReferencePayload = href ? parseTagReferenceHref(href) : null;
        if (tagReferencePayload) {
          return (
            <TagReferenceChip
              tagName={tagReferencePayload.tagName}
              content={tagReferencePayload.content}
            />
          );
        }

        const isExternal =
          (href?.startsWith('http://') || href?.startsWith('https://')) ??
          false;

        const handleClick = async (
          event: React.MouseEvent<HTMLAnchorElement>
        ) => {
          if (!isExternal || !href) return;
          event.preventDefault();

          try {
            const { open } = await import('@tauri-apps/plugin-shell');
            await open(href);
          } catch {
            window.open(href, '_blank', 'noopener,noreferrer');
          }
        };

        return (
          <a href={href} onClick={handleClick} rel="noopener noreferrer">
            {children}
          </a>
        );
      },
    }),
    []
  );

  const remarkPlugins = useMemo(() => [remarkGfm], []);

  return (
    <div className={`conv-markdown${className ? ` ${className}` : ''}`}>
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
        {normalizedValue}
      </ReactMarkdown>
    </div>
  );
}, arePropsEqual);

export default Markdown;
