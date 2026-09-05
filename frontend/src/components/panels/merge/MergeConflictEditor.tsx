import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor, { DiffEditor, type BeforeMount } from '@monaco-editor/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { GitMerge, Loader2 } from 'lucide-react';
import { attemptsApi } from '@/lib/api';
import { useTheme } from '@/components/ThemeProvider';
import { Button } from '@/components/ui/button';
import { GitConflictResolutionDialog } from '@/components/dialogs/tasks/GitConflictResolutionDialog';
import {
  defineAyuMonacoThemes,
  MONACO_THEME_AYU_DARK,
  MONACO_THEME_AYU_LIGHT,
} from '@/utils/monacoThemes';
import { preloadMonacoEditor } from '@/lib/monacoPreload';
import type {
  ConflictFileDetail,
  MergePanelParams,
} from '@/types/mergeConflict';
import { applyConflictHunk, type HunkChoice } from './applyConflictHunk';

function languageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescriptreact',
    js: 'javascript',
    jsx: 'javascriptreact',
    json: 'json',
    rs: 'rust',
    md: 'markdown',
    py: 'python',
    go: 'go',
    yml: 'yaml',
    yaml: 'yaml',
    toml: 'toml',
  };
  return map[ext] ?? 'plaintext';
}

function stageText(stage: ConflictFileDetail['base']): {
  value: string;
  missing: boolean;
} {
  if (!stage.present) return { value: '', missing: true };
  return { value: stage.content ?? '', missing: false };
}

