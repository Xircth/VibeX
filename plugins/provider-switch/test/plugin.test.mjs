import assert from 'node:assert/strict';
import test from 'node:test';

import antigravity from '../catalogs/antigravity.json' with { type: 'json' };
import claudeCode from '../catalogs/claude_code.json' with { type: 'json' };
import cline from '../catalogs/cline.json' with { type: 'json' };
import codex from '../catalogs/codex.json' with { type: 'json' };
import deepseekHarness from '../catalogs/deepseek_harness.json' with { type: 'json' };
import grok from '../catalogs/grok.json' with { type: 'json' };
import hermes from '../catalogs/hermes.json' with { type: 'json' };
import kimiCode from '../catalogs/kimi_code.json' with { type: 'json' };
import mimoCode from '../catalogs/mimo_code.json' with { type: 'json' };
import openclaw from '../catalogs/openclaw.json' with { type: 'json' };
import opencode from '../catalogs/opencode.json' with { type: 'json' };
import pi from '../catalogs/pi.json' with { type: 'json' };
import manifest from '../.vibex-plugin/plugin.json' with { type: 'json' };

const CATALOGS = [
  antigravity,
  claudeCode,
  cline,
  codex,
  deepseekHarness,
  grok,
  hermes,
  kimiCode,
  mimoCode,
  openclaw,
  opencode,
  pi,
];

function walk(value, visit) {
  if (Array.isArray(value)) {
    value.forEach((item) => walk(item, visit));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    visit(key, child);
    walk(child, visit);
  }
}

test('plugin.json is a v4 catalog package', () => {
  assert.equal(manifest.manifestVersion, 4);
  assert.equal(manifest.id, 'vibex.provider-switch');
  assert.equal(manifest.publisher, 'vibex');
  const kinds = new Set(manifest.integrations.map((item) => item.kind));
  assert.deepEqual([...kinds], ['provider.model.catalog']);
});

test('catalog templates are secret-free fill-ins', () => {
  const secretKeys = new Set(['apikey', 'api_key', 'token', 'authorization', 'auth']);
  const forbidden = new Set([
    'settingsConfig',
    'apiFormat',
    'requiresOAuth',
    'providerType',
    'theme',
    'partnerPromotionKey',
    'isPartner',
    'primePartner',
    'hidden',
    'extras',
    'handler',
  ]);
  for (const data of CATALOGS) {
    assert.equal(data.schemaVersion, 1, data.agentId);
    assert.equal(typeof data.agentId, 'string', data.agentId);
    assert.notEqual(data.agentId, 'gemini', data.agentId);
    assert.ok(data.templates.length > 0, data.agentId);
    const ids = new Set();
    for (const template of data.templates) {
      assert.ok(template.id, `${data.agentId} id`);
      assert.equal(ids.has(template.id), false, `${data.agentId} duplicate ${template.id}`);
      ids.add(template.id);
      if (data.agentId === 'claude_code') {
        assert.notEqual(template.name, 'Claude Official');
      }
    }
    walk(data, (key, value) => {
      assert.equal(secretKeys.has(key.toLowerCase()), false, `${data.agentId} ${key}`);
      assert.equal(forbidden.has(key), false, `${data.agentId} ${key}`);
      if (typeof value === 'string') {
        assert.equal(value.includes('sk-'), false, `${data.agentId} ${key}`);
      }
    });
  }
});

test('converted catalogs keep a full CC-Switch snapshot', () => {
  assert.ok(claudeCode.templates.length >= 80, claudeCode.templates.length);
  assert.ok(codex.templates.length >= 50, codex.templates.length);
  assert.ok(opencode.templates.length >= 70, opencode.templates.length);
});

test('allowlist agents stay on the four named endpoints', () => {
  for (const data of [kimiCode, cline, deepseekHarness]) {
    assert.deepEqual(
      data.templates.map((item) => item.id),
      ['deepseek', 'moonshot', 'openrouter', 'siliconflow'],
    );
  }
});

test('MiMo copies OpenCode templates under its own agent id', () => {
  assert.equal(opencode.agentId, 'opencode');
  assert.equal(mimoCode.agentId, 'mimo_code');
  assert.equal(mimoCode.templates.length, opencode.templates.length);
  assert.deepEqual(
    mimoCode.templates.map((item) => item.id),
    opencode.templates.map((item) => item.id),
  );
});
