import type { RefObject } from 'react';
import type { ExecutorProfileId } from 'shared/types';
import type { BackendTransport } from '@/lib/backendTransport';
import type { AgentAvailableCommand } from '@/features/agents/types';
import type { AtReferenceMember } from '../composerAtReferences';

export type SessionComposerImage = {
  id: string;
  name: string;
  path: string;
  previewUrl?: string;
};

export type SessionComposerInputContext = {
  sessionId?: string;
  workspaceId?: string;
  workspacePath?: string;
  repoId?: string;
  repoIds?: string[];
  projectId?: string;
  executorProfile?: ExecutorProfileId | null;
  availableCommands?: AgentAvailableCommand[] | null;
  commandsLoading?: boolean;
  transport?: BackendTransport;
  spaceMembers?: AtReferenceMember[];
};

export type SessionComposerInputProps = {
  value: string;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
  promptSuggestion?: string | null;
  onAcceptPromptSuggestion?: (suggestion: string) => void;
  onDismissPromptSuggestion?: () => void;
  context?: SessionComposerInputContext;
  messageHistory?: readonly string[];
  acceptExternalInserts?: boolean;
  replaceValueRef?: RefObject<((next: string) => void) | null>;
  onChange: (value: string) => void;
  onSubmit: (value: string) => boolean | void;
  onAttachImages: (files: File[]) => void;
};
