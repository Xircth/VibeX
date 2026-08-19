import { describe, expect, it } from 'vitest';

import { localizeReleaseNotes } from './localizeNotes';

const BILINGUAL = `# VibeX 0.1.3

## English

English notes with a list:

- First
- Second

## 中文

中文更新说明：

- 第一项
- 第二项
`;

describe('localizeReleaseNotes', () => {
  it('keeps the English half for English locales', () => {
    expect(localizeReleaseNotes(BILINGUAL, 'en')).toContain('English notes');
    expect(localizeReleaseNotes(BILINGUAL, 'en')).not.toContain('中文更新说明');
  });

  it('keeps the Chinese half for Chinese locales', () => {
    expect(localizeReleaseNotes(BILINGUAL, 'zh-CN')).toContain('中文更新说明');
    expect(localizeReleaseNotes(BILINGUAL, 'zh-CN')).not.toContain(
      'English notes'
    );
  });

  it('returns the whole body when it is not bilingual', () => {
    expect(localizeReleaseNotes('Just one language.', 'zh-CN')).toBe(
      'Just one language.'
    );
  });

  it('treats empty notes as empty', () => {
    expect(localizeReleaseNotes('   ', 'en')).toBe('');
  });
});
