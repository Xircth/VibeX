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

function trigger() {
  return screen.getByRole('combobox', { name: '搜索预置' });
}

function optionLabels(): string[] {
  return screen.getAllByRole('option').map((item) => {
    return item.getAttribute('aria-label') ?? item.textContent ?? '';
  });
}

async function openPicker(user: ReturnType<typeof userEvent.setup>) {
  await user.click(trigger());
  expect(await screen.findByRole('listbox')).toBeVisible();
}

describe('ProviderCatalogPicker', () => {
  it('renders a closed combobox instead of a flattened tile grid', () => {
    renderPicker();

    expect(trigger()).toBeVisible();
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('searchbox', { name: '搜索预置' })
    ).not.toBeInTheDocument();
  });

  it('keeps the search box fixed above the scrollable options', async () => {
    const user = userEvent.setup();
    renderPicker();
    await openPicker(user);

    const search = screen.getByRole('searchbox', { name: '搜索预置' });
    const listbox = screen.getByRole('listbox');
    const menu = search.closest('.agent-model-provider-catalog-menu');

    expect(search.parentElement).not.toHaveClass('raised-control');
    expect(search.closest('label.raised-control')).not.toBeInTheDocument();
    expect(listbox).not.toContainElement(search);
    expect(menu).toContainElement(search);
    expect(menu).toContainElement(listbox);
    expect(
      search.closest('.agent-model-provider-catalog-search')?.nextElementSibling
    ).toBe(listbox);
    expect(listbox).toHaveClass('agent-model-provider-catalog-list');
  });

  it('renders Custom first when showCustomTile is set', async () => {
    const user = userEvent.setup();
    renderPicker();
    await openPicker(user);

    expect(optionLabels()[0]).toBe('自定义');
    expect(optionLabels().slice(1)).toEqual(['Zebra', 'Apple', 'Mango']);
  });

  it('shows provider name and endpoint on each option', async () => {
    const user = userEvent.setup();
    renderPicker();
    await openPicker(user);

    const option = screen.getByRole('option', { name: 'Apple' });
    expect(within(option).getByText('Apple')).toBeVisible();
    expect(within(option).getByText('https://apple.example/v1')).toBeVisible();
    expect(within(option).getByText('预置 · ProviderSwitch')).toBeVisible();
    expect(within(option).getByRole('link', { name: '网站' })).toBeVisible();
  });

  it('calls onSelect with custom when Custom is clicked', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderPicker();
    await openPicker(user);

    await user.click(screen.getByRole('option', { name: '自定义' }));

    expect(onSelect).toHaveBeenCalledWith('custom');
    expect(trigger()).toHaveTextContent('自定义');
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
  });

  it('calls onSelect with the template object when an option is clicked', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderPicker();
    await openPicker(user);

    await user.click(screen.getByRole('option', { name: 'Apple' }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(apple);
    expect(trigger()).toHaveTextContent('Apple');
  });

  it('filters options with a case-insensitive search', async () => {
    const user = userEvent.setup();
    renderPicker();
    await openPicker(user);

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

  it('reorders non-custom options by name when A–Z is on', async () => {
    const user = userEvent.setup();
    renderPicker();
    await openPicker(user);

    expect(optionLabels()).toEqual(['自定义', 'Zebra', 'Apple', 'Mango']);

    await user.click(screen.getByRole('button', { name: '按名称' }));

    expect(screen.getByRole('button', { name: '按名称' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(optionLabels()).toEqual(['自定义', 'Apple', 'Mango', 'Zebra']);

    await user.click(screen.getByRole('button', { name: '按名称' }));

    expect(optionLabels()).toEqual(['自定义', 'Zebra', 'Apple', 'Mango']);
  });

  it('hides search and A–Z when templates is empty', async () => {
    const user = userEvent.setup();
    renderPicker({ templates: [] });

    expect(
      screen.queryByRole('searchbox', { name: '搜索预置' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '按名称' })
    ).not.toBeInTheDocument();

    await openPicker(user);

    expect(
      screen.queryByRole('searchbox', { name: '搜索预置' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '按名称' })
    ).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: '自定义' })).toBeVisible();
  });

  it('does not render Custom when showCustomTile is false', async () => {
    const user = userEvent.setup();
    renderPicker({ showCustomTile: false });
    await openPicker(user);

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
