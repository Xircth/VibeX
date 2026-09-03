import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { IDockviewPanelProps } from 'dockview-react';
import Editor, { type BeforeMount, type OnMount } from '@monaco-editor/react';
import type { editor as monacoEditor } from 'monaco-editor';
import {
  Code2,
  Eye,
  FileText,
  FileWarning,
  GitCompare,
  Image as ImageIcon,
} from 'lucide-react';
import {
  useBinaryAssetPreview,
  useFileAtHead,
  useFileContent,
  useSaveFile,
} from '@/hooks/useFileContent';
import { useTheme } from '@/components/ThemeProvider';
import { useFileTreeStore } from '@/stores/useFileTreeStore';
import type { PreviewPanelParams } from '@/types/panels';
import {
  deriveRelativeFilePath,
  resolveFilePathFromRoot,
} from '@/utils/filePaths';
import {
  defineAyuMonacoThemes,
  MONACO_THEME_AYU_DARK,
  MONACO_THEME_AYU_LIGHT,
} from '@/utils/monacoThemes';
import {
  getFilePreviewKind,
  isBinaryContentError,
} from '@/utils/filePreviewKind';
import { ZoomableImagePreview } from '@/components/previews/ZoomableImagePreview';
import { toast } from '@/components/ui/toast';
import { fileTreeApi } from '@/lib/api';
import { fileToBase64 } from '@/lib/api/misc';
import { fileTreeKeys } from '@/hooks/useFileTree';
import { extractImageFilesFromClipboardData } from '@/utils/clipboard';
import { insertPastedImagesAsMarkdown } from '@/utils/markdownImagePaste';
import { FilePreviewLoading } from './FilePreviewLoading';
import { resolveImagePreviewSource } from '@/lib/imagePreviewRegistry';
import { PluginFilePreview } from '@/components/previews/PluginFilePreview';
import { PluginArtifactEditor } from '@/components/previews/PluginArtifactEditor';
import {
  pluginControlApi,
  type ResolvedPluginFileOpener,
} from '@/lib/api/plugins';
import { preloadMonacoEditor } from '@/lib/monacoPreload';

const LazyMarkdown = lazy(
  () => import('@/components/NormalizedConversation/AstryxMarkdown')
);
const LazyFileContentView = lazy(
  () => import('@/components/NormalizedConversation/FileContentView')
);

function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const langMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescriptreact',
    js: 'javascript',
    jsx: 'javascriptreact',
    json: 'json',
    html: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    md: 'markdown',
    rs: 'rust',
    py: 'python',
    go: 'go',
    java: 'java',
    cpp: 'cpp',
    c: 'c',
    h: 'c',
    hpp: 'cpp',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    yml: 'yaml',
    yaml: 'yaml',
    toml: 'toml',
    xml: 'xml',
    sql: 'sql',
    graphql: 'graphql',
    dockerfile: 'dockerfile',
    makefile: 'makefile',
    lua: 'lua',
    rb: 'ruby',
    swift: 'swift',
    kt: 'kotlin',
    dart: 'dart',
    svelte: 'html',
    vue: 'html',
  };
  return langMap[ext] || 'plaintext';
}

function isMarkdownFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return ext === 'md' || ext === 'mdx' || ext === 'markdown';
}

function fileExtension(filePath: string) {
  const name = filePath.replace(/\\/g, '/').split('/').pop() ?? '';
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index + 1).toLowerCase() : undefined;
}

function getPathSegments(filePath: string): string[] {
  return filePath
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment.length > 0);
}

/** Directory containing `filePath` (forward slashes; `C:/` for drive roots). */
function dirnamePath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  if (index <= 0) return normalized;
  return normalized.slice(0, index);
}

function PreviewPlaceholder({
  icon,
  title,
  description,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description: string;
}) {
  const Icon = icon;

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
      <Icon className="h-10 w-10 opacity-50" />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-xs">{description}</p>
      </div>
    </div>
  );
}

function ContentLoadingFallback({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
      {label}
    </div>
  );
}

const markdownRenderStateMap = new Map<string, boolean>();

