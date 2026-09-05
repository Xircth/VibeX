export type {
  ConflictFileDetail,
  ConflictHunk,
  ConflictStageContent,
  WriteConflictResolutionResult,
} from 'shared/types';

export type MergePanelParams = {
  workspaceId: string;
  repoId: string;
  filePath: string;
};
