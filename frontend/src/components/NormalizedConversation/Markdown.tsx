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
import { useImageMetadata } from '@/hooks/useImageMetadata';
import { useOpenImagePreview } from '@/hooks/useOpenImagePreview';
import { useOpenLink } from '@/hooks/useOpenLink';
import { useOptionalPanelActionsContext } from '@/contexts/PanelActionsContext';
import { CodeBlock, CompactCodeBlock, extractLanguageTag } from './CodeBlock';
import { MermaidDiagram } from './MermaidDiagram';
import {
  deriveRelativeFilePath,
  resolveFilePathFromRoot,
} from '@/utils/filePaths';
import { parseTagReferenceHref } from '@/lib/tagReferenceMarkers';
import { prepareConversationMarkdown } from '@/lib/conversation-rendering/streamdownPlugins';
import { splitMarkdownIntoBlocks } from '@/lib/conversation-rendering/markdownBlocks';

type MarkdownProps = {
  value: string;
  className?: string;
  taskAttemptId?: string;
  taskId?: string;
  workspacePath?: string | null;
  softBreaks?: boolean;
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

function resolveLocalMarkdownImagePath(
  src: string,
  workspacePath?: string | null
): string | null {
  if (!src) return null;
  if (src.startsWith('file://')) {
    return src.replace(/^file:\/\//i, '');
  }
  if (isAbsoluteLocalPath(src)) {
    return src;
  }
  if (!workspacePath || src.includes('://') || src.startsWith('#')) {
    return null;
  }

  const normalizedRelative = src.replace(/^\.?[\\/]/, '');
  return `${workspacePath.replace(/[\\/]+$/, '')}/${normalizedRelative}`;
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
  const localImagePath =
    isVibeImage || isRenderableRemoteImage(normalizedSrc)
      ? null
      : resolveLocalMarkdownImagePath(normalizedSrc, workspacePath);
  const imageUrl = isVibeImage
    ? metadata?.proxy_url
    : isRenderableRemoteImage(normalizedSrc)
      ? normalizedSrc
      : localImagePath
        ? convertFileSrc(localImagePath)
        : null;
  const label = alt || title || metadata?.file_name || normalizedSrc || 'Image';
  const panelActions = useOptionalPanelActionsContext();
  const openImagePreview = useOpenImagePreview();

  const handleClick = useCallback(
    (event: MouseEvent) => {
      if (!imageUrl) return;
      event.preventDefault();

      // Workspace-local images open as a regular file preview tab so the
      // file tree stays in sync; everything else opens as an image tab.
      if (localImagePath && panelActions) {
        panelActions.openFilePreview(localImagePath, {
          title: metadata?.file_name ?? title ?? label,
        });
        return;
      }

      openImagePreview({
        imageUrl,
        altText: label,
        fileName: metadata?.file_name ?? title ?? label,
        format: metadata?.format ?? undefined,
        sizeBytes: metadata?.size_bytes,
      });
    },
    [
      imageUrl,
      label,
      localImagePath,
      metadata,
      openImagePreview,
      panelActions,
      title,
    ]
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
    prev.workspacePath === next.workspacePath &&
    prev.softBreaks === next.softBreaks
  );
}

function markdownUrlTransform(url: string): string {
  if (url.startsWith('data:image/') || url.startsWith('blob:')) {
    return url;
  }

  return defaultUrlTransform(url);
}

const REMARK_PLUGINS: NonNullable<ReactMarkdownOptions['remarkPlugins']> = [
  remarkGfm,
  remarkMath,
];

/** Containers whose direct text children are pure formatting whitespace. */
const BLOCK_CONTAINER_TAGS = new Set([
  'ul',
  'ol',
  'table',
  'thead',
  'tbody',
  'tr',
  'blockquote',
]);

type HastNode = {
  type: string;
  value?: string;
  tagName?: string;
  children?: HastNode[];
};

/**
 * Drop the newline text nodes hast keeps between block-level siblings (root
 * level, list/table internals). They render as zero-height whitespace, but the
 * caret can still land on them — a double-click in the blank area after a turn
 * selects one and paints a phantom empty line.
 */
function rehypeStripInterBlockWhitespace() {
  const strip = (node: HastNode, isContainer: boolean) => {
    if (!node.children) return;
    if (isContainer) {
      node.children = node.children.filter(
        (child) =>
          !(
            child.type === 'text' &&
            typeof child.value === 'string' &&
            child.value.includes('\n') &&
            child.value.trim().length === 0
          )
      );
    }
    for (const child of node.children) {
      strip(
        child,
        child.type === 'element' &&
          BLOCK_CONTAINER_TAGS.has(child.tagName ?? '')
      );
    }
  };

  return (tree: HastNode) => strip(tree, true);
}

const REHYPE_PLUGINS: NonNullable<ReactMarkdownOptions['rehypePlugins']> = [
  [rehypeKatex, { throwOnError: false, strict: false }],
  rehypeStripInterBlockWhitespace,
];

type MarkdownComponentContext = {
  panelActions: ReturnType<typeof useOptionalPanelActionsContext>;
  openLink: (url: string) => void;
  taskAttemptId?: string;
  taskId?: string;
  workspacePath?: string | null;
};

// Inline-code text is looser than link hrefs (prose like `either/or`, globs,
// shell flags); only treat it as a folder path when it looks like one.
function isCleanDirectoryCandidate(text: string): boolean {
  return !/[\s*?<>|"']/.test(text);
}

function createMarkdownComponents({
  panelActions,
  openLink,
  taskAttemptId,
  taskId,
  workspacePath,
}: MarkdownComponentContext): Components {
  return {
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
      const isClickableFile = pathTarget?.nodeType === 'file';
      const isClickableFolder =
        pathTarget?.nodeType === 'folder' && isCleanDirectoryCandidate(text);

      if (pathTarget && (isClickableFile || isClickableFolder)) {
        const handleClick = (event: MouseEvent<HTMLElement>) => {
          event.preventDefault();
          event.stopPropagation();
          if (isClickableFile) {
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

      return <code className={codeClass ?? undefined}>{text || children}</code>;
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
        (href?.startsWith('http://') || href?.startsWith('https://')) ?? false;
      const isInternalProjectRoute = href
        ? isInternalProjectRouteHref(href)
        : false;
      const renderedHref =
        href && isExternal && !pathTarget && !isInternalProjectRoute
          ? href
          : undefined;

      const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
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
        openLink(href);
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
  };
}

type MarkdownBlockProps = {
  value: string;
  components: Components;
};

const MemoizedMarkdownBlock = memo(
  function MarkdownBlock({ value, components }: MarkdownBlockProps) {
    return (
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={components}
        urlTransform={markdownUrlTransform}
      >
        {value}
      </ReactMarkdown>
    );
  },
  (prev, next) =>
    prev.value === next.value && prev.components === next.components
);

export const Markdown = memo(function Markdown({
  value,
  className,
  taskAttemptId,
  taskId,
  workspacePath,
  softBreaks,
}: MarkdownProps) {
  const panelActions = useOptionalPanelActionsContext();
  const openLink = useOpenLink();

  const normalizedValue = useMemo(
    () => prepareConversationMarkdown(value, { softBreaks }),
    [softBreaks, value]
  );

  // Blocks are append-stable while streaming (see splitMarkdownIntoBlocks),
  // so index keys are safe: completed blocks keep identical values and bail
  // out of re-parsing; only the growing tail block re-renders per flush.
  const blocks = useMemo(
    () => splitMarkdownIntoBlocks(normalizedValue),
    [normalizedValue]
  );

  const components = useMemo<Components>(
    () =>
      createMarkdownComponents({
        panelActions,
        openLink,
        taskAttemptId,
        taskId,
        workspacePath,
      }),
    [openLink, panelActions, taskAttemptId, taskId, workspacePath]
  );

  return (
    <div className={`conv-markdown${className ? ` ${className}` : ''}`}>
      {blocks.map((block, index) => (
        <MemoizedMarkdownBlock
          key={index}
          value={block}
          components={components}
        />
      ))}
    </div>
  );
}, arePropsEqual);

export default Markdown;
