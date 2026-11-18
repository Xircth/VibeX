import { describe, expect, it } from 'vitest';
import {
  groupProviderModelChoices,
  splitProviderModelLabel,
  type GroupedProviderModelChoices,
} from './ProviderModelChoices';
import type { DisplayChoice } from './SessionConfigOptionSelectors';

function choice(value: string, name = value): DisplayChoice {
  return { value, name };
}

function providerNames(grouped: GroupedProviderModelChoices | null): string[] {
  return grouped?.providers.map((group) => group.provider) ?? [];
}

describe('splitProviderModelLabel', () => {
  it('splits a provider id from the rest of the label', () => {
    expect(splitProviderModelLabel('google/Gemini 2.5 Flash')).toEqual({
      provider: 'google',
      model: 'Gemini 2.5 Flash',
    });
    expect(splitProviderModelLabel('dimo-modelrouter/deepseek-v4-pro')).toEqual(
      {
        provider: 'dimo-modelrouter',
        model: 'deepseek-v4-pro',
      }
    );
  });

  it('rejects labels that are not provider/model', () => {
    expect(splitProviderModelLabel('gpt-5.4')).toBeNull();
    expect(splitProviderModelLabel('Deep Research/Preview')).toBeNull();
    expect(splitProviderModelLabel('https://example.com/model')).toBeNull();
    expect(splitProviderModelLabel('/gemini')).toBeNull();
    expect(splitProviderModelLabel('google/')).toBeNull();
  });
});

describe('groupProviderModelChoices', () => {
  it('keeps a normal model catalog flat', () => {
    expect(
      groupProviderModelChoices([
        choice('terra', '5.6 Terra'),
        choice('sol', '5.6 Sol'),
      ])
    ).toBeNull();
  });

  it('groups a provider/model catalog and shows only the model name', () => {
    const grouped = groupProviderModelChoices([
      choice('google/gemini-2.5-flash', 'google/Gemini 2.5 Flash'),
      choice('google/gemini-2.5-pro', 'google/Gemini 2.5 Pro'),
      choice('opencode/beam-free', 'opencode/Beam Free'),
      choice(
        'dimo-modelrouter/deepseek-v4-pro',
        'dimo-modelrouter/deepseek-v4-pro'
      ),
    ]);

    expect(providerNames(grouped)).toEqual([
      'google',
      'opencode',
      'dimo-modelrouter',
    ]);
    expect(grouped?.providers[0]?.models.map((model) => model.name)).toEqual([
      'Gemini 2.5 Flash',
      'Gemini 2.5 Pro',
    ]);
    expect(grouped?.providers[0]?.models.map((model) => model.value)).toEqual([
      'google/gemini-2.5-flash',
      'google/gemini-2.5-pro',
    ]);
    expect(grouped?.plain).toEqual([]);
  });

  it('groups by the value when the visible name is already just the model', () => {
    const grouped = groupProviderModelChoices([
      choice('google/gemini-2.5-flash', 'Gemini 2.5 Flash'),
      choice('opencode/beam-free', 'Beam Free'),
    ]);

    expect(providerNames(grouped)).toEqual(['google', 'opencode']);
    expect(grouped?.providers[0]?.models[0]).toMatchObject({
      value: 'google/gemini-2.5-flash',
      name: 'Gemini 2.5 Flash',
    });
  });

  it('keeps a minority of slashed labels in the flat list', () => {
    expect(
      groupProviderModelChoices([
        choice('terra', '5.6 Terra'),
        choice('sol', '5.6 Sol'),
        choice('luna', '5.6 Luna'),
        choice('openai/gpt-4o', 'openai/gpt-4o'),
      ])
    ).toBeNull();
  });

  it('leaves non-provider choices beside the provider groups', () => {
    const grouped = groupProviderModelChoices([
      choice('custom', 'Custom'),
      choice('google/gemini-2.5-flash', 'google/Gemini 2.5 Flash'),
      choice('opencode/beam-free', 'opencode/Beam Free'),
    ]);

    expect(grouped?.plain.map((item) => item.name)).toEqual(['Custom']);
    expect(providerNames(grouped)).toEqual(['google', 'opencode']);
  });

  it('merges provider ids that differ only by case and keeps first-seen order', () => {
    const grouped = groupProviderModelChoices([
      choice('Google/gemini-2.5-flash', 'Google/Gemini 2.5 Flash'),
      choice('opencode/beam-free', 'opencode/Beam Free'),
      choice('google/gemini-2.5-pro', 'google/Gemini 2.5 Pro'),
    ]);

    expect(providerNames(grouped)).toEqual(['Google', 'opencode']);
    expect(grouped?.providers[0]?.models).toHaveLength(2);
  });
});
