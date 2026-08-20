import { describe, expect, it } from 'vitest';

import i18n from '@/i18n';

import {
  officialConfigFieldCopy,
  officialPluginName,
  officialPluginSummary,
  pluginCanUninstall,
  pluginInstallSource,
  pluginSourceLabel,
} from './officialPlugins';

const t = i18n.getFixedT('zh-CN', 'settings');

describe('official plugin presentation', () => {
  it('keeps Office as a proper name and localizes the other built-ins', () => {
    expect(officialPluginName('vibex.office', 'fallback', t)).toBe(
      'VibeX Office'
    );
    expect(officialPluginName('vibex.workflow-creator', 'fallback', t)).toBe(
      '工作流创建器'
    );
    expect(officialPluginName('vibex.session-enhance', 'fallback', t)).toBe(
      '会话增强'
    );
    expect(officialPluginName('third.party', 'Drawio', t)).toBe('Drawio');
  });

  it('localizes official config labels without rewriting user plugins', () => {
    const official = officialConfigFieldCopy(
      'vibex.workflow-creator',
      'defaultCompletionPolicy',
      { title: 'Default Agent Step completion' },
      t
    );
    expect(official.title).toBe('默认 Agent 步骤完成方式');
    expect(official.enumLabel('manual')).toBe('手动确认');

    const thirdParty = officialConfigFieldCopy(
      'third.party',
      'theme',
      { title: 'Theme', description: 'Color theme' },
      t
    );
    expect(thirdParty.title).toBe('Theme');
    expect(thirdParty.description).toBe('Color theme');
  });

  it('classifies install source from the plugin record', () => {
    expect(pluginInstallSource({ builtin: true, sourceKind: 'builtin' })).toBe(
      'builtin'
    );
    expect(
      pluginInstallSource({ builtin: false, sourceKind: 'developer_link' })
    ).toBe('linked');
    expect(
      pluginInstallSource({ builtin: false, sourceKind: 'snapshot' })
    ).toBe('installed');
    expect(pluginSourceLabel('builtin', t)).toBe('内置');
    expect(
      officialPluginSummary('vibex.multi-agent', 'package fallback', t)
    ).toBe('让父 Agent 把子任务委托给其它 Agent。');
  });

  it('allows uninstall only for non-builtin packages that support it', () => {
    expect(
      pluginCanUninstall({
        builtin: false,
        sourceKind: 'archive',
        uninstallSupported: true,
      })
    ).toBe(true);
    expect(
      pluginCanUninstall({
        builtin: false,
        sourceKind: 'developer_link',
      })
    ).toBe(true);
    expect(pluginCanUninstall({ builtin: true, sourceKind: 'builtin' })).toBe(
      false
    );
    expect(
      pluginCanUninstall({
        builtin: false,
        sourceKind: 'snapshot',
        uninstallSupported: false,
      })
    ).toBe(false);
  });
});
