import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import {
  ProviderCatalogPicker,
  type ProviderCatalogPickerProps,
} from './ProviderCatalogPicker';
import type { ProviderCatalogTemplateView } from './providerCatalogTypes';

const pickerSource = readFileSync(
  resolve(process.cwd(), 'src/pages/settings/ProviderCatalogPicker.tsx'),
  'utf8'
);

function template(
  overrides: Partial<ProviderCatalogTemplateView> &
    Pick<ProviderCatalogTemplateView, 'id' | 'name'>
): ProviderCatalogTemplateView {
  return {
    plugin_id: 'vibex.provider-switch',
    contribution_id: 'claude-code',
    plugin_label: 'ProviderSwitch',
    agent_id: 'claude_code',
    category: 'community',
    surface: 'reusable',
    api_url: `https://${overrides.id}.example/v1`,
    ...overrides,
  };
}

const zebra = template({
  id: 'zebra',
  name: 'Zebra',
  api_url: 'https://zebra.example/v1',
});
const apple = template({
  id: 'apple',
  name: 'Apple',
  api_url: 'https://apple.example/v1',
  website_url: 'https://apple.example',
});
const mango = template({
  id: 'mango',
  name: 'Mango',
  base_url: 'https://mango.example/v1',
  api_url: null,
  surface: 'dsh',
});

const sampleTemplates = [zebra, apple, mango];

function renderPicker(overrides: Partial<ProviderCatalogPickerProps> = {}) {
  const onSelect = overrides.onSelect ?? vi.fn();
  render(
    <ProviderCatalogPicker
      templates={sampleTemplates}
      generation={1}
      showCustomTile
      onSelect={onSelect}
      {...overrides}
    />
  );
  return { onSelect };
}

function tileLabels(): string[] {
  return screen.getAllByRole('listitem').map((item) => {
    const button = within(item).getByRole('button');
    return button.getAttribute('aria-label') ?? button.textContent ?? '';
  });
}

describe('ProviderCatalogPicker', () => {
  it('renders Custom first when showCustomTile is set', () => {
    renderPicker();

    expect(tileLabels()[0]).toBe('自定义');
    expect(tileLabels().slice(1)).toEqual(['Zebra', 'Apple', 'Mango']);
  });

  it('calls onSelect with custom when Custom is clicked', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderPicker();

    await user.click(screen.getByRole('button', { name: '自定义' }));

    expect(onSelect).toHaveBeenCalledWith('custom');
  });

  it('calls onSelect with the template object when a tile is clicked', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderPicker();

    await user.click(screen.getByRole('button', { name: 'Apple' }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(apple);
  });

  it('filters tiles with a case-insensitive search', async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.type(screen.getByRole('searchbox', { name: '搜索预置' }), 'aPp');

    expect(tileLabels()).toEqual(['自定义', 'Apple']);

    await user.clear(screen.getByRole('searchbox', { name: '搜索预置' }));
    await user.type(
      screen.getByRole('searchbox', { name: '搜索预置' }),
      'mango.example'
    );

    expect(tileLabels()).toEqual(['自定义', 'Mango']);

    await user.clear(screen.getByRole('searchbox', { name: '搜索预置' }));
    await user.type(
      screen.getByRole('searchbox', { name: '搜索预置' }),
      'no-such-preset'
    );

    expect(tileLabels()).toEqual(['自定义']);
    expect(screen.getByText('没有匹配的预置。')).toBeVisible();
  });

  it('reorders non-custom tiles by name when A–Z is on', async () => {
    const user = userEvent.setup();
    renderPicker();

    expect(tileLabels()).toEqual(['自定义', 'Zebra', 'Apple', 'Mango']);

    await user.click(screen.getByRole('button', { name: '按名称' }));

    expect(screen.getByRole('button', { name: '按名称' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(tileLabels()).toEqual(['自定义', 'Apple', 'Mango', 'Zebra']);

    await user.click(screen.getByRole('button', { name: '按名称' }));

    expect(tileLabels()).toEqual(['自定义', 'Zebra', 'Apple', 'Mango']);
  });

  it('hides search and A–Z when templates is empty', () => {
    renderPicker({ templates: [] });

    expect(
      screen.queryByRole('searchbox', { name: '搜索预置' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '按名称' })
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '自定义' })).toBeVisible();
  });

  it('does not render Custom when showCustomTile is false', () => {
    renderPicker({ showCustomTile: false });

    expect(
      screen.queryByRole('button', { name: '自定义' })
    ).not.toBeInTheDocument();
    expect(tileLabels()).toEqual(['Zebra', 'Apple', 'Mango']);
  });

  it('does not reference setApiUrl in source', () => {
    expect(pickerSource).not.toMatch(/setApiUrl/);
    expect(pickerSource).not.toMatch(/setProviderId/);
    expect(pickerSource).not.toMatch(/saveModelProvider/);
    expect(pickerSource).not.toMatch(/openCodeProviderConnect/);
  });
});
