// Global app dialogs
export { ReleaseNotesDialog } from './global/ReleaseNotesDialog';

// Project-related dialogs
export {
  ProjectFormDialog,
  type ProjectFormDialogProps,
  type ProjectFormDialogResult,
} from './projects/ProjectFormDialog';
export {
  ProjectEditorSelectionDialog,
  type ProjectEditorSelectionDialogProps,
} from './projects/ProjectEditorSelectionDialog';

// Workspace/session-related dialogs
export { CreatePRDialog } from './tasks/CreatePRDialog';
export {
  EditorSelectionDialog,
  type EditorSelectionDialogProps,
} from './tasks/EditorSelectionDialog';
export {
  TagEditDialog,
  type TagEditDialogProps,
  type TagEditResult,
} from './tasks/TagEditDialog';
export {
  ChangeTargetBranchDialog,
  type ChangeTargetBranchDialogProps,
  type ChangeTargetBranchDialogResult,
} from './tasks/ChangeTargetBranchDialog';
export {
  RebaseDialog,
  type RebaseDialogProps,
  type RebaseDialogResult,
} from './tasks/RebaseDialog';
export {
  RestoreLogsDialog,
  type RestoreLogsDialogProps,
  type RestoreLogsDialogResult,
} from './tasks/RestoreLogsDialog';
export {
  ViewProcessesDialog,
  type ViewProcessesDialogProps,
} from './tasks/ViewProcessesDialog';
export {
  GitActionsDialog,
  type GitActionsDialogProps,
} from './tasks/GitActionsDialog';
export {
  EditBranchNameDialog,
  type EditBranchNameDialogResult,
} from './tasks/EditBranchNameDialog';

// Auth dialogs
export { GhCliSetupDialog } from './auth/GhCliSetupDialog';

// Shared/Generic dialogs
export { ConfirmDialog, type ConfirmDialogProps } from './shared/ConfirmDialog';
export {
  ResendCheckpointDialog,
  type ResendCheckpointDialogProps,
  type ResendCheckpointResult,
} from './shared/ResendCheckpointDialog';
export {
  FolderPickerDialog,
  type FolderPickerDialogProps,
} from './shared/FolderPickerDialog';
