import {
  memo,
  useCallback,
  useMemo,
  type MouseEvent,
  type ReactNode,
} from 'react';
import {
  Markdown as AstryxMarkdownBase,
  type MarkdownProps,
} from '@astryxdesign/core/Markdown';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { convertFileSrc } from '@tauri-apps/api/core';
import { TagReferenceChip } from '@/components/ui/tag-reference-chip';
import { useImageMetadata } from '@/hooks/useImageMetadata';
import { useOpenImagePreview } from '@/hooks/useOpenImagePreview';
import { useOpenLink } from '@/hooks/useOpenLink';
import { useOptionalPanelActionsContext } from '@/contexts/PanelActionsContext';
import { CodeBlock, CompactCodeBlock } from './CodeBlock';
import { MermaidDiagram } from './MermaidDiagram';
import {
  deriveRelativeFilePath,
  resolveFilePathFromRoot,
} from '@/utils/filePaths';
import { parseTagReferenceHref } from '@/lib/tagReferenceMarkers';
import { prepareConversationMarkdown } from '@/lib/conversation-rendering/streamdownPlugins';

export type AstryxMarkdownProps = {
  /** Markdown string to render. */
  value: string;
  className?: string;
  taskAttemptId?: string;
  taskId?: string;
  workspacePath?: string | null;
  softBreaks?: boolean;
  /** Opt-in streaming fade-in (Astryx incremental parse + animation). */
  isStreaming?: boolean;
};

function flattenNodeText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(flattenNodeText).join('');
  if (typeof node === 'object' && 'props' in node) {
    return flattenNodeText(
      (node as { props?: { children?: ReactNode } }).props?.children
    );
  }
  return '';
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

// Inline-code text is looser than link hrefs (prose like `either/or`, globs,
// shell flags); only treat it as a folder path when it looks like one.
function isCleanDirectoryCandidate(text: string): boolean {
  return !/[\s*?<>|"']/.test(text);
}

function MarkdownImage({
  src,
  alt,
  taskAttemptId,
  taskId,
  workspacePath,
}: {
  src?: string;
  alt?: string;
  taskAttemptId?: string;
  taskId?: string;
  workspacePath?: string | null;
}) {
  // Astryx keeps angle brackets around `<url>` image destinations.
  const normalizedSrc = (src ?? '').replace(/^<([\s\S]*)>$/, '$1');
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
  const label = alt || metadata?.file_name || normalizedSrc || 'Image';
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
          title: metadata?.file_name ?? label,
        });
        return;
      }

      openImagePreview({
        imageUrl,
        altText: label,
        fileName: metadata?.file_name ?? label,
        format: metadata?.format ?? undefined,
        sizeBytes: metadata?.size_bytes,
      });
    },
    [imageUrl, label, localImagePath, metadata, openImagePreview, panelActions]
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
      title={label}
    >
      <img src={imageUrl} alt={label} className="conv-md-image" />
    </button>
  );
}

type MarkdownComponentContext = {
  panelActions: ReturnType<typeof useOptionalPanelActionsContext>;
  openLink: (url: string) => void;
  taskAttemptId?: string;
  taskId?: string;
  workspacePath?: string | null;
};

