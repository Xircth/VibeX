import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  Markdown as AstryxMarkdownBase,
  type MarkdownProps,
} from '@astryxdesign/core/Markdown';
import { loadKatex } from '@/lib/katexRuntime';
import {
  hostFileSrc,
  isDirectBrowserDisplayUrl,
  releaseHostFileSrc,
} from '@/lib/hostAsset';
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
import {
  MEMBER_PLACEHOLDER_PATTERN,
  MemberMentionChip,
  protectMemberMentions,
  useCollaborationMemberMention,
} from '@/features/collaboration/MemberMentionChip';
import { findMarkdownRenderer, useMarkdownRenderers } from '@vibex/plugin-sdk';
import { PluginBoundary } from '@/components/plugins/PluginBoundary';
import { CodeBlock, CompactCodeBlock } from './CodeBlock';
import { HtmlPreviewBlock, isHtmlPreviewLanguage } from './HtmlPreviewBlock';
import { MermaidDiagram } from './MermaidDiagram';
import { parseTagReferenceHref } from '@/lib/tagReferenceMarkers';
import {
  MarkdownBlockCache,
  MAX_CACHED_CHARS,
  type MarkdownBlockCacheStats,
} from '@/lib/conversation-rendering/markdownBlockCache';
import {
  decodeFenceInfoLanguage,
  encodeFenceInfoLanguages,
} from '@/lib/conversation-rendering/markdownFences';
import {
  preprocessForBlockSplit,
  splitIntoBlocks,
} from '@/lib/conversation-rendering/markdownPreprocess';
import { prepareSingleMarkdownBlock } from '@/lib/conversation-rendering/streamdownPlugins';
import {
  MATH_PLACEHOLDER_PATTERN,
  protectConversationMath,
} from '@/lib/conversation-rendering/conversationMath';
import {
  HTML_PLACEHOLDER_PATTERN,
  protectRawHtml,
} from '@/lib/conversation-rendering/rawHtml';
import { RawHtmlElement } from './RawHtmlElement';
import {
  MarkdownResourceLink,
  resolveMarkdownInlineResource,
} from './MarkdownResourceLink';
import {
  isMarkdownImagePath,
  isRenderableRemoteImage,
  resolveLocalMarkdownImagePath,
} from './localImagePaths';

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
  /**
   * Render allowlisted raw HTML (sanitized through DOMPurify). Defaults to
   * `true`; pass `false` on surfaces that must keep `<` literal.
   */
  rawHtml?: boolean;
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
  const vibeFilePath =
    isVibeImage &&
    metadata?.proxy_url &&
    !isDirectBrowserDisplayUrl(metadata.proxy_url)
      ? metadata.proxy_url
      : null;
  const fileSrcPath = vibeFilePath ?? localImagePath;
  const [fileSrcUrl, setFileSrcUrl] = useState<string | null>(null);
  const [fileSrcFailed, setFileSrcFailed] = useState(false);
  useEffect(() => {
    if (!fileSrcPath) {
      setFileSrcUrl(null);
      setFileSrcFailed(false);
      return;
    }
    let cancelled = false;
    setFileSrcUrl(null);
    setFileSrcFailed(false);
    void hostFileSrc(fileSrcPath)
      .then((url) => {
        if (cancelled) {
          releaseHostFileSrc(fileSrcPath);
          return;
        }
        setFileSrcUrl(url);
      })
      .catch(() => {
        if (!cancelled) setFileSrcFailed(true);
      });
    return () => {
      cancelled = true;
      releaseHostFileSrc(fileSrcPath);
    };
  }, [fileSrcPath]);
  const imageUrl = isVibeImage
    ? isDirectBrowserDisplayUrl(metadata?.proxy_url)
      ? metadata?.proxy_url
      : fileSrcUrl
    : isRenderableRemoteImage(normalizedSrc)
      ? normalizedSrc
      : fileSrcUrl;
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

  if (
    (isVibeImage && isLoading) ||
    (fileSrcPath && !fileSrcUrl && !fileSrcFailed)
  ) {
    return <span className="conv-md-image-placeholder">Loading image...</span>;
  }

  if (!imageUrl) {
    return (
      <MarkdownResourceLink
        href={normalizedSrc}
        workspacePath={workspacePath}
        pathTarget={
          fileSrcPath
            ? {
                path: fileSrcPath,
                displayPath: normalizedSrc,
                nodeType: 'file',
              }
            : undefined
        }
      >
        {label}
      </MarkdownResourceLink>
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
  isStreaming?: boolean;
};

function MarkdownCodeSwitch({
  code,
  language: rawLanguage,
  taskAttemptId,
  taskId,
  workspacePath,
  isStreaming,
}: MarkdownComponentContext & { code: string; language?: string }) {
  const renderers = useMarkdownRenderers();
  const language = decodeFenceInfoLanguage(rawLanguage);
  const customRenderer =
    renderers.length > 0 ? findMarkdownRenderer(code, language) : undefined;
  if (customRenderer) {
    const pluginId = customRenderer.pluginId ?? 'unknown-plugin';
    const CustomComponent = customRenderer.component;
    const rendererProps = {
      code,
      language,
      isStreaming,
      workspacePath,
      taskAttemptId,
      taskId,
    };
    return (
      <PluginBoundary pluginId={pluginId} slot="markdown.codeblock">
        {CustomComponent ? (
          <CustomComponent {...rendererProps} />
        ) : customRenderer.render ? (
          (customRenderer.render(rendererProps) as ReactNode)
        ) : null}
      </PluginBoundary>
    );
  }
  if (language?.toLowerCase() === 'mermaid') {
    return <MermaidDiagram value={code} />;
  }
  if (isHtmlPreviewLanguage(language)) {
    return (
      <HtmlPreviewBlock
        code={code}
        workspacePath={workspacePath}
        isStreaming={isStreaming}
      />
    );
  }
  const className =
    language && language !== 'plaintext' ? `language-${language}` : undefined;
  const isSingleLine = !code.includes('\n');
  if (isSingleLine) {
    return <CompactCodeBlock className={className} value={code} />;
  }
  return (
    <CodeBlock className={className} value={code} isStreaming={isStreaming} />
  );
}

function createMarkdownComponents({
  taskAttemptId,
  taskId,
  workspacePath,
  isStreaming,
}: MarkdownComponentContext): MarkdownProps['components'] {
  return {
    code: ({ code, language }) => (
      <MarkdownCodeSwitch
        code={code}
        language={language}
        taskAttemptId={taskAttemptId}
        taskId={taskId}
        workspacePath={workspacePath}
        isStreaming={isStreaming}
      />
    ),
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
            strict: false,
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
    prev.isStreaming === next.isStreaming &&
    prev.rawHtml === next.rawHtml
  );
}

const markdownBlockElementCache = new MarkdownBlockCache<ReactElement>(
  MAX_CACHED_CHARS
);

export function getMarkdownBlockElementCacheStats(): MarkdownBlockCacheStats {
  return markdownBlockElementCache.stats();
}

export function resetMarkdownBlockElementCache(): void {
  markdownBlockElementCache.clear();
  markdownBlockElementCache.resetStats();
}

type CompileMarkdownBlockOptions = {
  softBreaks?: boolean;
  rawHtml?: boolean;
  workspacePath?: string | null;
  enableMemberMentions: boolean;
  knownNicknames: readonly string[];
  isStreaming?: boolean;
  components: MarkdownProps['components'];
};

function buildBlockElementCacheKey(
  blockHash: string,
  blockText: string,
  options: {
    softBreaks?: boolean;
    rawHtml?: boolean;
    workspacePath?: string | null;
    taskAttemptId?: string;
    taskId?: string;
    enableMemberMentions: boolean;
    knownNicknames: readonly string[];
  }
): string {
  const mentionSignature =
    options.enableMemberMentions && blockText.includes('@')
      ? `1:${options.knownNicknames.join('\u0001')}`
      : '0';
  return `${blockHash}|s=${options.softBreaks ? 1 : 0}|h=${options.rawHtml !== false ? 1 : 0}|w=${options.workspacePath ?? ''}|a=${options.taskAttemptId ?? ''}|t=${options.taskId ?? ''}|m=${mentionSignature}`;
}

function compileMarkdownBlockElement(
  blockText: string,
  options: CompileMarkdownBlockOptions
): ReactElement {
  const prepared = prepareSingleMarkdownBlock(blockText, {
    softBreaks: options.softBreaks,
  });
  // Astryx drops link nodes with empty destinations (`[text]()`), so rewrite
  // empty targets to `#` — the link component resolves workspace paths from label.
  const withLinks = prepared.replace(/\[([^\]\n]+)\]\(\)/g, '[$1](#)');
  // Raw HTML is protected before math so `$…$` inside an HTML region stays literal.
  const protectedHtml =
    options.rawHtml !== false
      ? protectRawHtml(withLinks)
      : { text: withLinks, html: [] };
  const withMath = protectConversationMath(protectedHtml.text);
  const withMentions = options.enableMemberMentions
    ? protectMemberMentions(withMath.text, options.knownNicknames)
    : { text: withMath.text, mentions: [] };
  const finalText = encodeFenceInfoLanguages(withMentions.text);

  const inlinePlugins: NonNullable<MarkdownProps['inlinePlugins']> = [];
  if (withMath.math.length > 0) {
    inlinePlugins.push({
      pattern: MATH_PLACEHOLDER_PATTERN,
      render: (match: RegExpMatchArray, key: string) => {
        const math = withMath.math[Number(match[1])];
        if (!math) return null;
        return <KatexMath key={key} tex={math.tex} display={math.display} />;
      },
    });
  }
  if (protectedHtml.html.length > 0) {
    inlinePlugins.push({
      pattern: HTML_PLACEHOLDER_PATTERN,
      render: (match: RegExpMatchArray, key: string) => {
        const entry = protectedHtml.html[Number(match[1])];
        if (!entry) return null;
        return (
          <RawHtmlElement
            key={key}
            html={entry.html}
            block={entry.block}
            workspacePath={options.workspacePath}
          />
        );
      },
    });
  }
  if (withMentions.mentions.length > 0) {
    inlinePlugins.push({
      pattern: MEMBER_PLACEHOLDER_PATTERN,
      render: (match: RegExpMatchArray, key: string) => {
        const nickname = withMentions.mentions[Number(match[1])];
        if (!nickname) return null;
        return <MemberMentionChip key={key} nickname={nickname} />;
      },
    });
  }

  return (
    <AstryxMarkdownBase
      display="block"
      autolink="gfm"
      contentWidth="100%"
      components={options.components}
      inlinePlugins={inlinePlugins.length > 0 ? inlinePlugins : undefined}
      isStreaming={options.isStreaming}
    >
      {finalText}
    </AstryxMarkdownBase>
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
  rawHtml,
}: AstryxMarkdownProps) {
  const memberMentionCtx = useCollaborationMemberMention();

  const settledComponents = useMemo<MarkdownProps['components']>(
    () =>
      createMarkdownComponents({
        taskAttemptId,
        taskId,
        workspacePath,
        isStreaming: false,
      }),
    [taskAttemptId, taskId, workspacePath]
  );

  const activeComponents = useMemo<MarkdownProps['components']>(
    () =>
      isStreaming
        ? createMarkdownComponents({
            taskAttemptId,
            taskId,
            workspacePath,
            isStreaming: true,
          })
        : settledComponents,
    [isStreaming, settledComponents, taskAttemptId, taskId, workspacePath]
  );

  const renderedBlocks = useMemo(() => {
    const { body, tagAppendix, mathSpans } = preprocessForBlockSplit(value);
    const blocks = splitIntoBlocks(body, mathSpans, Boolean(isStreaming));
    const elements: ReactElement[] = [];

    for (const block of blocks) {
      if (block.closed) {
        const cacheKey = buildBlockElementCacheKey(block.hash, block.text, {
          softBreaks,
          rawHtml,
          workspacePath,
          taskAttemptId,
          taskId,
          enableMemberMentions: memberMentionCtx.enableMemberMentions,
          knownNicknames: memberMentionCtx.knownNicknames,
        });
        const cached = markdownBlockElementCache.hit(cacheKey, block.text);
        if (cached) {
          elements.push(cached);
          continue;
        }
        const compiled = compileMarkdownBlockElement(block.text, {
          softBreaks,
          rawHtml,
          workspacePath,
          enableMemberMentions: memberMentionCtx.enableMemberMentions,
          knownNicknames: memberMentionCtx.knownNicknames,
          isStreaming: false,
          components: settledComponents,
        });
        markdownBlockElementCache.set(cacheKey, block.text, compiled);
        elements.push(compiled);
        continue;
      }

      elements.push(
        compileMarkdownBlockElement(block.text, {
          softBreaks,
          rawHtml,
          workspacePath,
          enableMemberMentions: memberMentionCtx.enableMemberMentions,
          knownNicknames: memberMentionCtx.knownNicknames,
          isStreaming: Boolean(isStreaming),
          components: activeComponents,
        })
      );
    }

    if (tagAppendix) {
      elements.push(
        compileMarkdownBlockElement(tagAppendix, {
          softBreaks,
          rawHtml,
          workspacePath,
          enableMemberMentions: memberMentionCtx.enableMemberMentions,
          knownNicknames: memberMentionCtx.knownNicknames,
          isStreaming: Boolean(isStreaming),
          components: activeComponents,
        })
      );
    }

    return elements;
  }, [
    activeComponents,
    isStreaming,
    memberMentionCtx.enableMemberMentions,
    memberMentionCtx.knownNicknames,
    rawHtml,
    settledComponents,
    softBreaks,
    taskAttemptId,
    taskId,
    value,
    workspacePath,
  ]);

  const prevKeyedBlocksRef = useRef<
    Array<{ raw: ReactElement; keyed: ReactElement }>
  >([]);

  const keyedBlocks = useMemo(() => {
    const previous = prevKeyedBlocksRef.current;
    const next: Array<{ raw: ReactElement; keyed: ReactElement }> = new Array(
      renderedBlocks.length
    );

    for (let index = 0; index < renderedBlocks.length; index += 1) {
      const raw = renderedBlocks[index]!;
      const prevEntry = previous[index];
      if (prevEntry && prevEntry.raw === raw) {
        next[index] = prevEntry;
      } else {
        next[index] = {
          raw,
          keyed: <Fragment key={`block-${index}`}>{raw}</Fragment>,
        };
      }
    }

    prevKeyedBlocksRef.current = next;
    return next.map((entry) => entry.keyed);
  }, [renderedBlocks]);

  return (
    <div className={`conv-markdown${className ? ` ${className}` : ''}`}>
      {keyedBlocks}
    </div>
  );
}, arePropsEqual);
