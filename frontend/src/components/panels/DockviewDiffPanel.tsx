import type { IDockviewPanelProps } from 'dockview-react';
import { DiffEditor } from '@monaco-editor/react';
import { GitCompare } from 'lucide-react';
import { useFileTreeStore } from '@/stores/useFileTreeStore';
import { useFileContent, useFileAtHead } from '@/hooks/useFileContent';

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
function DockviewDiffPanel(_props: IDockviewPanelProps) {
  const { diffFilePath } = useFileTreeStore();
  const { data: currentContent, isLoading: isLoadingCurrent } = useFileContent(diffFilePath);
  const { data: headContent, isLoading: isLoadingHead, error: headError } = useFileAtHead(diffFilePath);

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
  const isLoading = isLoadingCurrent || isLoadingHead;

  // HEAD content: fallback to empty string if file is new (not in HEAD)
  const originalContent = headError ? '' : (headContent ?? '');
  const modifiedContent = currentContent ?? '';

  return (
    <div className="h-full w-full flex flex-col" data-panel="diffs">
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
      <div className="flex-1 min-h-0">
        {isLoading ? (
          <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
            Loading diff...
          </div>
        ) : (
          <DiffEditor
            original={originalContent}
            modified={modifiedContent}
            language={language}
            theme="vs-dark"
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
