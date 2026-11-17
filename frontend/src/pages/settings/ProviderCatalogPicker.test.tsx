import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { openExternal } from '@/features/model-router/openExternal';

import {
  ProviderCatalogPicker,
  type ProviderCatalogPickerProps,
} from './ProviderCatalogPicker';
import type { ProviderCatalogTemplateView } from './providerCatalogTypes';

vi.mock('@/features/model-router/openExternal', () => ({
  openExternal: vi.fn(),
}));

const pickerSource = readFileSync(
  resolve(process.cwd(), 'src/pages/settings/ProviderCatalogPicker.tsx'),
  'utf8'
);

function template(
  overrides: Partial<ProviderCatalogTemplateView> &
    Pick<ProviderCatalogTemplateView, 'id' | 'name'>
): ProviderCatalogTemplateView {
  return {
    plugin_id: 'dimo.builtin',
    contribution_id: 'dimo.builtin',
    plugin_label: '',
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
  icon: 'openai',
  website_url: 'https://apple.example',
});
const mango = template({
  id: 'mango',
  name: 'Mango',
  plugin_id: 'acme.presets',
  plugin_label: 'Acme Presets',
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
  it('renders a closed inline search combobox instead of a flattened tile grid', () => {
    renderPicker();

    expect(trigger()).toBeVisible();
    expect(trigger().tagName).toBe('INPUT');
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: '按名称' })).toBeVisible();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
  });

  it('does not render a duplicate search input inside the dropdown menu', async () => {
    const user = userEvent.setup();
    renderPicker();
    await openPicker(user);

    const search = trigger();
    const listbox = screen.getByRole('listbox');
    const menu = listbox.closest('.agent-model-provider-catalog-menu');

    expect(search.parentElement).not.toHaveClass('raised-control');
    expect(search.closest('label.raised-control')).not.toBeInTheDocument();
    expect(menu).not.toBeNull();
    expect(menu).toContainElement(listbox);
    expect(menu).not.toContainElement(search);
    expect(menu?.querySelectorAll('input')).toHaveLength(0);
    expect(document.querySelectorAll('input')).toHaveLength(1);
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(listbox).toHaveClass('agent-model-provider-catalog-list');
  });

  it('renders Custom first when showCustomTile is set', async () => {
    const user = userEvent.setup();
    renderPicker();
    await openPicker(user);

    expect(optionLabels()[0]).toBe('自定义');
    expect(optionLabels().slice(1)).toEqual(['Zebra', 'Apple', 'Mango']);
  });

  it('shows icon, name, endpoint and a website button on each option', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderPicker();
    await openPicker(user);

    const option = screen.getByRole('option', { name: 'Apple' });
    expect(option.querySelector('.astryx-selector-option')).not.toBeNull();
    expect(option.querySelector('.provider-preset-icon.is-ink')).not.toBeNull();
    expect(within(option).getByText('Apple')).toBeVisible();
    expect(within(option).getByText('https://apple.example/v1')).toBeVisible();

    await user.click(
      within(option).getByRole('button', { name: 'Apple 网站' })
    );
    expect(openExternal).toHaveBeenCalledWith('https://apple.example');
    expect(onSelect).not.toHaveBeenCalled();

    const zebraOption = screen.getByRole('option', { name: 'Zebra' });
    expect(within(zebraOption).getByText('Z')).toBeVisible();
    expect(within(zebraOption).queryByRole('button')).not.toBeInTheDocument();
  });

  it('labels plugin-contributed rows with their plugin', async () => {
    const user = userEvent.setup();
    renderPicker();
    await openPicker(user);

    const option = screen.getByRole('option', { name: 'Mango' });
    expect(within(option).getByText('Acme Presets')).toBeVisible();
    expect(
      within(screen.getByRole('option', { name: 'Apple' })).queryByText(
        'Acme Presets'
      )
    ).not.toBeInTheDocument();
  });

  it('pins Custom above the scrolling presets while searching', async () => {
    const user = userEvent.setup();
    renderPicker();
    await openPicker(user);

    await user.type(trigger(), 'nothing-matches');

    expect(optionLabels()).toEqual(['自定义']);
    expect(screen.getByRole('option', { name: '自定义' })).toHaveClass(
      'is-pinned'
    );
  });

  it('calls onSelect with custom when Custom is clicked', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderPicker();
    await openPicker(user);

    await user.click(screen.getByRole('option', { name: '自定义' }));

    expect(onSelect).toHaveBeenCalledWith('custom');
    expect(trigger()).toHaveValue('自定义');
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
  });

  it('calls onSelect with the template object when an option is clicked', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderPicker();
    await openPicker(user);

    await user.click(screen.getByRole('option', { name: 'Apple' }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(apple);
    expect(trigger()).toHaveValue('Apple');

    await user.keyboard('{Escape}');
    await openPicker(user);
    expect(trigger()).toHaveValue('');
    expect(trigger()).toHaveAttribute('placeholder', 'Apple');
    expect(optionLabels()).toEqual(['自定义', 'Zebra', 'Apple', 'Mango']);
  });

  it('filters options with a case-insensitive search and restores selection on Escape', async () => {
    const user = userEvent.setup();
    renderPicker();
    await openPicker(user);

    await user.type(trigger(), 'aPp');

    expect(optionLabels()).toEqual(['自定义', 'Apple']);

    await user.clear(trigger());
    await user.type(trigger(), 'mango.example');

    expect(optionLabels()).toEqual(['自定义', 'Mango']);

    await user.clear(trigger());
    await user.type(trigger(), 'no-such-preset');

    expect(optionLabels()).toEqual(['自定义']);
    expect(screen.getByText('没有匹配的预置。')).toBeVisible();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(trigger()).toHaveValue('');
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

  it('hides search input and A–Z when templates is empty', async () => {
    const user = userEvent.setup();
    renderPicker({ templates: [] });

    expect(trigger().tagName).toBe('DIV');
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '按名称' })
    ).not.toBeInTheDocument();

    await openPicker(user);

    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
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
