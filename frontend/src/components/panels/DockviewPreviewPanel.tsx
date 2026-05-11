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
  useDocumentPreview,
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

const LazyMarkdown = lazy(
  () => import('@/components/NormalizedConversation/Markdown')
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

function getPathSegments(filePath: string): string[] {
  return filePath
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment.length > 0);
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

function ReadonlyDocumentPreview({
  content,
  format,
}: {
  content: string;
  format: 'text' | 'html';
}) {
  return (
    <div className="h-full overflow-auto bg-muted/10 px-4 py-5">
      <div className="mx-auto flex max-w-4xl flex-col gap-4">
        <div className="rounded-lg border border-border bg-background/90 px-4 py-2 text-xs text-muted-foreground shadow-sm">
          本预览仅针对内容，无法完全保留原格式
        </div>
        <div className="rounded-xl border border-border bg-background p-6 shadow-sm">
          {content.trim().length > 0 ? (
            format === 'html' ? (
              <div
                className="doc-preview-html text-foreground"
                dangerouslySetInnerHTML={{ __html: content }}
              />
            ) : (
              <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-7 text-foreground">
                {content}
              </pre>
            )
          ) : (
            <p className="text-sm text-muted-foreground">
              This document does not contain previewable text content.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

const markdownRenderStateMap = new Map<string, boolean>();

function DockviewPreviewPanel(props: IDockviewPanelProps) {
  const params = (props.params ?? {}) as Partial<PreviewPanelParams>;
  const filePath = params.filePath ?? null;
  const displayPath = params.displayPath ?? null;
  const mode = params.mode ?? 'editor';
  const diffViewMode = params.diffViewMode ?? 'split';
  const modifiedContentOverride = params.modifiedContent ?? null;
  const originalContentOverride = params.originalContent ?? null;
  const location = params.location ?? null;
  const rootPath = useFileTreeStore((state) => state.rootPath);
  const resolvedFilePath = useMemo(
    () => (filePath ? resolveFilePathFromRoot(filePath, rootPath) : null),
    [filePath, rootPath]
  );
  const previewKind = useMemo(() => getFilePreviewKind(filePath), [filePath]);
  const shouldFetchFileContent =
    previewKind === 'text' &&
    !(mode === 'diff' && modifiedContentOverride !== null);
  const shouldFetchHeadContent =
    previewKind === 'text' &&
    !(mode === 'diff' && originalContentOverride !== null);
  const shouldFetchDocumentPreview =
    previewKind === 'document' && mode !== 'diff';

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
  const {
    data: documentPreview,
    isLoading: isLoadingDocumentPreview,
    error: documentPreviewError,
  } = useDocumentPreview(shouldFetchDocumentPreview ? resolvedFilePath : null);
  const saveFile = useSaveFile();
  const { resolvedTheme } = useTheme();
  const editorRef = useRef<monacoEditor.IStandaloneCodeEditor | null>(null);
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
  const isDiffMode = mode === 'diff';
  const contentErrorMessage = useMemo(() => {
    if (!contentError) {
      return null;
    }
    return contentError instanceof Error
      ? contentError.message
      : String(contentError);
  }, [contentError]);
  const documentPreviewErrorMessage = useMemo(() => {
    if (!documentPreviewError) {
      return null;
    }
    return documentPreviewError instanceof Error
      ? documentPreviewError.message
      : String(documentPreviewError);
  }, [documentPreviewError]);
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

      if (location) {
        editor.setPosition({
          lineNumber: location.line,
          column: location.column,
        });
        editor.revealLineInCenter(location.line);
        editor.focus();
      }
    },
    [location, resolvedFilePath, saveFile]
  );

  useEffect(() => {
    if (!location || !editorRef.current) return;

    editorRef.current.setPosition({
      lineNumber: location.line,
      column: location.column,
    });
    editorRef.current.revealLineInCenter(location.line);
  }, [filePath, location]);

  const handleEditorBeforeMount: BeforeMount = useCallback((monaco) => {
    defineAyuMonacoThemes(monaco);
  }, []);

  useEffect(() => {
    setIsDirty(false);
  }, [filePath, mode]);

  if (!filePath) {
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
      onMouseDown={handleMouseDown}
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
            <span className="ml-1 shrink-0 text-yellow-400">*</span>
          )}
        </div>

        {isDiffMode ? (
          <>
            <span className="flex select-none items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              <GitCompare className="h-3 w-3" />
              {diffBadge}
            </span>
            <span className="hidden text-[10px] text-muted-foreground md:inline">
              {diffSummary}
            </span>
          </>
        ) : isMd && effectivePreviewKind === 'text' ? (
          <button
            className="flex select-none items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
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
        {isDiffMode ? (
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
          ) : effectivePreviewKind === 'document' ? (
            <PreviewPlaceholder
              icon={FileText}
              title="Word document diff is not supported here"
              description="Open this document in read-only preview mode instead of the text diff panel."
            />
          ) : isDiffLoading ? (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              Loading diff...
            </div>
          ) : (
            <div className="h-full min-h-0 overflow-auto">
              <Suspense
                fallback={<ContentLoadingFallback label="Loading diff..." />}
              >
                <LazyFileContentView
                  content={modifiedContent}
                  originalContent={originalContent}
                  lang={language}
                  theme={resolvedTheme}
                  diffMode={diffViewMode === 'inline' ? 'unified' : 'split'}
                  emptyMessage="No differences against HEAD."
                  className="min-h-full"
                />
              </Suspense>
            </div>
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
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              Loading image preview...
            </div>
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
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              Loading PDF preview...
            </div>
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
        ) : effectivePreviewKind === 'document' ? (
          isLoadingDocumentPreview ? (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              Loading document preview...
            </div>
          ) : documentPreviewErrorMessage ? (
            <PreviewPlaceholder
              icon={FileText}
              title="Document preview failed"
              description={documentPreviewErrorMessage}
            />
          ) : (
            <ReadonlyDocumentPreview
              content={documentPreview?.content ?? ''}
              format={documentPreview?.format ?? 'text'}
            />
          )
        ) : isLoading ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            Loading file...
          </div>
        ) : contentErrorMessage ? (
          <PreviewPlaceholder
            icon={FileWarning}
            title="File preview failed"
            description={contentErrorMessage}
          />
        ) : isMd && isRendered ? (
          <Suspense
            fallback={<ContentLoadingFallback label="Loading preview..." />}
          >
            <div className="h-full overflow-auto px-6 py-4">
              <LazyMarkdown value={content ?? ''} />
            </div>
          </Suspense>
        ) : (
          <Editor
            key={resolvedFilePath ?? filePath}
            defaultValue={content ?? ''}
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
