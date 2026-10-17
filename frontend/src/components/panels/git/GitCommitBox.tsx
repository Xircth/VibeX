import { memo, useCallback, useEffect, useRef } from 'react';
import { Sparkles } from 'lucide-react';
import { Button } from '@astryxdesign/core/Button';
import { ButtonGroup } from '@astryxdesign/core/ButtonGroup';
import type { GitFileStatusEntry, GitFileDiffEntry } from 'shared/types';
import { generateCommitMessage } from './generateCommitMessage';

interface GitCommitBoxProps {
  commitMessage: string;
  onCommitMessageChange: (msg: string) => void;
  hasStagedFiles: boolean;
  hasUnstagedFiles: boolean;
  stagedFiles?: GitFileStatusEntry[];
  diffs?: GitFileDiffEntry[];
  commitLoading: boolean;
  pushLoading: boolean;
  commitError: string | null;
  operationError: string | null;
  commitsAhead?: number;
  onCommit: () => void;
  onCommitAndPush: () => void;
  onPush?: () => void;
}

const SINGLE_ROW_LINE_HEIGHT = 18;
const MAX_COMMIT_INPUT_ROWS = 4;
const MAX_COMMIT_INPUT_HEIGHT = SINGLE_ROW_LINE_HEIGHT * MAX_COMMIT_INPUT_ROWS;

export const GitCommitBox = memo(function GitCommitBox({
  commitMessage,
  onCommitMessageChange,
  hasStagedFiles,
  hasUnstagedFiles,
  stagedFiles = [],
  diffs = [],
  commitLoading,
  pushLoading,
  commitError,
  operationError,
  commitsAhead = 0,
  onCommit,
  onCommitAndPush,
  onPush,
}: GitCommitBoxProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const hasMessage = commitMessage.trim().length > 0;
  const hasChanges = hasStagedFiles || hasUnstagedFiles;
  const canCommit = hasMessage && hasChanges && !commitLoading;

  const adjustTextareaHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.setProperty('height', 'auto', 'important');
    const naturalHeight = Math.max(
      textarea.scrollHeight,
      SINGLE_ROW_LINE_HEIGHT
    );
    const nextHeight = Math.min(naturalHeight, MAX_COMMIT_INPUT_HEIGHT);
    textarea.style.setProperty('height', `${nextHeight}px`, 'important');
    textarea.style.overflowY =
      naturalHeight > MAX_COMMIT_INPUT_HEIGHT ? 'auto' : 'hidden';
  }, []);

  useEffect(() => {
    adjustTextareaHeight();
  }, [adjustTextareaHeight, commitMessage]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (canCommit) {
          if (e.shiftKey) {
            onCommitAndPush();
          } else {
            onCommit();
          }
        }
      }
    },
    [canCommit, onCommit, onCommitAndPush]
  );

  const handleGenerateMessage = useCallback(() => {
    if (stagedFiles.length === 0) return;
    const msg = generateCommitMessage(stagedFiles, diffs);
    if (msg) {
      onCommitMessageChange(msg);
    }
  }, [stagedFiles, diffs, onCommitMessageChange]);

  return (
    <div className="flex flex-col gap-1.5 border-b border-border/50 p-2">
      {/* Commit message input with standard TextInput styling */}
      <div
        data-control-frame=""
        className="astryx-text-input flex min-h-7 w-full items-center gap-1 rounded-lg border border-input bg-background px-2.5 py-1 text-xs text-foreground shadow-none"
        onClick={() => textareaRef.current?.focus()}
      >
        <textarea
          ref={textareaRef}
          data-auto-resize=""
          className="bg-transparent min-w-0 flex-1 resize-none border-0 p-0 text-xs leading-[18px] text-foreground placeholder:text-muted-foreground focus:outline-none"
          placeholder="Commit message..."
          rows={1}
          value={commitMessage}
          onChange={(e) => onCommitMessageChange(e.target.value)}
          onInput={adjustTextareaHeight}
          onKeyDown={handleKeyDown}
        />
        {stagedFiles.length > 0 && (
          <button
            className="shrink-0 p-0.5 rounded text-muted-foreground hover:bg-[hsl(var(--warning)/0.1)] hover:text-[hsl(var(--warning))] transition-colors"
            onClick={(e) => {
              e.stopPropagation();
              handleGenerateMessage();
            }}
            title="Generate commit message from staged changes"
            type="button"
          >
            <Sparkles className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Error display */}
      {(commitError || operationError) && (
        <div className="text-[10px] text-destructive px-0.5">
          {commitError || operationError}
        </div>
      )}

      {/* Commit action group + Push button (wraps Push onto its own row unless container is wide enough) */}
      <div
        data-testid="git-commit-actions-row"
        className="flex flex-wrap items-center gap-1.5"
      >
        <ButtonGroup
          label="Commit actions"
          size="sm"
          className="min-w-[min(100%,180px)] grow shrink-0 basis-auto"
        >
          <Button
            label="Commit"
            variant="secondary"
            size="sm"
            className="grow shrink-0 basis-auto !px-2 !text-[11px]"
            isDisabled={!canCommit}
            isLoading={commitLoading}
            onClick={onCommit}
          />
          <Button
            label="Commit&Push"
            variant="secondary"
            size="sm"
            className="grow shrink-0 basis-auto !px-2 !text-[11px]"
            isDisabled={!canCommit || pushLoading}
            isLoading={pushLoading && canCommit}
            onClick={onCommitAndPush}
          />
        </ButtonGroup>

        <Button
          label={`Push ${commitsAhead} commits`}
          variant="primary"
          size="sm"
          className="min-w-[min(100%,120px)] grow shrink-0 basis-auto !px-2.5 !text-[11px]"
          isDisabled={commitsAhead <= 0 || pushLoading}
          isLoading={pushLoading && !canCommit}
          onClick={onPush}
        />
      </div>
    </div>
  );
});
