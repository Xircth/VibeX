import {
  FileText,
  FolderCode,
  MessageSquareWarning,
  Puzzle,
  Users,
  Workflow,
} from 'lucide-react';

import { officialPluginI18nKey } from './officialPlugins';

const OFFICIAL_GLYPHS = {
  office: FileText,
  workflowCreator: Workflow,
  sessionEnhance: MessageSquareWarning,
  multiAgent: Users,
  pluginDevelopment: FolderCode,
} as const;

export function PluginProductIcon({ pluginId }: { pluginId?: string }) {
  const official = pluginId ? officialPluginI18nKey(pluginId) : null;
  const Glyph = official ? OFFICIAL_GLYPHS[official] : Puzzle;

  return (
    <span
      className="product-plugin-icon"
      data-official={official ?? undefined}
      aria-hidden="true"
    >
      <Glyph />
    </span>
  );
}