export function MergeConflictEditor({
  workspaceId,
  repoId,
  filePath,
  onDirtyChange,
}: MergePanelParams & { onDirtyChange?: (dirty: boolean) => void }) {
  const { resolvedTheme } = useTheme();
  const queryClient = useQueryClient();
  const monacoTheme =
    resolvedTheme === 'dark' ? MONACO_THEME_AYU_DARK : MONACO_THEME_AYU_LIGHT;
  const language = languageFromPath(filePath);
  const [result, setResult] = useState('');
  const [savedResult, setSavedResult] = useState('');
  const [saving, setSaving] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const seededPath = useRef<string | null>(null);

  const query = useQuery({
    queryKey: ['conflictFile', workspaceId, repoId, filePath],
    queryFn: () => attemptsApi.getConflictFile(workspaceId, repoId, filePath),
    enabled: Boolean(workspaceId && repoId && filePath),
  });

  useEffect(() => {
    void preloadMonacoEditor();
  }, []);

  useEffect(() => {
    if (!query.data) return;
    if (seededPath.current === filePath) return;
    seededPath.current = filePath;
    setResult(query.data.result);
    setSavedResult(query.data.result);
  }, [filePath, query.data]);

  const dirty = result !== savedResult;
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const handleBeforeMount: BeforeMount = useCallback((monaco) => {
    defineAyuMonacoThemes(monaco);
  }, []);

  const detail = query.data;
  const base = useMemo(
    () => (detail ? stageText(detail.base) : { value: '', missing: false }),
    [detail]
  );
  const ours = useMemo(
    () => (detail ? stageText(detail.ours) : { value: '', missing: false }),
    [detail]
  );
  const theirs = useMemo(
    () => (detail ? stageText(detail.theirs) : { value: '', missing: false }),
    [detail]
  );

  const takeWhole = (side: 'ours' | 'theirs') => {
    const source = side === 'ours' ? ours : theirs;
    if (source.missing) return;
    setResult(source.value);
  };

  const takeHunk = (index: number, choice: HunkChoice) => {
    if (!detail) return;
    setResult((current) =>
      applyConflictHunk(current, detail.hunks, index, choice)
    );
  };

  const save = async () => {
    setSaving(true);
    setWriteError(null);
    try {
      await attemptsApi.writeConflictResolution(
        workspaceId,
        repoId,
        filePath,
        result
      );
      setSavedResult(result);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['conflictFile', workspaceId, repoId, filePath],
        }),
        queryClient.invalidateQueries({
          queryKey: ['branchStatus', workspaceId],
        }),
      ]);
    } catch (error) {
      setWriteError(error instanceof Error ? error.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const askAgent = () => {
    if (!detail) return;
    void GitConflictResolutionDialog.show({
      workspaceId,
      sourceBranch: null,
      targetBranch: '',
      conflictedFiles: [filePath],
      fileDetail: detail,
    });
  };

  if (query.isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    );
  }

  if (query.error || !detail) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-sm text-destructive">
        {query.error instanceof Error
          ? query.error.message
          : 'Could not load this conflict'}
      </div>
    );
  }

  if (detail.is_binary) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-sm">
        <GitMerge className="h-6 w-6 text-muted-foreground" />
        <p>Binary conflict. Choose one side.</p>
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={ours.missing}
            onClick={() => takeWhole('ours')}
          >
            Take ours
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={theirs.missing}
            onClick={() => takeWhole('theirs')}
          >
            Take theirs
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
        {writeError ? <p className="text-destructive">{writeError}</p> : null}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/40 px-3 py-1.5">
        <span className="truncate font-mono text-xs">{filePath}</span>
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={askAgent}>
          Ask agent
        </Button>
        <Button
          size="sm"
          onClick={() => void save()}
          disabled={saving || !dirty}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
      {writeError ? (
        <div className="shrink-0 px-3 py-1 text-xs text-destructive">
          {writeError}
        </div>
      ) : null}
      <div className="grid min-h-0 flex-1 grid-cols-2 gap-px bg-border/40">
        <StageDiff
          title="Ours"
          missing={ours.missing || base.missing}
          original={base.value}
          modified={ours.value}
          language={language}
          theme={monacoTheme}
          onBeforeMount={handleBeforeMount}
        />
        <StageDiff
          title="Theirs"
          missing={theirs.missing || base.missing}
          original={base.value}
          modified={theirs.value}
          language={language}
          theme={monacoTheme}
          onBeforeMount={handleBeforeMount}
        />
      </div>
      {detail.hunks.length > 0 ? (
        <div className="flex shrink-0 flex-wrap gap-1.5 border-t border-border/40 px-3 py-1.5">
          {detail.hunks.map((hunk) => (
            <div
              key={hunk.index}
              className="flex items-center gap-1 text-[11px]"
            >
              <span className="text-muted-foreground">#{hunk.index + 1}</span>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-1.5"
                onClick={() => takeHunk(hunk.index, 'ours')}
              >
                Ours
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-1.5"
                onClick={() => takeHunk(hunk.index, 'theirs')}
              >
                Theirs
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-1.5"
                onClick={() => takeHunk(hunk.index, 'both')}
              >
                Both
              </Button>
            </div>
          ))}
        </div>
      ) : null}
      <div className="min-h-0 flex-[1.1] border-t border-border/40">
        <div className="px-3 py-1 text-[11px] text-muted-foreground">
          Result
        </div>
        <Editor
          height="calc(100% - 24px)"
          language={language}
          theme={monacoTheme}
          value={result}
          onChange={(value) => setResult(value ?? '')}
          beforeMount={handleBeforeMount}
          options={{
            minimap: { enabled: false },
            fontSize: 12,
            wordWrap: 'on',
            scrollBeyondLastLine: false,
          }}
        />
      </div>
    </div>
  );
}

function StageDiff({
  title,
  missing,
  original,
  modified,
  language,
  theme,
  onBeforeMount,
}: {
  title: string;
  missing: boolean;
  original: string;
  modified: string;
  language: string;
  theme: string;
  onBeforeMount: BeforeMount;
}) {
  return (
    <div className="flex min-h-0 flex-col bg-background">
      <div className="px-3 py-1 text-[11px] text-muted-foreground">{title}</div>
      {missing ? (
        <div className="flex flex-1 items-center justify-center px-4 text-xs text-muted-foreground">
          This side is missing
        </div>
      ) : (
        <DiffEditor
          height="100%"
          language={language}
          theme={theme}
          original={original}
          modified={modified}
          beforeMount={onBeforeMount}
          options={{
            readOnly: true,
            renderSideBySide: true,
            minimap: { enabled: false },
            fontSize: 12,
            wordWrap: 'on',
            scrollBeyondLastLine: false,
          }}
        />
      )}
    </div>
  );
}
