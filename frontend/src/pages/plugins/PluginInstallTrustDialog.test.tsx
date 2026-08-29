import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import i18n from '@/i18n';
import type { CatalogListing } from '@/lib/api/plugins';

import {
  listingSourceLabel,
  PluginInstallTrustDialog,
} from './PluginInstallTrustDialog';

const zh = i18n.getFixedT('zh-CN', 'settings');
const en = i18n.getFixedT('en', 'settings');

function listing(overrides: Partial<CatalogListing> = {}): CatalogListing {
  return {
    owner: 'vibex',
    pluginName: 'vibex.multi-agent',
    tag: '1.0.0',
    version: '1.0.0',
    displayName: 'Multi-agent',
    summary: 'Delegate work to child agents in the current session.',
    category: 'official',
    sourceKind: 'official',
    homepage: 'https://github.com/xforever/vibex-plugins/tree/main/multi-agent',
    offlinePluginId: 'vibex.multi-agent',
    ...overrides,
  };
}

describe('listingSourceLabel', () => {
  it('maps official, GitHub, and local origins to short source labels', () => {
    expect(listingSourceLabel(listing(), zh)).toBe('官方市场');
    expect(listingSourceLabel(listing({ sourceKind: 'offline' }), en)).toBe(
      'Official marketplace'
    );
    expect(
      listingSourceLabel(
        listing({
          sourceKind: 'github',
          category: 'community',
          homepage:
            'https://github.com/xforever/vibex-plugins/tree/main/multi-agent',
        }),
        zh
      )
    ).toBe('GitHub xforever/vibex-plugins');
    expect(
      listingSourceLabel(
        listing({
          sourceKind: 'snapshot',
          homepage: '/Users/me/drawio-1.0.0.vxp',
          summary: 'Preview and edit Drawio diagrams.',
        }),
        zh
      )
    ).toBe('本机文件');
  });
});

describe('PluginInstallTrustDialog', () => {
  it('shows name, source, and a compact permission callout — not the summary', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <PluginInstallTrustDialog
        listing={listing()}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />
    );

    expect(
      screen.getByRole('heading', { name: /安装插件|Install plugin/ })
    ).toBeVisible();
    expect(
      screen.getByText(/多智能体协同|Multi-agent/, {
        selector: '.product-plugin-trust-name',
      })
    ).toBeVisible();
    expect(screen.getByText(/来源|Source/)).toBeVisible();
    expect(screen.getByText(/官方市场|Official marketplace/)).toBeVisible();
    const permission = screen.getByRole('note');
    expect(permission).toHaveClass('product-plugin-trust-callout');
    expect(permission.querySelector('strong')).toHaveTextContent(
      /权限|Permissions/
    );
    expect(
      within(permission).getByText(
        /安装后该插件以你的本机用户权限运行|runs with your full computer permissions/i
      )
    ).toBeVisible();
    expect(
      screen.queryByText(
        'Delegate work to child agents in the current session.'
      )
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/vibex\/vibex\.multi-agent@/i)
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /取消|cancel/i }));
    expect(onCancel).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /安装|install/i }));
    expect(onConfirm).toHaveBeenCalled();
  });
});