function DockviewPreviewPanel(props: IDockviewPanelProps) {
  const { t } = useTranslation('conversation');
  const params = (props.params ?? {}) as Partial<PreviewPanelParams>;
  const filePath = params.filePath ?? null;
  const displayPath = params.displayPath ?? null;
  const requestedMode = params.mode ?? 'editor';
  const [viewMode, setViewMode] = useState(requestedMode);
  const mode = viewMode;
  const diffViewMode = params.diffViewMode ?? 'split';
  const modifiedContentOverride = params.modifiedContent ?? null;
  const originalContentOverride = params.originalContent ?? null;
  const location = params.location ?? null;
  const rootPath = useFileTreeStore((state) => state.rootPath);
  const resolvedFilePath = useMemo(
    () => (filePath ? resolveFilePathFromRoot(filePath, rootPath) : null),
    [filePath, rootPath]
  );
  useEffect(() => {
    void preloadMonacoEditor();
  }, []);
  const [pluginResolution, setPluginResolution] = useState<{
    filePath: string;
    opener: ResolvedPluginFileOpener | null;
  } | null>(null);
  const pluginResolutionPending =
    Boolean(filePath) && pluginResolution?.filePath !== filePath;
  const pluginOpener =
    pluginResolution?.filePath === filePath ? pluginResolution.opener : null;
  useEffect(() => {
    let cancelled = false;
    if (!filePath) {
      setPluginResolution(null);
      return;
    }
    void pluginControlApi
      .resolveFileOpener(fileExtension(filePath))
      .then((resolved) => {
        if (!cancelled) {
          setPluginResolution({ filePath, opener: resolved });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPluginResolution({ filePath, opener: null });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [filePath]);
  const previewKind = useMemo(() => getFilePreviewKind(filePath), [filePath]);
  const shouldFetchFileContent =
    !pluginResolutionPending &&
    !pluginOpener &&
    previewKind === 'text' &&
    !(mode === 'diff' && modifiedContentOverride !== null);
  const shouldFetchHeadContent =
    !pluginResolutionPending &&
    !pluginOpener &&
    previewKind === 'text' &&
    !(mode === 'diff' && originalContentOverride !== null);

  const {
    data: content,
    isLoading,
    error: contentError,
  } = useFileContent(shouldFetchFileContent ? resolvedFilePath : null);
  const {
    data: headContent,
    isLoading: isLoadingHead,
    error: headError,
  } = useFileAtHead(
    mode === 'diff' && shouldFetchHeadContent ? resolvedFilePath : null
  );
  const saveFile = useSaveFile();
  const { resolvedTheme } = useTheme();
  const editorRef = useRef<monacoEditor.IStandaloneCodeEditor | null>(null);
  const readRangeDecorationRef = useRef<string[]>([]);
  const markdownPasteCleanupRef = useRef<(() => void) | null>(null);
  const markdownBasePathRef = useRef<string | null>(null);
  const queryClient = useQueryClient();
  const [isDirty, setIsDirty] = useState(false);
  const resolvedDisplayPath = useMemo(() => {
    if (!filePath) {
      return null;
    }

    return (
      displayPath ??
      deriveRelativeFilePath(filePath, rootPath) ??
      deriveRelativeFilePath(resolvedFilePath ?? filePath, rootPath) ??
      filePath
    );
  }, [displayPath, filePath, resolvedFilePath, rootPath]);

  const isMd = filePath ? isMarkdownFile(filePath) : false;
  // Relative image / link destinations inside a markdown file resolve against
  // the file's own directory (like GitHub), not the workspace root.
  const markdownBasePath = isMd
    ? resolvedFilePath
      ? dirnamePath(resolvedFilePath)
      : rootPath
    : null;
  markdownBasePathRef.current = markdownBasePath;
  const isDiffMode = mode === 'diff';
  const contentErrorMessage = useMemo(() => {
    if (!contentError) {
      return null;
    }
    return contentError instanceof Error
      ? contentError.message
      : String(contentError);
  }, [contentError]);
  const hasBinaryReadError = isBinaryContentError(contentError);
  const effectivePreviewKind =
    previewKind === 'text' && hasBinaryReadError ? 'binary' : previewKind;
  const shouldFetchBinaryAsset =
    mode !== 'diff' &&
    (effectivePreviewKind === 'image' || effectivePreviewKind === 'pdf');
  const modifiedContent = modifiedContentOverride ?? content ?? '';
  const originalContent =
    originalContentOverride ?? (headError ? '' : (headContent ?? ''));
  const {
    assetUrl: fileAssetSrc,
    isLoading: isLoadingBinaryAsset,
    error: binaryAssetError,
  } = useBinaryAssetPreview(shouldFetchBinaryAsset ? resolvedFilePath : null);
  const binaryAssetErrorMessage = useMemo(() => {
    if (!binaryAssetError) {
      return null;
    }
    return binaryAssetError instanceof Error
      ? binaryAssetError.message
      : String(binaryAssetError);
  }, [binaryAssetError]);

  const [isRendered, setIsRendered] = useState(() =>
    filePath ? (markdownRenderStateMap.get(filePath) ?? false) : false
  );
  const pathSegments = useMemo(
    () => (resolvedDisplayPath ? getPathSegments(resolvedDisplayPath) : []),
    [resolvedDisplayPath]
  );

  useEffect(() => {
    setViewMode(requestedMode);
  }, [filePath, requestedMode]);

  useEffect(() => {
    if (filePath) {
      setIsRendered(markdownRenderStateMap.get(filePath) ?? false);
    }
  }, [filePath]);

  useEffect(() => {
    if (filePath && isMd) {
      markdownRenderStateMap.set(filePath, isRendered);
    }
  }, [filePath, isMd, isRendered]);

  const handleMouseDown = useCallback(
    (event: React.MouseEvent) => {
      if (event.button === 1 && isMd && !isDiffMode) {
        event.preventDefault();
        setIsRendered((prev) => !prev);
      }
    },
    [isDiffMode, isMd]
  );

  const applyReadRange = useCallback(
    (editor: monacoEditor.IStandaloneCodeEditor) => {
      if (!location) {
        readRangeDecorationRef.current = editor.deltaDecorations(
          readRangeDecorationRef.current,
          []
        );
        return;
      }

      const endLine = location.endLine ?? location.line;
      editor.setPosition({
        lineNumber: location.line,
        column: location.column,
      });
      editor.revealLineInCenter(location.line);
      readRangeDecorationRef.current = editor.deltaDecorations(
        readRangeDecorationRef.current,
        [
          {
            range: {
              startLineNumber: location.line,
              startColumn: 1,
              endLineNumber: endLine,
              endColumn: 1,
            },
            options: {
              isWholeLine: true,
              className: 'preview-read-range',
              linesDecorationsClassName: 'preview-read-range-gutter',
            },
          },
        ]
      );
    },
    [location]
  );

  const handleEditorMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor;

      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        if (!resolvedFilePath) return;
        const currentValue = editor.getValue();
        saveFile.mutate(
          { path: resolvedFilePath, content: currentValue },
          {
            onSuccess: () => setIsDirty(false),
          }
        );
      });

      editor.onDidChangeModelContent(() => {
        setIsDirty(true);
      });

      if (isMd) {
        markdownPasteCleanupRef.current?.();
        markdownPasteCleanupRef.current = null;

        const domNode = editor.getDomNode();
        if (domNode) {
          const handlePaste = (event: ClipboardEvent) => {
            const files = extractImageFilesFromClipboardData(event.clipboardData);
            if (files.length === 0) return;
            // Only handled in the markdown source editor for the current file.
            const assetDir = markdownBasePathRef.current;
            const targetPath = resolvedFilePath;
            if (!assetDir || !targetPath) return;

            event.preventDefault();
            event.stopPropagation();

            void (async () => {
              try {
                const inserted = await insertPastedImagesAsMarkdown({
                  editor,
                  files,
                  assetDir,
                  readBase64: fileToBase64,
                  writeAsset: fileTreeApi.writePastedImageAsset,
                });
                if (inserted > 0) {
                  // Refresh the file tree so the new assets/ sibling appears.
                  queryClient.invalidateQueries({ queryKey: fileTreeKeys.all });
                }
              } catch (error) {
                console.error('Failed to paste image into markdown', error);
                toast.error(t('preview.pasteImageError'));
              }
            })();
          };

          domNode.addEventListener('paste', handlePaste, true);
          markdownPasteCleanupRef.current = () => {
            domNode.removeEventListener('paste', handlePaste, true);
          };
        }
      }

      if (location) {
        applyReadRange(editor);
        editor.focus();
      }
    },
    [
      applyReadRange,
      isMd,
      location,
      queryClient,
      resolvedFilePath,
      saveFile,
      t,
    ]
  );

  useEffect(() => {
    if (!editorRef.current) return;
    applyReadRange(editorRef.current);
  }, [applyReadRange, filePath]);

  // Tear down the markdown paste listener when the panel unmounts.
  useEffect(() => {
    return () => {
      markdownPasteCleanupRef.current?.();
      markdownPasteCleanupRef.current = null;
    };
  }, []);

  const handleEditorBeforeMount: BeforeMount = useCallback((monaco) => {
    defineAyuMonacoThemes(monaco);
  }, []);

  useEffect(() => {
    setIsDirty(false);
  }, [filePath, mode]);

  if (!filePath) {
    const imageSource =
      params.imageUrl ??
      (params.imagePreviewId
        ? resolveImagePreviewSource(params.imagePreviewId)
        : null);

    if (imageSource) {
      return (
        <div
          className="flex h-full w-full items-center justify-center overflow-auto bg-muted/10 p-4"
          data-panel="preview"
        >
          <ZoomableImagePreview
            src={imageSource}
            alt={displayPath ?? 'Image'}
            className="h-full w-full"
            viewportClassName="border border-border bg-background shadow-sm"
          />
        </div>
      );
    }

    if (params.imagePreviewId) {
      return (
        <div
          className="h-full w-full overflow-auto bg-background"
          data-panel="preview"
        >
          <PreviewPlaceholder
            icon={ImageIcon}
            title="Image preview expired"
            description="Open the image from the conversation again to restore this transient preview."
          />
        </div>
      );
    }

    return (
      <div
        className="h-full w-full overflow-auto bg-background"
        data-panel="preview"
      >
        <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
          <Eye className="h-8 w-8 opacity-40" />
          <div className="space-y-1 text-center">
            <p className="font-medium">Preview</p>
            <p className="text-xs">
              Select a file from the file tree to preview
            </p>
          </div>
        </div>
      </div>
    );
  }

  const language = getLanguageFromPath(filePath);
  const isDiffLoading =
    isDiffMode &&
    ((shouldFetchFileContent && isLoading) ||
      (shouldFetchHeadContent && isLoadingHead));
  const diffBadge = diffViewMode === 'inline' ? 'Inline Diff' : 'Split Diff';
  const diffSummary = headError
    ? modifiedContentOverride !== null
      ? 'New file vs message change'
      : 'New file vs working tree'
    : modifiedContentOverride !== null
      ? 'HEAD vs message change'
      : 'HEAD vs working tree';

  return (
    <div
      className="flex h-full w-full flex-col bg-background"
      data-panel="preview"
      onMouseDownCapture={handleMouseDown}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-background px-2 py-1 text-xs">
        <div
          className="scrollbar-thin flex min-w-0 flex-1 items-center overflow-x-auto whitespace-nowrap text-muted-foreground"
          title={resolvedDisplayPath ?? filePath}
        >
          {pathSegments.map((segment, index) => (
            <span key={`${segment}-${index}`} className="flex items-center">
              {index > 0 && (
                <span className="mx-1 text-muted-foreground/50">/</span>
              )}
              <span
                className={
                  index === pathSegments.length - 1 ? 'text-foreground/85' : ''
                }
              >
                {segment}
              </span>
            </span>
          ))}
          {!isDiffMode && isDirty && (
            <span className="ml-1 shrink-0 text-[hsl(var(--warning))]">*</span>
          )}
        </div>

        {pluginResolutionPending ? (
          <ContentLoadingFallback label="Loading file handler..." />
        ) : isDiffMode ? (
          <>
            <span className="flex select-none items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              <GitCompare className="h-3 w-3" />
              {diffBadge}
            </span>
            <span className="hidden text-[10px] text-muted-foreground md:inline">
              {diffSummary}
            </span>
            <button
              type="button"
              className="raised-control flex select-none items-center gap-1 px-1.5 py-0.5 text-[10px]"
              onClick={() => setViewMode('editor')}
            >
              <Code2 className="h-3 w-3" />
              {t('preview.switchToFileView')}
            </button>
          </>
        ) : requestedMode === 'diff' ? (
          <button
            type="button"
            className="raised-control flex select-none items-center gap-1 px-1.5 py-0.5 text-[10px]"
            onClick={() => setViewMode('diff')}
          >
            <GitCompare className="h-3 w-3" />
            {t('preview.switchToDiffView')}
          </button>
        ) : isMd && effectivePreviewKind === 'text' ? (
          <button
            className="raised-control flex select-none items-center gap-1 px-1.5 py-0.5 text-[10px]"
            title="Click to toggle preview"
            onClick={() => setIsRendered((prev) => !prev)}
          >
            {isRendered ? (
              <>
                <Eye className="h-3 w-3" />
                Preview
              </>
            ) : (
              <>
                <Code2 className="h-3 w-3" />
                Source
              </>
            )}
          </button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1">
        {pluginResolutionPending ? (
          <FilePreviewLoading
            fileName={resolvedDisplayPath ?? filePath}
            label={`Opening ${resolvedDisplayPath ?? filePath}`}
          />
        ) : isDiffMode ? (
          effectivePreviewKind === 'binary' ? (
            <PreviewPlaceholder
              icon={FileWarning}
              title="Binary diff is not supported here"
              description="This file cannot be rendered as a text diff in the preview panel."
            />
          ) : effectivePreviewKind === 'image' ? (
            <PreviewPlaceholder
              icon={ImageIcon}
              title="Image diff is not supported here"
              description="Open this asset in a dedicated image diff flow instead of the text preview panel."
            />
          ) : effectivePreviewKind === 'pdf' ? (
            <PreviewPlaceholder
              icon={FileText}
              title="PDF diff is not supported here"
              description="Open the PDF in read-only preview mode instead of the text diff panel."
            />
          ) : pluginOpener ? (
            <PreviewPlaceholder
              icon={FileText}
              title="Office document diff is not supported here"
              description="Open this document in read-only preview mode instead of the text diff panel."
            />
          ) : isDiffLoading ? (
            <FilePreviewLoading
              fileName={resolvedDisplayPath ?? filePath}
              label={`Loading diff for ${resolvedDisplayPath ?? filePath}`}
            />
          ) : (
            <div className="h-full min-h-0 overflow-auto">
              <Suspense
                fallback={
                  <FilePreviewLoading
                    fileName={resolvedDisplayPath ?? filePath}
                    label={`Loading diff for ${resolvedDisplayPath ?? filePath}`}
                  />
                }
              >
                <LazyFileContentView
                  content={modifiedContent}
                  originalContent={originalContent}
                  lang={language}
                  theme={resolvedTheme}
                  diffMode={diffViewMode === 'inline' ? 'unified' : 'split'}
                  emptyMessage="No differences against HEAD."
                  filePath={resolvedDisplayPath ?? undefined}
                  className="min-h-full"
                />
              </Suspense>
            </div>
          )
        ) : pluginOpener ? (
          pluginOpener.target === 'app_surface' ? (
            <PluginArtifactEditor
              key={`${pluginOpener.pluginId}:${pluginOpener.generation}:${resolvedFilePath ?? filePath}`}
              opener={pluginOpener}
              filePath={resolvedFilePath ?? filePath}
            />
          ) : (
            <PluginFilePreview
              key={`${pluginOpener.pluginId}:${pluginOpener.generation}:${resolvedFilePath ?? filePath}`}
              filePath={resolvedFilePath ?? filePath}
            />
          )
        ) : effectivePreviewKind === 'binary' ? (
          <PreviewPlaceholder
            icon={FileWarning}
            title="Binary file preview is not supported"
            description={
              contentErrorMessage ??
              'This asset cannot be opened as UTF-8 text in the editor preview.'
            }
          />
        ) : effectivePreviewKind === 'image' ? (
          isLoadingBinaryAsset ? (
            <FilePreviewLoading
              fileName={resolvedDisplayPath ?? filePath}
              label={`Opening ${resolvedDisplayPath ?? filePath}`}
            />
          ) : (
            <div className="flex h-full items-center justify-center overflow-auto bg-muted/10 p-4">
              {fileAssetSrc ? (
                <ZoomableImagePreview
                  src={fileAssetSrc}
                  alt={resolvedDisplayPath ?? filePath}
                  className="h-full w-full"
                  viewportClassName="border border-border bg-background shadow-sm"
                />
              ) : (
                <PreviewPlaceholder
                  icon={ImageIcon}
                  title="Image preview is unavailable"
                  description={
                    binaryAssetErrorMessage ??
                    'The image data could not be loaded for this file.'
                  }
                />
              )}
            </div>
          )
        ) : effectivePreviewKind === 'pdf' ? (
          isLoadingBinaryAsset ? (
            <FilePreviewLoading
              fileName={resolvedDisplayPath ?? filePath}
              label={`Opening ${resolvedDisplayPath ?? filePath}`}
            />
          ) : (
            <div className="h-full bg-muted/10 p-3">
              {fileAssetSrc ? (
                <object
                  data={fileAssetSrc}
                  type="application/pdf"
                  className="h-full w-full rounded-lg border border-border bg-background shadow-sm"
                >
                  <iframe
                    src={fileAssetSrc}
                    title={resolvedDisplayPath ?? filePath}
                    className="h-full w-full rounded-lg border border-border bg-background"
                  />
                </object>
              ) : (
                <PreviewPlaceholder
                  icon={FileText}
                  title="PDF preview is unavailable"
                  description={
                    binaryAssetErrorMessage ??
                    'The PDF data could not be loaded for this file.'
                  }
                />
              )}
            </div>
          )
        ) : isLoading ? (
          <FilePreviewLoading
            fileName={resolvedDisplayPath ?? filePath}
            label={`Opening ${resolvedDisplayPath ?? filePath}`}
          />
        ) : contentErrorMessage ? (
          <PreviewPlaceholder
            icon={FileWarning}
            title="File preview failed"
            description={contentErrorMessage}
          />
        ) : isMd && isRendered ? (
          <Suspense
            fallback={
              <FilePreviewLoading
                fileName={resolvedDisplayPath ?? filePath}
                label={`Opening ${resolvedDisplayPath ?? filePath}`}
              />
            }
          >
            <div className="h-full overflow-auto px-6 py-4">
              <LazyMarkdown
                value={content ?? ''}
                workspacePath={markdownBasePath}
              />
            </div>
          </Suspense>
        ) : (
          <Editor
            key={resolvedFilePath ?? filePath}
            defaultValue={content ?? ''}
            loading={
              <FilePreviewLoading
                fileName={resolvedDisplayPath ?? filePath}
                label={`Opening ${resolvedDisplayPath ?? filePath}`}
              />
            }
            language={language}
            theme={
              resolvedTheme === 'dark'
                ? MONACO_THEME_AYU_DARK
                : MONACO_THEME_AYU_LIGHT
            }
            beforeMount={handleEditorBeforeMount}
            onMount={handleEditorMount}
            options={{
              readOnly: false,
              minimap: { enabled: false },
              fontSize: 12,
              lineNumbers: 'on',
              wordWrap: 'on',
              scrollBeyondLastLine: false,
              automaticLayout: true,
              tabSize: 2,
              renderWhitespace: 'selection',
              bracketPairColorization: { enabled: true },
            }}
          />
        )}
      </div>
    </div>
  );
}

export default DockviewPreviewPanel;
