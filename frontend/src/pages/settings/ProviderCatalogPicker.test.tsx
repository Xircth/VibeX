import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { render, screen } from '@testing-library/react';
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
  api_key_url: 'https://apple.example/keys',
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

async function openPicker(
  user: ReturnType<typeof userEvent.setup> = userEvent.setup()
) {
  await user.click(screen.getByRole('combobox', { name: '选择预置' }));
  return user;
}

function optionLabels(): string[] {
  return screen
    .getAllByRole('option')
    .map((item) => item.getAttribute('aria-label') ?? '');
}

describe('ProviderCatalogPicker', () => {
  it('keeps presets inside a searchable combobox instead of a card grid', async () => {
    const user = await openPicker();

    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: '搜索预置' })).toBeVisible();
    expect(optionLabels()).toEqual(['自定义', 'Zebra', 'Apple', 'Mango']);
    expect(screen.getByRole('option', { name: 'Apple' })).toHaveTextContent(
      'Apple'
    );
    expect(screen.getByRole('option', { name: 'Apple' })).toHaveTextContent(
      'https://apple.example/v1'
    );

    const search = screen.getByRole('searchbox', { name: '搜索预置' });
    expect(search.closest('[role="listbox"]')).toBeNull();
    await user.click(screen.getByRole('option', { name: 'Apple' }));
    expect(
      screen.getByRole('combobox', { name: '选择预置' })
    ).toHaveTextContent('Apple');
  });

  it('uses a single search field without a nested control chrome', async () => {
    await openPicker();

    const search = screen.getByRole('searchbox', { name: '搜索预置' });
    const shell = search.closest('.agent-model-provider-catalog-search');
    expect(shell).not.toBeNull();
    expect(shell?.querySelectorAll('input')).toHaveLength(1);
    expect(
      shell?.querySelectorAll('.raised-control, [class*="raised-control"]')
    ).toHaveLength(0);
  });

  it('calls onSelect with custom when Custom is chosen', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderPicker();

    await user.click(screen.getByRole('combobox', { name: '选择预置' }));
    await user.click(screen.getByRole('option', { name: '自定义' }));

    expect(onSelect).toHaveBeenCalledWith('custom');
  });

  it('calls onSelect with the template object when a preset is chosen', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderPicker();

    await user.click(screen.getByRole('combobox', { name: '选择预置' }));
    await user.click(screen.getByRole('option', { name: 'Apple' }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(apple);
    expect(
      screen.getByRole('combobox', { name: '选择预置' })
    ).toHaveTextContent('Apple');
  });

  it('filters options with a case-insensitive search', async () => {
    const user = await openPicker();

    await user.type(screen.getByRole('searchbox', { name: '搜索预置' }), 'aPp');

    expect(optionLabels()).toEqual(['自定义', 'Apple']);

    await user.clear(screen.getByRole('searchbox', { name: '搜索预置' }));
    await user.type(
      screen.getByRole('searchbox', { name: '搜索预置' }),
      'mango.example'
    );

    expect(optionLabels()).toEqual(['自定义', 'Mango']);

    await user.clear(screen.getByRole('searchbox', { name: '搜索预置' }));
    await user.type(
      screen.getByRole('searchbox', { name: '搜索预置' }),
      'no-such-preset'
    );

    expect(optionLabels()).toEqual(['自定义']);
    expect(screen.getByText('没有匹配的预置。')).toBeVisible();
  });

  it('hides search when templates is empty', async () => {
    const user = userEvent.setup();
    renderPicker({ templates: [] });

    await user.click(screen.getByRole('combobox', { name: '选择预置' }));

    expect(
      screen.queryByRole('searchbox', { name: '搜索预置' })
    ).not.toBeInTheDocument();
    expect(optionLabels()).toEqual(['自定义']);
  });

  it('does not render Custom when showCustomTile is false', async () => {
    const user = userEvent.setup();
    renderPicker({ showCustomTile: false });

    await user.click(screen.getByRole('combobox', { name: '选择预置' }));

    expect(
      screen.queryByRole('option', { name: '自定义' })
    ).not.toBeInTheDocument();
    expect(optionLabels()).toEqual(['Zebra', 'Apple', 'Mango']);
  });

  it('does not reference setApiUrl in source', () => {
    expect(pickerSource).not.toMatch(/setApiUrl/);
    expect(pickerSource).not.toMatch(/setProviderId/);
    expect(pickerSource).not.toMatch(/saveModelProvider/);
    expect(pickerSource).not.toMatch(/openCodeProviderConnect/);
  });
});
