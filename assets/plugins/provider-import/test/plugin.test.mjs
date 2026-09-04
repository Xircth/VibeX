import assert from 'node:assert/strict';
import test from 'node:test';

import { discoverProviders } from '../runtime/providers.mjs';

test('a key with no base URL falls back to the vendor default', () => {
  const [provider] = discoverProviders({ OPENAI_API_KEY: 'sk-test' });
  assert.equal(provider.name, 'OpenAI');
  assert.equal(provider.apiUrl, 'https://api.openai.com/v1');
  assert.equal(provider.apiKey, 'sk-test');
});

test('an explicit base URL wins over the default', () => {
  const [provider] = discoverProviders({
    OPENAI_API_KEY: 'sk-test',
    OPENAI_BASE_URL: 'https://gateway.internal/v1',
  });
  assert.equal(provider.apiUrl, 'https://gateway.internal/v1');
});

test('the first key variant that is set is the one used', () => {
  const [provider] = discoverProviders({
    ANTHROPIC_AUTH_TOKEN: 'token',
    ANTHROPIC_API_KEY: 'key',
  });
  assert.equal(provider.apiKey, 'token');
});

test('an unconfigured environment yields nothing rather than five empty rows', () => {
  assert.deepEqual(discoverProviders({}), []);
  assert.deepEqual(discoverProviders({ OPENAI_API_KEY: '   ' }), []);
});

test('a URL without a key is reported so the Host can block it visibly', () => {
  const [provider] = discoverProviders({
    DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
  });
  assert.equal(provider.name, 'DeepSeek');
  assert.equal(provider.apiKey, null);
});

test('unrelated variables never invent a provider', () => {
  assert.deepEqual(
    discoverProviders({ PATH: '/usr/bin', HOME: '/home/someone' }),
    []
  );
});
