import {
  memo,
  useMemo,
  useCallback,
  type ReactNode,
  type MouseEvent,
} from 'react';
import { useTemporaryFlag } from '@/hooks/useTemporaryFlag';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { highlightLine } from '@/utils/syntax';
import { TagReferenceChip } from '@/components/ui/tag-reference-chip';
import { ImagePreviewDialog } from '@/components/dialogs/wysiwyg/ImagePreviewDialog';
import { useImageMetadata } from '@/hooks/useImageMetadata';
import { useOptionalPanelActionsContext } from '@/contexts/PanelActionsContext';
import {
  deriveRelativeFilePath,
  resolveFilePathFromRoot,
} from '@/utils/filePaths';
import {
  parseTagReferenceHref,
  replaceTagReferenceMarkersWithMarkdownLinks,
  stripTagReferenceAppendix,
} from '@/lib/tagReferenceMarkers';

type MarkdownProps = {
  value: string;
  className?: string;
  taskAttemptId?: string;
  taskId?: string;
  workspacePath?: string | null;
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

function isAbsoluteLocalPath(src: string): boolean {
  return (
    /^[a-zA-Z]:[\\/]/.test(src) ||
    src.startsWith('\\\\') ||
    src.startsWith('/') ||
    src.startsWith('file://')
  );
}

function isRenderableRemoteImage(src: string): boolean {
  return (
    src.startsWith('http://') ||
    src.startsWith('https://') ||
    src.startsWith('data:image/') ||
    src.startsWith('blob:')
  );
}

function isMarkdownImagePath(value: string): boolean {
  const candidate = trimFilePathCandidate(value);
  return /\.(png|jpe?g|gif|webp|svg|bmp|ico)(?:[?#].*)?$/i.test(candidate);
}

function resolveLocalMarkdownImageSrc(
  src: string,
  workspacePath?: string | null
): string | null {
  if (!src) return null;
  if (src.startsWith('file://')) {
    return convertFileSrc(src.replace(/^file:\/\//i, ''));
  }
  if (isAbsoluteLocalPath(src)) {
    return convertFileSrc(src);
  }
  if (!workspacePath || src.includes('://') || src.startsWith('#')) {
    return null;
  }

  const normalizedRelative = src.replace(/^\.?[\\/]/, '');
  const absolutePath = `${workspacePath.replace(/[\\/]+$/, '')}/${normalizedRelative}`;
  return convertFileSrc(absolutePath);
}

function parseHref(href: string): URL | null {
  try {
    return new URL(href, window.location.origin);
  } catch {
    return null;
  }
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1'
  );
}

function isInternalProjectRouteHref(href: string): boolean {
  const parsed = parseHref(href);
  if (!parsed) return href.startsWith('/local-projects');

  return (
    parsed.pathname.startsWith('/local-projects') &&
    (parsed.origin === window.location.origin || isLoopbackHost(parsed.hostname))
  );
}

function isSameAppOriginUrl(url: URL): boolean {
  return (
    url.origin === window.location.origin ||
    (url.protocol === window.location.protocol && isLoopbackHost(url.hostname))
  );
}

function filePathFromFileUrl(url: URL): string {
  const pathname = decodeURIComponent(url.pathname);
  return pathname.replace(/^\/([a-zA-Z]:[\\/])/, '$1');
}

function hrefToWorkspaceFileCandidate(
  href: string | undefined,
  workspacePath?: string | null
): string | null {
  if (!href) return null;
  const raw = trimFilePathCandidate(href);
  if (!raw || raw.startsWith('#')) return null;

  const parsed = parseHref(raw);
  if (parsed?.protocol === 'file:') {
    return filePathFromFileUrl(parsed);
  }

  if (parsed && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
    if (!isSameAppOriginUrl(parsed)) {
      return null;
    }
    if (parsed.pathname.startsWith('/local-projects')) {
      return null;
    }

    return decodeURIComponent(parsed.pathname).replace(/^\/+/, '');
  }

  if (raw.startsWith('/') && workspacePath && /^[a-zA-Z]:[\\/]/.test(workspacePath)) {
    return raw.replace(/^\/+/, '');
  }

  return raw;
}

function trimFilePathCandidate(value: string): string {
  return value
    .trim()
    .replace(/^['"`]+/, '')
    .replace(/['"`.,;]+$/, '')
    .replace(/[)\]}]+$/, '')
    .replace(/:(\d+)(?::\d+)?$/, '');
}

function looksLikeWorkspaceFilePath(value: string): boolean {
  const candidate = trimFilePathCandidate(value);
  if (!candidate || candidate.startsWith('#')) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(candidate) && !isAbsoluteLocalPath(candidate)) {
    return false;
  }
  if (candidate.startsWith('/local-projects')) return false;
  if (isAbsoluteLocalPath(candidate)) return true;

  return (
    /[\\/]/.test(candidate) &&
    /(?:^|[\\/])[^\\/]+\.[a-z0-9]{1,12}$/i.test(candidate)
  );
}

function resolveMarkdownFileLinkCandidate(
  href: string | undefined,
  childrenText: string,
  workspacePath?: string | null
): { filePath: string; displayPath: string } | null {
  const candidates = [
    childrenText,
    hrefToWorkspaceFileCandidate(href, workspacePath) ?? '',
    href ?? '',
  ]
    .map(trimFilePathCandidate)
    .filter(Boolean);

  for (const candidate of candidates) {
    if (!looksLikeWorkspaceFilePath(candidate)) continue;

    const filePath = resolveFilePathFromRoot(candidate, workspacePath);
    const displayPath =
      deriveRelativeFilePath(filePath, workspacePath) ?? candidate;
    return { filePath, displayPath };
  }

  return null;
}

function normalizeBareImageReferences(value: string): string {
  return value
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (
        !trimmed ||
        trimmed.startsWith('![') ||
        trimmed.startsWith('[') ||
        /\s/.test(trimmed) ||
        !isMarkdownImagePath(trimmed)
      ) {
        return line;
      }

      const label = trimmed.split(/[\\/]/).pop() ?? 'Image';
      return `${line.slice(0, line.indexOf(trimmed))}![${label}](${trimmed})`;
    })
    .join('\n');
}

function MarkdownImage({
  src,
  alt,
  title,
  taskAttemptId,
  taskId,
  workspacePath,
}: {
  src?: string;
  alt?: string;
  title?: string;
  taskAttemptId?: string;
  taskId?: string;
  workspacePath?: string | null;
}) {
  const normalizedSrc = src ?? '';
  const isVibeImage = normalizedSrc.startsWith('.vibe-images/');
  const { data: metadata, isLoading } = useImageMetadata(
    taskAttemptId,
    isVibeImage ? normalizedSrc : '',
    taskId
  );
  const imageUrl = isVibeImage
    ? metadata?.proxy_url
    : isRenderableRemoteImage(normalizedSrc)
      ? normalizedSrc
      : resolveLocalMarkdownImageSrc(normalizedSrc, workspacePath);
  const label = alt || title || metadata?.file_name || normalizedSrc || 'Image';

  const handleClick = useCallback(
    (event: MouseEvent) => {
      if (!imageUrl) return;
      event.preventDefault();
      ImagePreviewDialog.show({
        imageUrl,
        altText: label,
        fileName: metadata?.file_name ?? title ?? label,
        format: metadata?.format ?? undefined,
        sizeBytes: metadata?.size_bytes,
      });
    },
    [imageUrl, label, metadata, title]
  );

  if (isVibeImage && isLoading) {
    return <span className="conv-md-image-placeholder">Loading image...</span>;
  }

  if (!imageUrl) {
    return (
      <a href={normalizedSrc} rel="noopener noreferrer">
        {label}
      </a>
    );
  }

  return (
    <button
      type="button"
      className="conv-md-image-frame"
      onClick={handleClick}
      title={title || label}
    >
      <img src={imageUrl} alt={label} className="conv-md-image" />
    </button>
  );
}

function arePropsEqual(prev: MarkdownProps, next: MarkdownProps) {
  return (
    prev.value === next.value &&
    prev.className === next.className &&
    prev.taskAttemptId === next.taskAttemptId &&
    prev.taskId === next.taskId &&
    prev.workspacePath === next.workspacePath
  );
}

export const Markdown = memo(function Markdown({
  value,
  className,
  taskAttemptId,
  taskId,
  workspacePath,
}: MarkdownProps) {
  const panelActions = useOptionalPanelActionsContext();
  const normalizedValue = useMemo(
    () =>
      normalizeBareImageReferences(
        replaceTagReferenceMarkersWithMarkdownLinks(
          stripTagReferenceAppendix(value)
        )
      ),
    [value]
  );

  const components = useMemo<Components>(
    () => ({
      pre: ({ node, children }) => (
        <PreBlock node={node as PreProps['node']}>{children}</PreBlock>
      ),
      code: ({ className: codeClass, children }) => {
        const text = flattenNodeText(children).trim();
        const fileLink = resolveMarkdownFileLinkCandidate(
          undefined,
          text,
          workspacePath
        );

        if (fileLink) {
          const handleClick = (event: MouseEvent<HTMLElement>) => {
            event.preventDefault();
            event.stopPropagation();
            panelActions?.openFilePreview(fileLink.filePath, {
              displayPath: fileLink.displayPath,
              title: fileLink.displayPath,
            });
          };

          return (
            <code
              className={codeClass ?? undefined}
              onClick={handleClick}
              role="button"
              tabIndex={0}
              title={fileLink.displayPath}
            >
              {text || children}
            </code>
          );
        }

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

        const childrenText = flattenNodeText(children);
        const imageHref =
          href && isMarkdownImagePath(href) && !parseTagReferenceHref(href)
            ? href
            : null;

        if (imageHref) {
          return (
            <MarkdownImage
              src={imageHref}
              alt={childrenText || undefined}
              taskAttemptId={taskAttemptId}
              taskId={taskId}
              workspacePath={workspacePath}
            />
          );
        }

        const fileLink = resolveMarkdownFileLinkCandidate(
          href,
          childrenText,
          workspacePath
        );
        const isExternal =
          (href?.startsWith('http://') || href?.startsWith('https://')) ??
          false;
        const isInternalProjectRoute = href
          ? isInternalProjectRouteHref(href)
          : false;
        const renderedHref =
          href && isExternal && !fileLink && !isInternalProjectRoute
            ? href
            : undefined;

        const handleClick = async (event: MouseEvent<HTMLAnchorElement>) => {
          if (!href) return;

          if (fileLink) {
            event.preventDefault();
            event.stopPropagation();
            panelActions?.openFilePreview(fileLink.filePath, {
              displayPath: fileLink.displayPath,
              title: fileLink.displayPath,
            });
            return;
          }

          if (isInternalProjectRoute) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }

          if (!isExternal) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }

          event.preventDefault();

          try {
            const { open } = await import('@tauri-apps/plugin-shell');
            await open(href);
          } catch {
            window.open(href, '_blank', 'noopener,noreferrer');
          }
        };

        return (
          <a
            href={renderedHref}
            onClick={handleClick}
            rel="noopener noreferrer"
            role={renderedHref ? undefined : 'link'}
            tabIndex={renderedHref ? undefined : 0}
            title={href}
          >
            {children}
          </a>
        );
      },
      img: ({ src, alt, title }) => (
        <MarkdownImage
          src={src}
          alt={alt}
          title={title}
          taskAttemptId={taskAttemptId}
          taskId={taskId}
          workspacePath={workspacePath}
        />
      ),
    }),
    [panelActions, taskAttemptId, taskId, workspacePath]
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
