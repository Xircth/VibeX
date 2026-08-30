import { describe, expect, it } from 'vitest';

import i18n from '@/i18n';

import {
  isOpenSourcePluginOrigin,
  officialConfigFieldCopy,
  officialPluginName,
  officialPluginSummary,
  pluginCanUninstall,
  pluginInstallSource,
  pluginSourceLabel,
} from './officialPlugins';

const t = i18n.getFixedT('zh-CN', 'settings');
const en = i18n.getFixedT('en', 'settings');

describe('official plugin presentation', () => {
  it('localizes official plugin names in the active locale', () => {
    expect(officialPluginName('vibex.office', 'fallback', t)).toBe('办公套件');
    expect(officialPluginName('vibex.workflow-creator', 'fallback', t)).toBe(
      'DAG 工作流编辑器'
    );
    expect(officialPluginName('vibex.session-enhance', 'fallback', t)).toBe(
      '会话增强'
    );
    expect(officialPluginName('vibex.multi-agent', 'fallback', t)).toBe(
      '多智能体协同'
    );
    expect(officialPluginName('vibex.plugin-development', 'fallback', t)).toBe(
      '插件开发'
    );
    expect(officialPluginName('third.party', 'Drawio', t)).toBe('Drawio');
    expect(officialPluginName('vibex.office', 'fallback', en)).toBe(
      'VibeX Office'
    );
    expect(officialPluginName('vibex.workflow-creator', 'fallback', en)).toBe(
      'VibeX Workflow Creator'
    );
    expect(officialPluginName('vibex.session-enhance', 'fallback', en)).toBe(
      'Session Enhance'
    );
    expect(officialPluginName('vibex.multi-agent', 'fallback', en)).toBe(
      'Multi-agent'
    );
    expect(
      officialPluginName('vibex.plugin-development', 'fallback', en)
    ).toBe('Plugin Development');
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

  it('exposes package structure only for public repository origins', () => {
    expect(isOpenSourcePluginOrigin({ sourceKind: 'github' })).toBe(true);
    expect(
      isOpenSourcePluginOrigin({ sourceKind: 'upload', showTree: true })
    ).toBe(true);
    expect(
      isOpenSourcePluginOrigin({
        sourceKind: 'marketplace',
        sourceShowTree: false,
        sourceOrigin: 'https://github.com/acme/notes',
      })
    ).toBe(false);
    expect(
      isOpenSourcePluginOrigin({
        sourceKind: 'marketplace',
        sourceOrigin: 'https://github.com/acme/notes',
      })
    ).toBe(true);
    expect(isOpenSourcePluginOrigin({ sourceKind: 'snapshot' })).toBe(false);
    expect(isOpenSourcePluginOrigin({ sourceKind: 'archive' })).toBe(false);
    expect(isOpenSourcePluginOrigin({ sourceKind: 'official' })).toBe(false);
    expect(isOpenSourcePluginOrigin({ sourceKind: 'builtin' })).toBe(false);
    expect(
      isOpenSourcePluginOrigin({
        sourceKind: 'marketplace',
        sourceOrigin: 'https://vibex.xforever.xin/marketplace/vibex/office',
      })
    ).toBe(false);
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
      true
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
