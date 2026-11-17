import type { ProviderCatalogTemplateView } from '@/pages/settings/providerCatalogTypes';

type BuiltinProviderPreset = Omit<
  ProviderCatalogTemplateView,
  'plugin_id' | 'contribution_id' | 'plugin_label' | 'agent_id'
>;

export const BUILTIN_PROVIDER_PRESET_SOURCE = 'dimo.builtin';

const catalogs = import.meta.glob<BuiltinProviderPreset[]>(
  './catalogs/*.json',
  { import: 'default' }
);

// MiMo Code stores providers in OpenCode's format.
const CATALOG_ALIASES: Record<string, string> = { mimo_code: 'opencode' };

export function hasBuiltinProviderPresets(agentId: string): boolean {
  return `./catalogs/${CATALOG_ALIASES[agentId] ?? agentId}.json` in catalogs;
}

export async function loadBuiltinProviderPresets(
  agentId: string
): Promise<ProviderCatalogTemplateView[]> {
  const load =
    catalogs[`./catalogs/${CATALOG_ALIASES[agentId] ?? agentId}.json`];
  if (!load) return [];
  const templates = await load();
  return templates.map((template) => ({
    ...template,
    plugin_id: BUILTIN_PROVIDER_PRESET_SOURCE,
    contribution_id: BUILTIN_PROVIDER_PRESET_SOURCE,
    plugin_label: '',
    agent_id: agentId,
  }));
}
