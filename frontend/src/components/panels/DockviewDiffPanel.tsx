import { DiffEditor, type BeforeMount } from '@monaco-editor/react';
import { useCallback } from 'react';
import { FileWarning, GitCompare, Image as ImageIcon } from 'lucide-react';
import { useFileTreeStore } from '@/stores/useFileTreeStore';
import { useFileContent, useFileAtHead } from '@/hooks/useFileContent';
import { useTheme } from '@/components/ThemeProvider';
import {
  defineAyuMonacoThemes,
  MONACO_THEME_AYU_DARK,
  MONACO_THEME_AYU_LIGHT,
} from '@/utils/monacoThemes';
import {
  getFilePreviewKind,
  isBinaryContentError,
} from '@/utils/filePreviewKind';

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
  };
  return langMap[ext] || 'plaintext';
}

/**
 * DockviewDiffPanel - Monaco Diff Editor for comparing HEAD vs working copy.
 *
 * Shows a side-by-side diff of the file at HEAD (original) vs current working copy (modified).
 * Read-only - modifications should be done in the Preview panel.
 */
function DockviewDiffPanel() {
  const { diffFilePath } = useFileTreeStore();
  const { resolvedTheme } = useTheme();
  const previewKind = getFilePreviewKind(diffFilePath);
  const shouldFetchTextDiff = previewKind === 'text';
  const {
    data: currentContent,
    isLoading: isLoadingCurrent,
    error: currentContentError,
  } = useFileContent(shouldFetchTextDiff ? diffFilePath : null);
  const {
    data: headContent,
    isLoading: isLoadingHead,
    error: headError,
  } = useFileAtHead(shouldFetchTextDiff ? diffFilePath : null);

  const handleDiffBeforeMount: BeforeMount = useCallback((monaco) => {
    defineAyuMonacoThemes(monaco);
  }, []);

  // No file selected for diff
  if (!diffFilePath) {
    return (
      <div className="h-full w-full overflow-auto" data-panel="diffs">
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground text-sm gap-3">
          <GitCompare className="h-8 w-8 opacity-40" />
          <div className="text-center space-y-1">
            <p className="font-medium">Diffs</p>
            <p className="text-xs">
              Double-click a modified file in the file tree to view diff
            </p>
          </div>
        </div>
      </div>
    );
  }

  const fileName = diffFilePath.split(/[/\\]/).pop() || diffFilePath;
  const language = getLanguageFromPath(diffFilePath);
  const effectivePreviewKind =
    previewKind === 'text' && isBinaryContentError(currentContentError)
      ? 'binary'
      : previewKind;
  const isLoading = isLoadingCurrent || isLoadingHead;

  // HEAD content: fallback to empty string if file is new (not in HEAD)
  const originalContent = headError ? '' : (headContent ?? '');
  const modifiedContent = currentContent ?? '';

  return (
    <div className="flex h-full min-h-0 w-full flex-col" data-panel="diffs">
      {/* Header */}
      <div className="flex items-center gap-2 px-2 py-1 border-b border-white/10 text-xs text-muted-foreground shrink-0">
        <GitCompare className="w-3 h-3 shrink-0" />
        <span className="truncate" title={diffFilePath}>
          {fileName}
        </span>
        <span className="ml-auto opacity-60">
          {headError ? 'New file (no HEAD version)' : 'HEAD vs Working Copy'}
        </span>
      </div>

      {/* Diff Editor */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {effectivePreviewKind === 'binary' ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
            <FileWarning className="h-10 w-10 opacity-50" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">
                Binary diff is not supported
              </p>
              <p className="text-xs">
                This file cannot be rendered as UTF-8 text in the diff panel.
              </p>
            </div>
          </div>
        ) : effectivePreviewKind === 'image' ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
            <ImageIcon className="h-10 w-10 opacity-50" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">
                Image diff is not supported here
              </p>
              <p className="text-xs">
                Open this asset in a dedicated image diff flow instead.
              </p>
            </div>
          </div>
        ) : effectivePreviewKind === 'pdf' ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
            <FileWarning className="h-10 w-10 opacity-50" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">
                PDF diff is not supported here
              </p>
              <p className="text-xs">
                Open this asset in read-only preview mode instead.
              </p>
            </div>
          </div>
        ) : isLoading ? (
          <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
            Loading diff...
          </div>
        ) : (
          <DiffEditor
            height="100%"
            original={originalContent}
            modified={modifiedContent}
            language={language}
            theme={
              resolvedTheme === 'dark'
                ? MONACO_THEME_AYU_DARK
                : MONACO_THEME_AYU_LIGHT
            }
            beforeMount={handleDiffBeforeMount}
            options={{
              readOnly: true,
              renderSideBySide: true,
              minimap: { enabled: false },
              fontSize: 12,
              lineNumbers: 'on',
              scrollBeyondLastLine: false,
              automaticLayout: true,
              renderOverviewRuler: false,
              diffWordWrap: 'on',
            }}
          />
        )}
      </div>
    </div>
  );
}

export default DockviewDiffPanel;
