import type { TaskWithAttemptStatus, Workspace } from 'shared/types';
import type {
  ConfirmDialogProps,
  EditorSelectionDialogProps,
} from '@/components/dialogs';

// Type definitions for nice-modal-react modal arguments
declare module '@ebay/nice-modal-react' {
  interface ModalArgs {
    // Existing modals
    'create-pr': {
      attempt: Workspace;
      task: TaskWithAttemptStatus;
      projectId: string;
    };

    // Generic modals
    confirm: ConfirmDialogProps;

    // App flow modals
    disclaimer: void;
    onboarding: void;
    'release-notes': void;

    // Workspace/session-related modals
    'editor-selection': EditorSelectionDialogProps;
  }
}

export {};
