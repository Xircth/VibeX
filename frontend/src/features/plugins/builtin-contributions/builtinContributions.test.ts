import { describe, expect, it } from 'vitest';
import enPanels from '@/i18n/locales/en/panels.json';
import zhPanels from '@/i18n/locales/zh-CN/panels.json';
import { PANEL_IDS } from '@/stores/useLayoutStore';
import { BUILTIN_PANEL_MANIFESTS, PANEL_ZONE_BY_POSITION } from './index';

type PanelRegistryStrings = Record<string, string>;
const PANEL_REGISTRY_TABLES: PanelRegistryStrings[] = [
  (enPanels as { panelRegistry: PanelRegistryStrings }).panelRegistry,
  (zhPanels as { panelRegistry: PanelRegistryStrings }).panelRegistry,
];

describe('builtin panel manifests', () => {
  it('declares exactly one app.panel manifest per builtin panel id', () => {
    const ids = BUILTIN_PANEL_MANIFESTS.map((manifest) => manifest.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(
      [...Object.values(PANEL_IDS)].sort()
    );
  });

  it('keeps ids, dock zones, multi-instance flags and titles unchanged', () => {
    expect(
      BUILTIN_PANEL_MANIFESTS.map((manifest) => [
        manifest.id,
        PANEL_ZONE_BY_POSITION[manifest.defaultPosition],
        manifest.multiInstance ?? false,
        manifest.titleKey,
      ])
    ).toEqual([
      ['kanban', 'editor', false, 'panelRegistry.kanban'],
      ['file-tree', 'left', false, 'panelRegistry.fileExplorer'],
      ['preview', 'editor', true, 'panelRegistry.preview'],
      ['diffs', 'editor', false, 'panelRegistry.diffs'],
      ['terminal', 'bottom', true, 'panelRegistry.terminal'],
      ['ai-chat', 'session', false, 'panelRegistry.aiChat'],
      ['git', 'left', false, 'panelRegistry.git'],
      ['merge', 'editor', false, 'panelRegistry.merge'],
      ['welcome', 'editor', false, 'panelRegistry.welcome'],
      ['logs', 'editor', false, 'panelRegistry.logs'],
      ['notes', 'editor', false, 'panelRegistry.notes'],
      ['session-details', 'editor', false, 'panelRegistry.sessionDetails'],
      ['processes', 'editor', false, 'panelRegistry.processes'],
      ['search', 'left', false, 'panelRegistry.search'],
      ['session-list', 'left', false, 'panelRegistry.sessionList'],
    ]);
  });

  it('resolves every title key in both locales', () => {
    for (const manifest of BUILTIN_PANEL_MANIFESTS) {
      expect(manifest.titleKey.startsWith('panelRegistry.')).toBe(true);
      const key = manifest.titleKey.slice('panelRegistry.'.length);
      for (const table of PANEL_REGISTRY_TABLES) {
        expect(table[key], `${manifest.id} -> ${manifest.titleKey}`).toBeTruthy();
      }
    }
  });
});
