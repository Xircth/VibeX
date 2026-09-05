import { useEffect } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { MergeConflictEditor } from './merge/MergeConflictEditor';
import { setMergePanelDirty } from './merge/mergePanelDirty';
import type { MergePanelParams } from '@/types/mergeConflict';

function asMergeParams(params: unknown): MergePanelParams | null {
  if (!params || typeof params !== 'object') return null;
  const value = params as Partial<MergePanelParams>;
  if (!value.workspaceId || !value.repoId || !value.filePath) return null;
  return {
    workspaceId: value.workspaceId,
    repoId: value.repoId,
    filePath: value.filePath,
  };
}

function DockviewMergePanel({ api, params }: IDockviewPanelProps) {
  const mergeParams = asMergeParams(params);

  useEffect(() => {
    return () => setMergePanelDirty(api.id, false);
  }, [api.id]);

  if (!mergeParams) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Select a conflicted file
      </div>
    );
  }

  return (
    <MergeConflictEditor
      {...mergeParams}
      onDirtyChange={(dirty) => setMergePanelDirty(api.id, dirty)}
    />
  );
}

export default DockviewMergePanel;
