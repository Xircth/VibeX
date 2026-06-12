import {
  memo,
  useMemo,
  useCallback,
  type ReactNode,
  type MouseEvent,
} from 'react';
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
  type Options as ReactMarkdownOptions,
} from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { convertFileSrc } from '@tauri-apps/api/core';
import { TagReferenceChip } from '@/components/ui/tag-reference-chip';
import { ImagePreviewDialog } from '@/components/dialogs/wysiwyg/ImagePreviewDialog';
import { useImageMetadata } from '@/hooks/useImageMetadata';
import { useOptionalPanelActionsContext } from '@/contexts/PanelActionsContext';
import { CodeBlock, CompactCodeBlock, extractLanguageTag } from './CodeBlock';
import { MermaidDiagram } from './MermaidDiagram';
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

function PreBlock({ node, children }: PreProps) {
  const { className, value } = extractCodeFromPre(node);

  if (!className && !value && children) {
    return <pre>{children}</pre>;
  }

  if (extractLanguageTag(className)?.toLowerCase() === 'mermaid') {
    return <MermaidDiagram value={value} />;
  }

  const isSingleLine = !value.includes('\n');

  if (isSingleLine) {
    return <CompactCodeBlock className={className} value={value} />;
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
    hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
  );
}

function isInternalProjectRouteHref(href: string): boolean {
  const parsed = parseHref(href);
  if (!parsed) return href.startsWith('/local-projects');

  return (
    parsed.pathname.startsWith('/local-projects') &&
    (parsed.origin === window.location.origin ||
      isLoopbackHost(parsed.hostname))
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

type WorkspacePathTarget = {
  path: string;
  displayPath: string;
  nodeType: 'file' | 'folder';
};

function hrefToWorkspacePathCandidate(
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

  if (
    raw.startsWith('/') &&
    workspacePath &&
    /^[a-zA-Z]:[\\/]/.test(workspacePath)
  ) {
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
  if (
    /^[a-z][a-z0-9+.-]*:/i.test(candidate) &&
    !isAbsoluteLocalPath(candidate)
  ) {
    return false;
  }
  if (candidate.startsWith('/local-projects')) return false;
  if (isAbsoluteLocalPath(candidate)) {
    return /(?:^|[\\/])[^\\/]+\.[a-z0-9]{1,12}$/i.test(
      candidate.replace(/[\\/]+$/, '')
    );
  }

  return (
    /[\\/]/.test(candidate) &&
    /(?:^|[\\/])[^\\/]+\.[a-z0-9]{1,12}$/i.test(candidate)
  );
}

function looksLikeWorkspaceDirectoryPath(value: string): boolean {
  const candidate = trimFilePathCandidate(value).replace(/[\\/]+$/, '');
  if (!candidate || candidate === '.' || candidate.startsWith('#')) {
    return false;
  }
  if (
    /^[a-z][a-z0-9+.-]*:/i.test(candidate) &&
    !isAbsoluteLocalPath(candidate)
  ) {
    return false;
  }
  if (candidate.startsWith('/local-projects')) {
    return false;
  }
  if (looksLikeWorkspaceFilePath(candidate)) {
    return false;
  }
  if (isAbsoluteLocalPath(candidate)) {
    return true;
  }

  return /[\\/]/.test(candidate);
}

function resolveMarkdownWorkspacePathTarget(
  href: string | undefined,
  childrenText: string,
  workspacePath?: string | null
): WorkspacePathTarget | null {
  const candidates = [
    childrenText,
    hrefToWorkspacePathCandidate(href, workspacePath) ?? '',
    href ?? '',
  ]
    .map(trimFilePathCandidate)
    .filter(Boolean);

  for (const candidate of candidates) {
    const nodeType = looksLikeWorkspaceFilePath(candidate)
      ? 'file'
      : looksLikeWorkspaceDirectoryPath(candidate)
        ? 'folder'
        : null;
    if (!nodeType) continue;

    const normalizedCandidate =
      nodeType === 'folder' ? candidate.replace(/[\\/]+$/, '') : candidate;
    const filePath = resolveFilePathFromRoot(
      normalizedCandidate,
      workspacePath
    );
    const displayPath =
      deriveRelativeFilePath(filePath, workspacePath) ?? normalizedCandidate;
    return { path: filePath, displayPath, nodeType };
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

function normalizeMathDelimiters(value: string): string {
  return splitFencedCodeSegments(value)
    .map((segment) =>
      segment.protected
        ? segment.text
        : normalizeInlineMathSegments(segment.text)
    )
    .join('');
}

function splitFencedCodeSegments(
  value: string
): Array<{ text: string; protected: boolean }> {
  const segments: Array<{ text: string; protected: boolean }> = [];
  const lines = value.match(/[^\n]*(?:\n|$)/g) ?? [];
  let buffer = '';
  let inFence = false;
  let fenceChar: '`' | '~' | null = null;
  let fenceLength = 0;

  const flush = (protectedSegment: boolean) => {
    if (!buffer) return;
    segments.push({ text: buffer, protected: protectedSegment });
    buffer = '';
  };

  for (const line of lines) {
    if (!line) continue;
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);

    if (!inFence && fenceMatch) {
      flush(false);
      inFence = true;
      fenceChar = fenceMatch[1][0] as '`' | '~';
      fenceLength = fenceMatch[1].length;
      buffer += line;
      continue;
    }

    if (inFence) {
      buffer += line;
      if (
        fenceMatch &&
        fenceChar &&
        fenceMatch[1][0] === fenceChar &&
        fenceMatch[1].length >= fenceLength
      ) {
        flush(true);
        inFence = false;
        fenceChar = null;
        fenceLength = 0;
      }
      continue;
    }

    buffer += line;
  }

  flush(inFence);
  return segments;
}

function normalizeInlineMathSegments(value: string): string {
  let result = '';
  let index = 0;

  while (index < value.length) {
    if (value[index] !== '`') {
      const nextTick = value.indexOf('`', index);
      const textSegment =
        nextTick === -1 ? value.slice(index) : value.slice(index, nextTick);
      result += convertTexMathDelimiters(textSegment);
      index = nextTick === -1 ? value.length : nextTick;
      continue;
    }

    const tickRunMatch = value.slice(index).match(/^`+/);
    const tickRun = tickRunMatch?.[0] ?? '`';
    const closingIndex = value.indexOf(tickRun, index + tickRun.length);

    if (closingIndex === -1) {
      result += value.slice(index);
      break;
    }

    result += value.slice(index, closingIndex + tickRun.length);
    index = closingIndex + tickRun.length;
  }

  return result;
}

function convertTexMathDelimiters(value: string): string {
  return value
    .replace(/\\\[([\s\S]+?)\\\]/g, (_match, content: string) => {
      return `$$${content}$$`;
    })
    .replace(/\\\(([\s\S]+?)\\\)/g, (_match, content: string) => {
      return `$${content}$`;
    });
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

function markdownUrlTransform(url: string): string {
  if (url.startsWith('data:image/') || url.startsWith('blob:')) {
    return url;
  }

  return defaultUrlTransform(url);
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
      normalizeMathDelimiters(
        normalizeBareImageReferences(
          replaceTagReferenceMarkersWithMarkdownLinks(
            stripTagReferenceAppendix(value)
          )
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
        const pathTarget = resolveMarkdownWorkspacePathTarget(
          undefined,
          text,
          workspacePath
        );

        if (pathTarget?.nodeType === 'file') {
          const handleClick = (event: MouseEvent<HTMLElement>) => {
            event.preventDefault();
            event.stopPropagation();
            panelActions?.openFilePreview(pathTarget.path, {
              displayPath: pathTarget.displayPath,
              title: pathTarget.displayPath,
            });
          };

          return (
            <code
              className={codeClass ?? undefined}
              onClick={handleClick}
              role="button"
              tabIndex={0}
              title={pathTarget.displayPath}
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
          href &&
          (isMarkdownImagePath(href) ||
            href.startsWith('data:image/') ||
            href.startsWith('blob:')) &&
          !parseTagReferenceHref(href)
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

        const pathTarget = resolveMarkdownWorkspacePathTarget(
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
          href && isExternal && !pathTarget && !isInternalProjectRoute
            ? href
            : undefined;

        const handleClick = async (event: MouseEvent<HTMLAnchorElement>) => {
          if (pathTarget) {
            event.preventDefault();
            event.stopPropagation();
            if (pathTarget.nodeType === 'file') {
              panelActions?.openFilePreview(pathTarget.path, {
                displayPath: pathTarget.displayPath,
                title: pathTarget.displayPath,
              });
            } else {
              panelActions?.revealInFileTree(pathTarget.path, {
                displayPath: pathTarget.displayPath,
                nodeType: 'folder',
              });
            }
            return;
          }

          if (!href) {
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
            title={pathTarget?.displayPath ?? href}
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

  const remarkPlugins = useMemo<
    NonNullable<ReactMarkdownOptions['remarkPlugins']>
  >(() => [remarkGfm, remarkMath], []);
  const rehypePlugins = useMemo<
    NonNullable<ReactMarkdownOptions['rehypePlugins']>
  >(() => [[rehypeKatex, { throwOnError: false, strict: false }]], []);

  return (
    <div className={`conv-markdown${className ? ` ${className}` : ''}`}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
        urlTransform={markdownUrlTransform}
      >
        {normalizedValue}
      </ReactMarkdown>
    </div>
  );
}, arePropsEqual);

export default Markdown;
