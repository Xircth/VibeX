import { type PanelId } from '@/stores/useLayoutStore';
import { type BuiltinPanelManifest } from './types';
import { aiChatPanelManifest } from './aiChat';
import { diffsPanelManifest } from './diffs';
import { fileTreePanelManifest } from './fileTree';
import { gitPanelManifest } from './git';
import { kanbanPanelManifest } from './kanban';
import { logsPanelManifest } from './logs';
import { mergePanelManifest } from './merge';
import { notesPanelManifest } from './notes';
import { previewPanelManifest } from './preview';
import { externalDirectoryPanelManifest } from './externalDirectory';
import { processesPanelManifest } from './processes';
import { searchPanelManifest } from './search';
import { sessionDetailsPanelManifest } from './sessionDetails';
import { sessionListPanelManifest } from './sessionList';
import { terminalPanelManifest } from './terminal';
import { welcomePanelManifest } from './welcome';

/**
 * Every builtin Dockview panel, one manifest each, in the order
 * `registerBuiltinPanels` registers them.
 */
const panelManifests = [
  kanbanPanelManifest,
  fileTreePanelManifest,
  previewPanelManifest,
  externalDirectoryPanelManifest,
  diffsPanelManifest,
  terminalPanelManifest,
  aiChatPanelManifest,
  gitPanelManifest,
  mergePanelManifest,
  welcomePanelManifest,
  logsPanelManifest,
  notesPanelManifest,
  sessionDetailsPanelManifest,
  processesPanelManifest,
  searchPanelManifest,
  sessionListPanelManifest,
] as const;

export type BuiltinPanelManifestId = (typeof panelManifests)[number]['id'];
export type BuiltinPanelManifestEntry = BuiltinPanelManifest & {
  readonly id: BuiltinPanelManifestId;
};

export const BUILTIN_PANEL_MANIFESTS: readonly BuiltinPanelManifestEntry[] =
  panelManifests;

/** Panel ids that still have no builtin manifest. */
export type UnmanifestedPanelId = Exclude<PanelId, BuiltinPanelManifestId>;
/** Compile-time guard: `true` only while every `PANEL_IDS` member is declared. */
export type BuiltinPanelManifestsCoverPanelIds = [UnmanifestedPanelId] extends [
  never,
]
  ? true
  : false;

export { PANEL_ZONE_BY_POSITION } from './types';
export type {
  BuiltinPanelManifest,
  BuiltinPanelModule,
  BuiltinPanelPosition,
} from './types';
