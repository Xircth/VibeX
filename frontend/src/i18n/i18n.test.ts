import { describe, expect, it } from 'vitest';

import i18n, { NAMESPACES, resources } from './index';
import { SUPPORTED_LANGUAGES } from '@/lib/uiLanguage';

/** Recursively collect the leaf key paths of a nested resource object. */
function keyPaths(obj: unknown, prefix = ''): string[] {
  if (obj === null || typeof obj !== 'object') return [prefix];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
    keyPaths(v, prefix ? `${prefix}.${k}` : k)
  );
}

describe('i18n resources', () => {
  it('registers both supported languages', () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      expect(resources[lang]).toBeDefined();
    }
  });

  // Every string that exists in one language MUST exist in the other, or a
  // switch to that language silently falls back / shows a raw key. This guards
  // the progressive-migration invariant: converted screens stay fully bilingual.
  it.each(NAMESPACES)(
    'has identical key sets across languages for "%s"',
    (ns) => {
      const zh = keyPaths(resources['zh-CN'][ns]).sort();
      const en = keyPaths(resources.en[ns]).sort();
      expect(en).toEqual(zh);
    }
  );

  it('resolves a known key in both languages', async () => {
    await i18n.changeLanguage('zh-CN');
    expect(i18n.t('common:save')).toBe('保存');
    await i18n.changeLanguage('en');
    expect(i18n.t('common:save')).toBe('Save');
    await i18n.changeLanguage('zh-CN');
  });

  it('interpolates variables', async () => {
    await i18n.changeLanguage('en');
    expect(i18n.t('settings:automations.saveFailed', { error: 'boom' })).toBe(
      'Save failed: boom'
    );
    await i18n.changeLanguage('zh-CN');
  });
});
