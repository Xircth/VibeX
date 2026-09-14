// Local snake_case view matching design A.3 Host view.
// shared/types.ts will replace this after generate-types.

export type ProviderCatalogSurface = 'reusable' | 'opencode' | 'dsh';

export type ProviderCatalogModelView = {
  id: string;
  name?: string | null;
};

export type ProviderCatalogSourceView = {
  plugin_id: string;
  contribution_id: string;
  label: string;
  template_count: number;
  error?: string | null;
};

export type ProviderCatalogListView = {
  agent_id: string;
  generation: number;
  templates: ProviderCatalogTemplateView[];
  sources: ProviderCatalogSourceView[];
};

export type ProviderCatalogTemplateView = {
  id: string;
  plugin_id: string;
  contribution_id: string;
  plugin_label: string;
  agent_id: string;
  name: string;
  website_url?: string | null;
  api_key_url?: string | null;
  endpoint_candidates?: string[];
  api_key_field?: string | null;
  category: string;
  surface: ProviderCatalogSurface;
  api_url?: string | null;
  model?: string | null;
  provider_id?: string | null;
  npm?: string | null;
  api?: string | null;
  base_url?: string | null;
  models?: ProviderCatalogModelView[];
  display_name?: string | null;
  notes?: string | null;
  default_model?: string | null;
};
