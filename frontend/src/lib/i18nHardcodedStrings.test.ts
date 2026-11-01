import { afterEach, describe, expect, it } from 'vitest';
import i18n from '@/i18n';
import { resolveBuiltinPanelTitle } from '@/lib/builtinPanelTitles';
import { localizeBackendNoticeTitle } from '@/features/conversation/sessionNoticeCopy';
import { COPY, SPACE_TAG_PRESETS } from '@/features/collaboration/spaceModel';
import { CONTACT_ROW_MENU_COPY } from '@/features/collaboration/contactRowMenu';
import { BOT_AVATAR_SHAPE_PRESETS } from '@/features/collaboration/MemberBotAvatar';
import enPanels from '@/i18n/locales/en/panels.json';
import zhPanels from '@/i18n/locales/zh-CN/panels.json';

const t = (key: string, options?: Record<string, unknown>) =>
  i18n.t(key, options) as string;

function leafPaths(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value).flatMap(([k, v]) =>
    leafPaths(v, prefix ? `${prefix}.${k}` : k)
  );
}

describe('hardcoded string i18n', () => {
  afterEach(async () => {
    await i18n.changeLanguage('zh-CN');
  });

  it('re-localizes persisted builtin Dockview tab titles on language switch', async () => {
    await i18n.changeLanguage('zh-CN');
    expect(resolveBuiltinPanelTitle('welcome', 'Welcome', t)).toBe('欢迎');
    await i18n.changeLanguage('en');
    expect(resolveBuiltinPanelTitle('welcome', '欢迎', t)).toBe('Welcome');
    expect(resolveBuiltinPanelTitle('session-list', 'Session List', t)).toBe(
      enPanels.panelRegistry.sessionList
    );
    // custom / unknown titles are kept
    expect(resolveBuiltinPanelTitle('welcome', 'My tab', t)).toBe('My tab');
    expect(resolveBuiltinPanelTitle('some-file.ts', '欢迎', t)).toBe('欢迎');
  });

  it('maps backend notice titles to the current language', async () => {
    await i18n.changeLanguage('en');
    expect(localizeBackendNoticeTitle('正在连接 Agent…', t)).not.toMatch(
      /[\u4e00-\u9fff]/
    );
    expect(localizeBackendNoticeTitle('unrelated title', t)).toBe(
      'unrelated title'
    );
    await i18n.changeLanguage('zh-CN');
    expect(localizeBackendNoticeTitle('正在连接 Agent…', t)).toMatch(/Agent/);
  });

  it('collaboration copy tables follow the current language', async () => {
    await i18n.changeLanguage('en');
    expect(COPY.requestFailed).toBe('Request failed');
    expect(CONTACT_ROW_MENU_COPY.pin).toBe('Pin');
    expect(SPACE_TAG_PRESETS[0].label).toBe('Blue');
    expect(BOT_AVATAR_SHAPE_PRESETS[0].label).toBe('Circle');
    await i18n.changeLanguage('zh-CN');
    expect(COPY.requestFailed).toBe('请求失败');
    expect(CONTACT_ROW_MENU_COPY.pin).toBe('置顶');
    expect(SPACE_TAG_PRESETS[0].label).toBe('蓝色');
  });

  it('en and zh-CN panels locales define the same new keys', () => {
    for (const section of [
      'ui',
      'collabCopy',
      'contactRowMenu',
      'spaceTag',
      'botAvatar',
      'panelRegistry',
    ] as const) {
      const en = leafPaths(
        (enPanels as Record<string, unknown>)[section]
      ).sort();
      const zh = leafPaths(
        (zhPanels as Record<string, unknown>)[section]
      ).sort();
      expect(zh, section).toEqual(en);
    }
  });
});
