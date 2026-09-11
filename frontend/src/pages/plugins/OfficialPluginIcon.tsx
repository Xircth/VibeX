import {
  Cloud,
  FileText,
  FlaskConical,
  FolderCode,
  Layers,
  MessageSquareWarning,
  Puzzle,
  Plug,
  Users,
  Workflow,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import {
  officialPluginI18nKey,
  type OfficialPluginI18nKey,
} from './officialPlugins';

const OFFICIAL_GLYPHS: Record<OfficialPluginI18nKey, LucideIcon> = {
  office: FileText,
  workflowCreator: Workflow,
  sessionEnhance: MessageSquareWarning,
  multiAgent: Users,
  pluginDevelopment: FolderCode,
  hostChrome: Puzzle,
  hostSurface: Layers,
  providerImport: Plug,
  remoteSsh: Cloud,
  science: FlaskConical,
};

export function PluginProductIcon({ pluginId }: { pluginId?: string }) {
  const official = pluginId ? officialPluginI18nKey(pluginId) : null;
  const Glyph = (official && OFFICIAL_GLYPHS[official]) || Puzzle;

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
