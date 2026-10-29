import type { AgentModelProviderImportPreviewView } from 'shared/types';

import type { PluginImportDraft } from './types';

/**
 * Reads whatever a plugin's import handler returned.
 *
 * The payload crosses a Worker boundary, so every field is checked rather than
 * cast. A candidate missing a name or URL is dropped instead of failing the
 * whole import — one malformed entry should not hide the rest.
 */
export function pluginImportCandidates(
  payload: unknown,
  /** Shown against a candidate the store cannot accept. Translated by the caller. */
  missingKeyReason: string
): {
  view: AgentModelProviderImportPreviewView['candidates'][number];
  draft: PluginImportDraft;
}[] {
  const rows = Array.isArray(payload)
    ? payload
    : payload &&
        typeof payload === 'object' &&
        Array.isArray((payload as { providers?: unknown }).providers)
      ? (payload as { providers: unknown[] }).providers
      : [];
  const text = (value: unknown) =>
    typeof value === 'string' && value.trim() ? value.trim() : null;
  return rows.flatMap((row, index) => {
    if (!row || typeof row !== 'object') return [];
    const record = row as Record<string, unknown>;
    const name = text(record.name);
    const apiUrl = text(record.apiUrl) ?? text(record.api_url);
    if (!name || !apiUrl) return [];
    const apiKey = text(record.apiKey) ?? text(record.api_key);
    const model = text(record.model) ?? '';
    return [
      {
        view: {
          source_id:
            text(record.id) ?? text(record.sourceId) ?? `plugin-${index}`,
          name,
          api_url: apiUrl,
          model,
          credential_present: apiKey !== null,
          // The store requires a key, so a keyless candidate cannot be saved.
          skip_reason: apiKey ? null : missingKeyReason,
        },
        draft: { name, api_url: apiUrl, api_key: apiKey, model },
      },
    ];
  });
}
