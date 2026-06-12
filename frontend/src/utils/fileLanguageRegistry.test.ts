import { describe, expect, it } from 'vitest';
import { resolvePreviewLanguageFromPath } from './fileLanguageRegistry';

describe('file language registry', () => {
  it('returns Shiki-compatible preview language ids', () => {
    expect(resolvePreviewLanguageFromPath('index.html')).toBe('html');
    expect(resolvePreviewLanguageFromPath('pom.xml')).toBe('xml');
    expect(resolvePreviewLanguageFromPath('assets/logo.svg')).toBe('xml');
    expect(resolvePreviewLanguageFromPath('.gitignore')).toBe('bash');
  });
});
