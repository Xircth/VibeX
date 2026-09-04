import { describe, expect, it } from 'vitest';

import { pluginImportCandidates } from './AgentModelProviderManager';

describe('plugin provider import payloads', () => {
  it('accepts both a bare array and a providers envelope', () => {
    const row = { name: 'Staging', apiUrl: 'https://a.invalid', apiKey: 'k' };
    expect(pluginImportCandidates([row])).toHaveLength(1);
    expect(pluginImportCandidates({ providers: [row] })).toHaveLength(1);
  });

  it('reads snake_case as well as camelCase, since plugins write both', () => {
    const [candidate] = pluginImportCandidates([
      { name: 'Staging', api_url: 'https://a.invalid', api_key: 'k' },
    ]);
    expect(candidate.view.api_url).toBe('https://a.invalid');
    expect(candidate.draft.api_key).toBe('k');
  });

  it('drops malformed rows without losing the good ones', () => {
    const candidates = pluginImportCandidates([
      null,
      'not an object',
      { name: '   ', apiUrl: 'https://a.invalid' },
      { name: 'No URL' },
      { name: 'Keeper', apiUrl: 'https://b.invalid', apiKey: 'k' },
    ]);
    expect(candidates.map((item) => item.view.name)).toEqual(['Keeper']);
  });

  it('marks a keyless candidate unselectable rather than saving a broken preset', () => {
    const [candidate] = pluginImportCandidates([
      { name: 'Staging', apiUrl: 'https://a.invalid' },
    ]);
    expect(candidate.view.credential_present).toBe(false);
    expect(candidate.view.skip_reason).toBeTruthy();
  });

  it('falls back to a positional id when the plugin omits one', () => {
    const candidates = pluginImportCandidates([
      { name: 'A', apiUrl: 'https://a.invalid', apiKey: 'k' },
      { id: 'given', name: 'B', apiUrl: 'https://b.invalid', apiKey: 'k' },
    ]);
    expect(candidates.map((item) => item.view.source_id)).toEqual([
      'plugin-0',
      'given',
    ]);
  });

  it('treats anything that is not a list as no candidates', () => {
    expect(pluginImportCandidates(undefined)).toEqual([]);
    expect(pluginImportCandidates({ providers: 'nope' })).toEqual([]);
  });
});