function createMarkdownComponents({
  panelActions,
  openLink,
  taskAttemptId,
  taskId,
  workspacePath,
}: MarkdownComponentContext): MarkdownProps['components'] {
  return {
    code: ({ code, language }) => {
      if (language?.toLowerCase() === 'mermaid') {
        return <MermaidDiagram value={code} />;
      }
      const className = language ? `language-${language}` : undefined;
      const isSingleLine = !code.includes('\n');
      if (isSingleLine) {
        return <CompactCodeBlock className={className} value={code} />;
      }
      return <CodeBlock className={className} value={code} />;
    },
    inlineCode: ({ children }) => {
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
            onClick={handleClick}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                event.currentTarget.click();
              }
            }}
            role="button"
            tabIndex={0}
            title={pathTarget.displayPath}
          >
            {text || children}
          </code>
        );
      }

      return <code>{text || children}</code>;
    },
    link: ({ href, children }) => {
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
          onKeyDown={(event) => {
            if (!renderedHref && event.key === 'Enter') {
              event.preventDefault();
              event.currentTarget.click();
            }
          }}
          rel="noopener noreferrer"
          role={renderedHref ? undefined : 'link'}
          tabIndex={renderedHref ? undefined : 0}
          title={pathTarget?.displayPath ?? href}
        >
          {children}
        </a>
      );
    },
    image: ({ src, alt }) => (
      <MarkdownImage
        src={src}
        alt={alt}
        taskAttemptId={taskAttemptId}
        taskId={taskId}
        workspacePath={workspacePath}
      />
    ),
  };
}

/**
 * Extract `$…$` / `$$…$$` math (after delimiter normalization) and replace it
 * with opaque placeholders so the Astryx parser cannot split math on escape
 * sequences (`\int` becomes plain `int`) or break multi-line `$$` blocks into
 * separate paragraphs. The KaTeX inline plugin restores the original text.
 */
function protectMathSegments(value: string): {
  text: string;
  math: { tex: string; display: boolean }[];
} {
  const math: { tex: string; display: boolean }[] = [];
  const text = value.replace(
    /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g,
    (_match, block: string | undefined, inline: string | undefined) => {
      const index = math.length;
      math.push({
        tex: block ?? inline ?? '',
        display: block !== undefined,
      });
      return `\uE000MATH${index}\uE000`;
    }
  );
  return { text, math };
}

const MATH_PLACEHOLDER_PATTERN = /\uE000MATH(\d+)\uE000/g;

function arePropsEqual(prev: AstryxMarkdownProps, next: AstryxMarkdownProps) {
  return (
    prev.value === next.value &&
    prev.className === next.className &&
    prev.taskAttemptId === next.taskAttemptId &&
    prev.taskId === next.taskId &&
    prev.workspacePath === next.workspacePath &&
    prev.softBreaks === next.softBreaks &&
    prev.isStreaming === next.isStreaming
  );
}

export const AstryxMarkdown = memo(function AstryxMarkdown({
  value,
  className,
  taskAttemptId,
  taskId,
  workspacePath,
  softBreaks,
  isStreaming,
}: AstryxMarkdownProps) {
  const panelActions = useOptionalPanelActionsContext();
  const openLink = useOpenLink();

  const normalizedValue = useMemo(() => {
    const prepared = prepareConversationMarkdown(value, { softBreaks });
    // Astryx drops link nodes with empty destinations (`[text]()`), so
    // rewrite empty targets to `#` — the link component then resolves the
    // workspace path from the link text (non-path text stays inert).
    const withLinks = prepared.replace(/\[([^\]\n]+)\]\(\)/g, '[$1](#)');
    return protectMathSegments(withLinks);
  }, [softBreaks, value]);

  const inlinePlugins = useMemo(
    () => [
      {
        pattern: MATH_PLACEHOLDER_PATTERN,
        render: (match: RegExpMatchArray, key: string) => {
          const index = Number(match[1]);
          const math = normalizedValue.math[index];
          if (!math) return null;
          return (
            <span
              key={key}
              className={math.display ? 'katex-display' : undefined}
              dangerouslySetInnerHTML={{
                __html: katex.renderToString(math.tex, {
                  displayMode: math.display,
                  throwOnError: false,
                }),
              }}
            />
          );
        },
      },
    ],
    [normalizedValue.math]
  );

  const components = useMemo<MarkdownProps['components']>(
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
      <AstryxMarkdownBase
        display="block"
        autolink="gfm"
        components={components}
        inlinePlugins={inlinePlugins}
        isStreaming={isStreaming}
      >
        {normalizedValue.text}
      </AstryxMarkdownBase>
    </div>
  );
}, arePropsEqual);

export default AstryxMarkdown;
