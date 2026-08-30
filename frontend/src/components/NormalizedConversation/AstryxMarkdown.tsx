import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import {
  Markdown as AstryxMarkdownBase,
  type MarkdownProps,
} from '@astryxdesign/core/Markdown';
import { loadKatex } from '@/lib/katexRuntime';
import { convertFileSrc } from '@tauri-apps/api/core';
import { TagReferenceChip } from '@/components/ui/tag-reference-chip';
import {
  parseCommitReferenceUri,
  parseConversationReferenceUri,
  shortCommitSha,
} from '@/components/tasks/follow-up/composerAtReferences';
import { atReferenceChipLabel } from '@/components/tasks/follow-up/sessionComposerStructuredTokens';
import { useImageMetadata } from '@/hooks/useImageMetadata';
import { useOpenImagePreview } from '@/hooks/useOpenImagePreview';
import { useOptionalPanelActionsContext } from '@/contexts/PanelActionsContext';
import { CodeBlock, CompactCodeBlock } from './CodeBlock';
import { MermaidDiagram } from './MermaidDiagram';
import { parseTagReferenceHref } from '@/lib/tagReferenceMarkers';
import { prepareConversationMarkdown } from '@/lib/conversation-rendering/streamdownPlugins';
import {
  isAbsoluteLocalPath,
  MarkdownResourceLink,
  resolveMarkdownInlineResource,
  trimFilePathCandidate,
} from './MarkdownResourceLink';

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
  taskAttemptId?: string;
  taskId?: string;
  workspacePath?: string | null;
};

function createMarkdownComponents({
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
      const resource = resolveMarkdownInlineResource(text, workspacePath);

      if (resource) {
        return (
          <MarkdownResourceLink
            href={resource.href}
            pathTarget={resource.pathTarget}
            workspacePath={workspacePath}
          >
            {text || children}
          </MarkdownResourceLink>
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

      const conversationId = href ? parseConversationReferenceUri(href) : null;
      if (conversationId) {
        const label = atReferenceChipLabel(
          flattenNodeText(children) || conversationId
        );
        return (
          <span className="mx-0.5 inline-flex max-w-[220px] items-center gap-1 rounded-md bg-[hsl(var(--info)/0.12)] px-1.5 py-0.5 align-baseline text-sm text-[hsl(var(--info))]">
            <span className="truncate font-medium">{label}</span>
          </span>
        );
      }

      const commit = href ? parseCommitReferenceUri(href) : null;
      if (commit) {
        const label = atReferenceChipLabel(
          flattenNodeText(children) || shortCommitSha(commit.sha)
        );
        return (
          <span
            className="mx-0.5 inline-flex max-w-[220px] items-center gap-1 rounded-md bg-[hsl(var(--info)/0.12)] px-1.5 py-0.5 align-baseline text-sm text-[hsl(var(--info))]"
            title={commit.sha}
          >
            <span className="truncate font-medium">{label}</span>
          </span>
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

      return (
        <MarkdownResourceLink href={href} workspacePath={workspacePath}>
          {children}
        </MarkdownResourceLink>
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

function KatexMath({ tex, display }: { tex: string; display: boolean }) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadKatex()
      .then((katex) => {
        if (cancelled) return;
        setHtml(
          katex.renderToString(tex, {
            displayMode: display,
            throwOnError: false,
          })
        );
      })
      .catch(() => {
        if (!cancelled) setHtml(null);
      });
    return () => {
      cancelled = true;
    };
  }, [display, tex]);

  if (html) {
    return (
      <span
        className={display ? 'katex-display' : undefined}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  return <span>{display ? `$$${tex}$$` : `$${tex}$`}</span>;
}

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
          return <KatexMath key={key} tex={math.tex} display={math.display} />;
        },
      },
    ],
    [normalizedValue.math]
  );

  const components = useMemo<MarkdownProps['components']>(
    () =>
      createMarkdownComponents({
        taskAttemptId,
        taskId,
        workspacePath,
      }),
    [taskAttemptId, taskId, workspacePath]
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
