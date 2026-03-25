import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useRef,
  useState,
  useMemo,
} from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import Editor, { type BeforeMount, type OnMount } from '@monaco-editor/react';
import type { editor as monacoEditor } from 'monaco-editor';
import { Eye, Code2, GitCompare } from 'lucide-react';
import {
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

const LazyMarkdown = lazy(
  () => import('@/components/NormalizedConversation/Markdown')
);
const LazyFileContentView = lazy(
  () => import('@/components/NormalizedConversation/FileContentView')
);

/**
 * Map file extension to Monaco language identifier.
 */
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

/**
 * Check if a file path points to a Markdown file.
 */
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

function ContentLoadingFallback({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
      {label}
    </div>
  );
}

/** Persist markdown render state across tab switches (keyed by filePath). */
const markdownRenderStateMap = new Map<string, boolean>();

/**
 * DockviewPreviewPanel - file preview/editor panel with optional inline diff mode.
 */
function DockviewPreviewPanel(props: IDockviewPanelProps) {
  const params = (props.params ?? {}) as Partial<PreviewPanelParams>;
  const filePath = params.filePath ?? null;
  const displayPath = params.displayPath ?? null;
  const mode = params.mode ?? 'editor';
  const diffViewMode = params.diffViewMode ?? 'split';
  const modifiedContentOverride = params.modifiedContent ?? null;
  const originalContentOverride = params.originalContent ?? null;
  const rootPath = useFileTreeStore((state) => state.rootPath);
  const resolvedFilePath = useMemo(
    () => (filePath ? resolveFilePathFromRoot(filePath, rootPath) : null),
    [filePath, rootPath]
  );
  const shouldFetchFileContent = !(
    mode === 'diff' && modifiedContentOverride !== null
  );
  const shouldFetchHeadContent = !(
    mode === 'diff' && originalContentOverride !== null
  );

  const { data: content, isLoading } = useFileContent(
    shouldFetchFileContent ? resolvedFilePath : null
  );
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
  const modifiedContent = modifiedContentOverride ?? content ?? '';
  const originalContent =
    originalContentOverride ?? (headError ? '' : (headContent ?? ''));

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
    },
    [resolvedFilePath, saveFile]
  );

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
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground text-sm gap-3">
          <Eye className="h-8 w-8 opacity-40" />
          <div className="text-center space-y-1">
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
      className="h-full w-full flex flex-col bg-background"
      data-panel="preview"
      onMouseDown={handleMouseDown}
    >
      <div className="flex items-center gap-2 px-2 py-1 border-b border-border text-xs shrink-0 bg-background">
        <div
          className="flex min-w-0 flex-1 items-center overflow-x-auto whitespace-nowrap text-muted-foreground scrollbar-thin"
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
            <span className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-muted-foreground bg-muted rounded select-none">
              <GitCompare className="w-3 h-3" />
              {diffBadge}
            </span>
            <span className="hidden md:inline text-[10px] text-muted-foreground">
              {diffSummary}
            </span>
          </>
        ) : (
          <>
            {isMd && (
              <button
                className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-muted-foreground bg-muted rounded select-none hover:bg-accent hover:text-foreground transition-colors"
                title="Click to toggle preview"
                onClick={() => setIsRendered((prev) => !prev)}
              >
                {isRendered ? (
                  <>
                    <Eye className="w-3 h-3" />
                    Preview
                  </>
                ) : (
                  <>
                    <Code2 className="w-3 h-3" />
                    Source
                  </>
                )}
              </button>
            )}
          </>
        )}
      </div>

      <div className="flex-1 min-h-0">
        {isDiffMode ? (
          isDiffLoading ? (
            <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
              Loading diff...
            </div>
          ) : (
            <div className="h-full overflow-auto">
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
                  className="h-full"
                />
              </Suspense>
            </div>
          )
        ) : isLoading ? (
          <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
            Loading file...
          </div>
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
