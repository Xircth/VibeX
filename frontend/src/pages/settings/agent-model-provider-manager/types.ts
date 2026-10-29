import type {
  AgentId,
  AgentModelProviderImportPreviewView,
  AgentModelProviderImportSource,
} from 'shared/types';

import type { PiModelReasoning } from '@/lib/piThinking';

export type Surface = 'list' | 'form';

export interface ProviderFormSnapshot {
  id: string | null;
  name: string;
  apiUrl: string;
  apiKey: string;
  model: string;
}

export const EMPTY_FORM_SNAPSHOT: ProviderFormSnapshot = {
  id: null,
  name: '',
  apiUrl: '',
  apiKey: '',
  model: '',
};

export interface AgentModelProviderManagerProps {
  agentId: AgentId;
  disabled: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onChanged?: () => void | Promise<void>;
  embedded?: boolean;
  signedIn?: boolean;
  active?: boolean;
}

/** One provider a plugin found, ready to go through the normal save path. */
export interface PluginImportDraft {
  name: string;
  api_url: string;
  api_key: string | null;
  model: string;
}

export type ImportOrigin =
  | { kind: 'builtin'; source: AgentModelProviderImportSource }
  | { kind: 'plugin'; label: string; drafts: Map<string, PluginImportDraft> };

export type ImportPreviewModel = Pick<
  AgentModelProviderImportPreviewView,
  'candidates' | 'error'
> & { origin: ImportOrigin };

export interface PiModelSpec {
  id: string;
  api: string;
  reasoning: PiModelReasoning;
  thinkingLevel: string;
  /**
   * The parsed object as written, so a patch can add to it instead of
   * rebuilding it from the keys this editor happens to know. Rebuilding is
   * what used to drop the selected-models list on an unrelated edit.
   */
  raw: Record<string, unknown>;
}

export interface GrokModelSpec {
  id: string;
  api_backend: string;
  context_window: string;
  raw: Record<string, unknown>;
}

export interface ClaudeModelSpec {
  /** The env-var mapping keys this editor renders, values only. */
  values: Record<string, string>;
  /** Every key as written, so an edit cannot drop the ones we do not render. */
  raw: Record<string, unknown>;
}
