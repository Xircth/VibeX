import { useCallback, useEffect, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type { editor as monacoEditor } from 'monaco-editor';
import { Eye, Save } from 'lucide-react';
import { useFileContent, useSaveFile } from '@/hooks/useFileContent';

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
 * DockviewPreviewPanel - Monaco Editor panel for viewing/editing files.
 *
 * Reads file path from panel params.filePath and displays it in Monaco Editor.
 * Supports Ctrl+S to save changes back to disk.
 * Each file gets its own panel instance (VSCode-like multi-tab behavior).
 */
function DockviewPreviewPanel(props: IDockviewPanelProps) {
  const filePath = (props.params?.filePath as string) || null;
  const { data: content, isLoading } = useFileContent(filePath);
  const saveFile = useSaveFile();
  const editorRef = useRef<monacoEditor.IStandaloneCodeEditor | null>(null);
  const [isDirty, setIsDirty] = useState(false);

  const handleEditorMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor;

      // Register Ctrl+S keybinding
      editor.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
        () => {
          if (!filePath) return;
          const currentValue = editor.getValue();
          saveFile.mutate(
            { path: filePath, content: currentValue },
            {
              onSuccess: () => setIsDirty(false),
            }
          );
        }
      );

      // Track dirty state
      editor.onDidChangeModelContent(() => {
        setIsDirty(true);
      });
    },
    [filePath, saveFile]
  );

  // Reset dirty state when file changes
  useEffect(() => {
    setIsDirty(false);
  }, [filePath]);

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

  // No file path provided
  if (!filePath) {
    return (
      <div className="h-full w-full overflow-auto bg-background" data-panel="preview">
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground text-sm gap-3">
          <Eye className="h-8 w-8 opacity-40" />
          <div className="text-center space-y-1">
            <p className="font-medium">Preview</p>
            <p className="text-xs">Select a file from the file tree to preview</p>
          </div>
        </div>
      </div>
    );
  }

  const fileName = filePath.split(/[/\\]/).pop() || filePath;
  const language = getLanguageFromPath(filePath);

  return (
    <div className="h-full w-full flex flex-col bg-background" data-panel="preview">
      {/* Header bar */}
      <div className="flex items-center gap-2 px-2 py-1 border-b border-border text-xs shrink-0 bg-background">
        <span className="truncate text-muted-foreground flex-1" title={filePath}>
          {fileName}
          {isDirty && <span className="ml-1 text-yellow-400">*</span>}
        </span>
        <button
          className="flex items-center gap-1 px-2 py-0.5 text-xs hover:bg-accent rounded transition-colors disabled:opacity-40"
          onClick={handleSave}
          disabled={!isDirty || saveFile.isPending}
          title="Save (Ctrl+S)"
        >
          <Save className="w-3 h-3" />
          {saveFile.isPending ? 'Saving...' : 'Save'}
        </button>
      </div>

      {/* Editor */}
      <div className="flex-1 min-h-0">
        {isLoading ? (
          <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
            Loading file...
          </div>
        ) : (
          <Editor
            key={filePath}
            defaultValue={content ?? ''}
            language={language}
            theme="vs"
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
