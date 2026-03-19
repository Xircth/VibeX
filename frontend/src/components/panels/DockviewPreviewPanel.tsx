import { useCallback, useEffect, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type { editor as monacoEditor } from 'monaco-editor';
import { Eye, Code2, GitCompare, Save } from 'lucide-react';
import {
  useFileAtHead,
  useFileContent,
  useSaveFile,
} from '@/hooks/useFileContent';
import { Markdown } from '@/components/NormalizedConversation/Markdown';
import FileContentView from '@/components/NormalizedConversation/FileContentView';
import { useTheme } from '@/components/ThemeProvider';
import type { PreviewPanelParams } from '@/types/panels';

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

/** Persist markdown render state across tab switches (keyed by filePath). */
const markdownRenderStateMap = new Map<string, boolean>();

/**
 * DockviewPreviewPanel - file preview/editor panel with optional inline diff mode.
 */
function DockviewPreviewPanel(props: IDockviewPanelProps) {
  const params = (props.params ?? {}) as Partial<PreviewPanelParams>;
  const filePath = params.filePath ?? null;
  const mode = params.mode ?? 'editor';
  const diffViewMode = params.diffViewMode ?? 'split';
  const modifiedContentOverride = params.modifiedContent ?? null;

  const { data: content, isLoading } = useFileContent(filePath);
  const {
    data: headContent,
    isLoading: isLoadingHead,
    error: headError,
  } = useFileAtHead(mode === 'diff' ? filePath : null);
  const saveFile = useSaveFile();
  const { resolvedTheme } = useTheme();
  const editorRef = useRef<monacoEditor.IStandaloneCodeEditor | null>(null);
  const [isDirty, setIsDirty] = useState(false);

  const isMd = filePath ? isMarkdownFile(filePath) : false;
  const isDiffMode = mode === 'diff';
  const modifiedContent = modifiedContentOverride ?? content ?? '';
  const originalContent = headError ? '' : (headContent ?? '');

  const [isRendered, setIsRendered] = useState(() =>
    filePath ? (markdownRenderStateMap.get(filePath) ?? false) : false
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
        if (!filePath) return;
        const currentValue = editor.getValue();
        saveFile.mutate(
          { path: filePath, content: currentValue },
          {
            onSuccess: () => setIsDirty(false),
          }
        );
      });

      editor.onDidChangeModelContent(() => {
        setIsDirty(true);
      });
    },
    [filePath, saveFile]
  );

  useEffect(() => {
    setIsDirty(false);
  }, [filePath, mode]);

  const handleSave = useCallback(() => {
    if (!filePath || !editorRef.current) return;
    const currentValue = editorRef.current.getValue();
    saveFile.mutate(
      { path: filePath, content: currentValue },
      {
        onSuccess: () => setIsDirty(false),
      }
    );
  }, [filePath, saveFile]);

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

  const fileName = filePath.split(/[/\\]/).pop() || filePath;
  const language = getLanguageFromPath(filePath);
  const isDiffLoading = isDiffMode && (isLoading || isLoadingHead);
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
        <span
          className="truncate text-muted-foreground flex-1"
          title={filePath}
        >
          {fileName}
          {!isDiffMode && isDirty && (
            <span className="ml-1 text-yellow-400">*</span>
          )}
        </span>

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
              <span
                className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-muted-foreground bg-muted rounded select-none"
                title="Middle-click to toggle"
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
              </span>
            )}
            {(!isMd || !isRendered) && (
              <button
                className="flex items-center gap-1 px-2 py-0.5 text-xs hover:bg-accent rounded transition-colors disabled:opacity-40"
                onClick={handleSave}
                disabled={!isDirty || saveFile.isPending}
                title="Save (Ctrl+S)"
              >
                <Save className="w-3 h-3" />
                {saveFile.isPending ? 'Saving...' : 'Save'}
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
              <FileContentView
                content={modifiedContent}
                originalContent={originalContent}
                lang={language}
                theme={resolvedTheme}
                diffMode={diffViewMode === 'inline' ? 'unified' : 'split'}
                emptyMessage="No differences against HEAD."
                className="h-full"
              />
            </div>
          )
        ) : isLoading ? (
          <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
            Loading file...
          </div>
        ) : isMd && isRendered ? (
          <div className="h-full overflow-auto px-6 py-4">
            <Markdown value={content ?? ''} />
          </div>
        ) : (
          <Editor
            key={filePath}
            defaultValue={content ?? ''}
            language={language}
            theme={resolvedTheme === 'dark' ? 'vs-dark' : 'vs'}
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
