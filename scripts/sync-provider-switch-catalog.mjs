#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const pluginRoot = join(repoRoot, 'assets', 'plugins', 'provider-switch');
const catalogsRoot = join(pluginRoot, 'catalogs');
const require = createRequire(join(repoRoot, 'packages/plugin-cli/package.json'));
const esbuild = require('esbuild');

const PI_APIS = new Set([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
]);
const OAUTH_TYPES = new Set(['github_copilot', 'codex_oauth', 'xai_oauth']);
const CLAUDE_MODEL_KEYS = [
  ['main', 'ANTHROPIC_MODEL'],
  ['haiku', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'],
  ['sonnet', 'ANTHROPIC_DEFAULT_SONNET_MODEL'],
  ['opus', 'ANTHROPIC_DEFAULT_OPUS_MODEL'],
  ['reasoning', 'ANTHROPIC_REASONING_MODEL'],
  ['customOption', 'ANTHROPIC_CUSTOM_MODEL_OPTION'],
  ['customOptionName', 'ANTHROPIC_CUSTOM_MODEL_OPTION_NAME'],
  ['customOptionDescription', 'ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION'],
];

const SOURCE = parseSimpleToml(await readFile(join(catalogsRoot, 'SOURCE.toml'), 'utf8'));
const ALLOWLIST = parseAllowlist(
  await readFile(join(catalogsRoot, 'subset-allowlist.toml'), 'utf8'),
);

const srcFlag = flag('--src');
const sourceRoot = srcFlag
  ? resolve(srcFlag)
  : process.env.CC_SWITCH_SRC
    ? resolve(process.env.CC_SWITCH_SRC)
    : await fetchPinnedSource();

await assertPinnedCommit(sourceRoot);
const modules = await loadPresetModules(sourceRoot);

const reports = [];
await writeCatalog(
  'claude_code',
  'reusable',
  convertClaude(modules.claude.providerPresets ?? [], reports),
);
await writeCatalog(
  'codex',
  'reusable',
  convertCodex(modules.codex.codexProviderPresets ?? [], reports),
);
await writeCatalog(
  'antigravity',
  'reusable',
  convertGemini(modules.gemini.geminiProviderPresets ?? [], reports),
);
await writeCatalog(
  'grok',
  'reusable',
  convertGrok(modules.grok.grokBuildProviderPresets ?? [], reports),
);
await writeCatalog(
  'pi',
  'reusable',
  convertPi(modules.pi.piProviderPresets ?? [], reports),
);
await writeCatalog(
  'hermes',
  'reusable',
  convertHermes(modules.hermes.hermesProviderPresets ?? [], reports),
);
await writeCatalog(
  'openclaw',
  'reusable',
  convertOpenClaw(modules.openclaw.openclawProviderPresets ?? [], reports),
);
const opencode = convertOpenCode(
  modules.opencode.opencodeProviderPresets ?? [],
  reports,
);
await writeCatalog('opencode', 'opencode', opencode);
await writeCatalog(
  'mimo_code',
  'opencode',
  opencode.map((template) => ({ ...template })),
);
await writeCatalog(
  'kimi_code',
  'reusable',
  convertAllowlist('kimi_code', 'reusable'),
);
await writeCatalog(
  'cline',
  'reusable',
  convertAllowlist('cline', 'reusable'),
);
await writeCatalog(
  'deepseek_harness',
  'dsh',
  convertAllowlist('deepseek_harness', 'dsh'),
);

for (const line of reports) console.log(line);

function flag(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  return process.argv[index + 1] ?? null;
}

async function fetchPinnedSource() {
  const root = await mkdtemp(join(tmpdir(), 'cc-switch-'));
  await run('git', [
    'clone',
    '--depth',
    '1',
    '--branch',
    SOURCE.tag,
    SOURCE.repository,
    root,
  ]);
  return root;
}

async function assertPinnedCommit(root) {
  try {
    const sha = (await run('git', ['-C', root, 'rev-parse', 'HEAD'])).trim();
    if (sha !== SOURCE.commit) {
      throw new Error(
        `CC-Switch HEAD ${sha} does not match catalogs/SOURCE.toml commit ${SOURCE.commit}`,
      );
    }
  } catch (error) {
    if (!srcFlag && !process.env.CC_SWITCH_SRC) throw error;
    console.warn(
      `Skipping git pin check for ${root}: ${error instanceof Error ? error.message : error}`,
    );
  }
}

async function loadPresetModules(root) {
  const configDir = join(root, 'src', 'config');
  const files = {
    claude: 'claudeProviderPresets.ts',
    codex: 'codexProviderPresets.ts',
    gemini: 'geminiProviderPresets.ts',
    grok: 'grokBuildProviderPresets.ts',
    pi: 'piProviderPresets.ts',
    hermes: 'hermesProviderPresets.ts',
    openclaw: 'openclawProviderPresets.ts',
    opencode: 'opencodeProviderPresets.ts',
  };
  const loaded = {};
  const staging = await mkdtemp(join(tmpdir(), 'provider-switch-bundle-'));
  try {
    for (const [key, file] of Object.entries(files)) {
      const outfile = join(staging, `${key}.mjs`);
      await esbuild.build({
        absWorkingDir: configDir,
        entryPoints: [join(configDir, file)],
        outfile,
        bundle: true,
        format: 'esm',
        platform: 'node',
        target: 'node20',
        logLevel: 'silent',
        plugins: [stubPlugin()],
      });
      loaded[key] = await import(pathToFileURL(outfile).href);
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return loaded;
}

function stubPlugin() {
  return {
    name: 'cc-switch-stubs',
    setup(build) {
      build.onResolve({ filter: /(?:^|\/)types(?:\.ts)?$/ }, (args) => {
        if (args.path.includes('piThinking') || args.path.includes('piModel')) {
          return null;
        }
        if (
          args.path === '../types' ||
          args.path === '@/types' ||
          args.path.endsWith('/types') ||
          args.path.endsWith('/types.ts')
        ) {
          return { path: 'types-stub', namespace: 'stub' };
        }
        return null;
      });
      build.onResolve({ filter: /grokBuildConfig/ }, () => ({
        path: 'grok-stub',
        namespace: 'stub',
      }));
      build.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => {
        if (args.path === 'grok-stub') {
          return {
            contents: 'export const GROK_BUILD_DEFAULT_MODEL = "grok-4.5";',
            loader: 'js',
          };
        }
        return { contents: 'export {};', loader: 'js' };
      });
    },
  };
}

function convertClaude(presets, reports) {
  const used = new Set();
  const skip = emptySkip();
  const templates = [];
  for (const preset of presets) {
    const blocked = globalSkip(preset);
    if (blocked) {
      skip[blocked] += 1;
      continue;
    }
    if (preset.apiFormat && preset.apiFormat !== 'anthropic') {
      skip.format += 1;
      continue;
    }
    const env = object(object(preset.settingsConfig).env);
    const apiUrl = publicUrl(env.ANTHROPIC_BASE_URL);
    if (!apiUrl) {
      skip['no-url'] += 1;
      continue;
    }
    const model = {};
    for (const [key, envName] of CLAUDE_MODEL_KEYS) {
      const value = text(env[envName]);
      if (value) model[key] = value;
    }
    const chrome = chromeFields(preset, used, skip);
    if (!chrome) continue;
    templates.push({
      ...chrome,
      surface: 'reusable',
      apiUrl,
      model: JSON.stringify(model),
      ...(text(preset.apiKeyField) ? { apiKeyField: text(preset.apiKeyField) } : {}),
    });
  }
  reports.push(reportLine('claude_code', presets.length, templates.length, skip));
  return templates;
}

function convertCodex(presets, reports) {
  const used = new Set();
  const skip = emptySkip();
  const templates = [];
  for (const preset of presets) {
    const blocked = globalSkip(preset);
    if (blocked) {
      skip[blocked] += 1;
      continue;
    }
    if (preset.apiFormat && preset.apiFormat !== 'openai_responses') {
      skip.format += 1;
      continue;
    }
    const config = String(preset.config ?? '');
    const wire = tomlString(config, 'wire_api') ?? 'responses';
    if (wire !== 'responses') {
      skip.format += 1;
      continue;
    }
    const apiUrl = publicUrl(tomlString(config, 'base_url'));
    if (!apiUrl) {
      skip['no-url'] += 1;
      continue;
    }
    const chrome = chromeFields(preset, used, skip);
    if (!chrome) continue;
    templates.push({
      ...chrome,
      surface: 'reusable',
      apiUrl,
      model: serializeCodexModel(preset, config),
    });
  }
  reports.push(reportLine('codex', presets.length, templates.length, skip));
  return templates;
}

function convertGemini(presets, reports) {
  const used = new Set();
  const skip = emptySkip();
  const templates = [];
  for (const preset of presets) {
    const blocked = globalSkip(preset);
    if (blocked) {
      skip[blocked] += 1;
      continue;
    }
    const env = object(object(preset.settingsConfig).env);
    const apiUrl = publicUrl(
      env.GEMINI_BASE_URL ||
        env.GOOGLE_GEMINI_BASE_URL ||
        env.API_BASE_URL ||
        preset.baseURL,
    );
    const model = text(env.GEMINI_MODEL || preset.model);
    if (!apiUrl || !model) {
      skip['no-url'] += 1;
      continue;
    }
    const chrome = chromeFields(preset, used, skip);
    if (!chrome) continue;
    templates.push({
      ...chrome,
      surface: 'reusable',
      apiUrl,
      model,
    });
  }
  reports.push(reportLine('antigravity', presets.length, templates.length, skip));
  return templates;
}

function convertGrok(presets, reports) {
  const used = new Set();
  const skip = emptySkip();
  const templates = [];
  for (const preset of presets) {
    const blocked = globalSkip(preset);
    if (blocked) {
      skip[blocked] += 1;
      continue;
    }
    const config = String(preset.config ?? '');
    const wire = tomlString(config, 'wire_api') ?? 'responses';
    if (wire !== 'responses') {
      skip.format += 1;
      continue;
    }
    const apiUrl = publicUrl(tomlString(config, 'base_url'));
    const modelId = text(tomlString(config, 'model'));
    if (!apiUrl || !modelId) {
      skip['no-url'] += 1;
      continue;
    }
    const chrome = chromeFields(preset, used, skip);
    if (!chrome) continue;
    templates.push({
      ...chrome,
      surface: 'reusable',
      apiUrl,
      model: JSON.stringify({
        id: modelId,
        api_backend: 'responses',
        context_window: null,
        models: [modelId],
      }),
    });
  }
  reports.push(reportLine('grok', presets.length, templates.length, skip));
  return templates;
}

function convertPi(presets, reports) {
  const used = new Set();
  const skip = emptySkip();
  const templates = [];
  for (const preset of presets) {
    const blocked = globalSkip(preset);
    if (blocked) {
      skip[blocked] += 1;
      continue;
    }
    const settings = object(preset.settingsConfig);
    const api = text(settings.api);
    if (!api || !PI_APIS.has(api)) {
      skip.format += 1;
      continue;
    }
    const apiUrl = publicUrl(settings.baseUrl);
    const ids = modelIds(settings.models);
    if (!apiUrl || ids.length === 0) {
      skip['no-url'] += 1;
      continue;
    }
    const chrome = chromeFields(preset, used, skip);
    if (!chrome) continue;
    templates.push({
      ...chrome,
      surface: 'reusable',
      apiUrl,
      model: JSON.stringify({
        id: ids[0],
        api,
        models: ids,
      }),
    });
  }
  reports.push(reportLine('pi', presets.length, templates.length, skip));
  return templates;
}

function convertHermes(presets, reports) {
  const used = new Set();
  const skip = emptySkip();
  const templates = [];
  for (const preset of presets) {
    const blocked = globalSkip(preset);
    if (blocked) {
      skip[blocked] += 1;
      continue;
    }
    const settings = object(preset.settingsConfig);
    if (settings.api_mode && settings.api_mode !== 'chat_completions') {
      skip.format += 1;
      continue;
    }
    const apiUrl = publicUrl(settings.base_url);
    const ids = modelIds(settings.models);
    if (!apiUrl || ids.length === 0) {
      skip['no-url'] += 1;
      continue;
    }
    const suggested = text(object(object(preset.suggestedDefaults).model).default);
    const defaultId = ids.includes(suggested) ? suggested : ids[0];
    const chrome = chromeFields(preset, used, skip);
    if (!chrome) continue;
    templates.push({
      ...chrome,
      surface: 'reusable',
      apiUrl,
      model:
        ids.length === 1
          ? defaultId
          : JSON.stringify({ default: defaultId, models: ids }),
    });
  }
  reports.push(reportLine('hermes', presets.length, templates.length, skip));
  return templates;
}

function convertOpenClaw(presets, reports) {
  const used = new Set();
  const skip = emptySkip();
  const templates = [];
  for (const preset of presets) {
    const blocked = globalSkip(preset);
    if (blocked) {
      skip[blocked] += 1;
      continue;
    }
    const settings = object(preset.settingsConfig);
    if (settings.api && settings.api !== 'openai-completions') {
      skip.format += 1;
      continue;
    }
    const apiUrl = publicUrl(settings.baseUrl);
    const ids = modelIds(settings.models);
    if (!apiUrl || ids.length === 0) {
      skip['no-url'] += 1;
      continue;
    }
    const suggested = stripProviderPrefix(
      text(object(object(preset.suggestedDefaults).model).primary),
    );
    const defaultId = ids.includes(suggested) ? suggested : ids[0];
    const chrome = chromeFields(preset, used, skip);
    if (!chrome) continue;
    templates.push({
      ...chrome,
      surface: 'reusable',
      apiUrl,
      model:
        ids.length === 1
          ? defaultId
          : JSON.stringify({ default: defaultId, models: ids }),
    });
  }
  reports.push(reportLine('openclaw', presets.length, templates.length, skip));
  return templates;
}

function convertOpenCode(presets, reports) {
  const used = new Set();
  const skip = emptySkip();
  const templates = [];
  for (const preset of presets) {
    const blocked = globalSkip(preset);
    if (blocked) {
      skip[blocked] += 1;
      continue;
    }
    const settings = object(preset.settingsConfig);
    const providerId = slug(preset.name);
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(providerId)) {
      skip.format += 1;
      continue;
    }
    const baseUrl = publicUrl(object(settings.options).baseURL);
    const models = Object.entries(object(settings.models)).map(([id, value]) => ({
      id,
      name: text(object(value).name) || id,
    }));
    if (!baseUrl || models.length === 0) {
      skip['no-url'] += 1;
      continue;
    }
    const chrome = chromeFields(preset, used, skip, providerId);
    if (!chrome) continue;
    const npm = text(settings.npm);
    templates.push({
      ...chrome,
      surface: 'opencode',
      providerId,
      ...(npm ? { npm } : {}),
      ...(inferOpenCodeApi(npm) ? { api: inferOpenCodeApi(npm) } : {}),
      baseUrl,
      models,
    });
  }
  reports.push(reportLine('opencode', presets.length, templates.length, skip));
  return templates;
}

function convertAllowlist(agentId, surface) {
  const rows = ALLOWLIST[agentId] ?? [];
  if (rows.length === 0) {
    throw new Error(`subset-allowlist.toml is missing [[${agentId}]]`);
  }
  return rows.map((row) => {
    if (surface === 'dsh') {
      return omitEmpty({
        id: row.id,
        name: row.name,
        websiteUrl: row.websiteUrl,
        category: row.category,
        surface,
        displayName: row.name,
        baseUrl: row.apiUrl,
        api: 'openai-completions',
        defaultModel: row.model,
        models: [{ id: row.model }],
      });
    }
    return omitEmpty({
      id: row.id,
      name: row.name,
      websiteUrl: row.websiteUrl,
      category: row.category,
      surface,
      apiUrl: row.apiUrl,
      model: row.model,
    });
  });
}

function chromeFields(preset, used, skip, forcedId) {
  const name = text(preset.name);
  if (!name) {
    skip['no-url'] += 1;
    return null;
  }
  const websiteUrl = publicUrl(preset.websiteUrl, { stripQuery: true });
  const apiKeyUrl = publicUrl(preset.apiKeyUrl, { stripQuery: true });
  const endpointCandidates = Array.isArray(preset.endpointCandidates)
    ? preset.endpointCandidates.map((item) => publicUrl(item)).filter(Boolean)
    : [];
  return omitEmpty({
    id: uniqueId(forcedId || slug(name), used),
    name,
    websiteUrl,
    apiKeyUrl,
    endpointCandidates,
    category: categoryOf(preset),
  });
}

function globalSkip(preset) {
  if (preset?.hidden === true) return 'hidden';
  if (preset?.requiresOAuth === true) return 'oauth';
  if (OAUTH_TYPES.has(preset?.providerType)) return 'oauth';
  return null;
}

function categoryOf(preset) {
  if (preset.category === 'official') return 'official';
  if (preset.primePartner) return 'prime';
  if (preset.isPartner) return 'partner';
  return 'community';
}

function serializeCodexModel(preset, config) {
  const defaultModel = text(tomlString(config, 'model')) || null;
  const catalog = Array.isArray(preset.modelCatalog) ? preset.modelCatalog : [];
  const customs = catalog
    .map((item) => {
      if (typeof item === 'string') {
        return {
          slug: item,
          display_name: item,
          context_window: null,
          base: item,
        };
      }
      const slug = text(object(item).model);
      if (!slug) return null;
      return {
        slug,
        display_name: text(object(item).displayName) || slug,
        context_window: object(item).contextWindow ?? null,
        base: slug,
      };
    })
    .filter(Boolean);
  return JSON.stringify({
    default_model: defaultModel,
    customs,
    excluded_officials: [],
  });
}

function inferOpenCodeApi(npm) {
  if (npm === '@ai-sdk/anthropic') return 'anthropic';
  if (npm === '@ai-sdk/openai-compatible' || npm === '@ai-sdk/openai') {
    return 'openai-compatible';
  }
  return null;
}

function publicUrl(value, options = {}) {
  const raw = text(value);
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  url.searchParams.delete('aff');
  for (const key of url.searchParams.keys()) {
    const normalized = key.toLowerCase();
    if (normalized === 'token' || normalized === 'api_key' || normalized === 'aff') {
      return null;
    }
  }
  if (options.stripQuery) {
    url.search = '';
    url.hash = '';
  }
  return url.toString();
}

function tomlString(toml, key) {
  const match = String(toml).match(new RegExp(`(?:^|\\n)${key}\\s*=\\s*("(?:\\\\.|[^"\\\\])*")`));
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function modelIds(models) {
  if (!Array.isArray(models)) return [];
  return models.map((item) => text(object(item).id) || text(item)).filter(Boolean);
}

function stripProviderPrefix(value) {
  if (!value) return '';
  const index = value.indexOf('/');
  return index >= 0 ? value.slice(index + 1) : value;
}

function slug(name) {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function uniqueId(base, used) {
  const seed = base || 'provider';
  if (!used.has(seed)) {
    used.add(seed);
    return seed;
  }
  let n = 2;
  while (used.has(`${seed}-${n}`)) n += 1;
  const next = `${seed}-${n}`;
  used.add(next);
  return next;
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function omitEmpty(record) {
  const out = {};
  for (const [key, value] of Object.entries(record)) {
    if (value == null || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

function emptySkip() {
  return { oauth: 0, hidden: 0, format: 0, 'no-url': 0, invalid: 0 };
}

function reportLine(agentId, total, kept, skip) {
  const skipped = Object.values(skip).reduce((sum, n) => sum + n, 0);
  const detail = Object.entries(skip)
    .filter(([, n]) => n > 0)
    .map(([reason, n]) => `${reason}: ${n}`)
    .join(', ');
  return `${agentId}: kept ${kept} / ${total} skipped ${skipped}${detail ? ` (${detail})` : ''}`;
}

async function writeCatalog(agentId, _surface, templates) {
  const file = {
    schemaVersion: 1,
    agentId,
    templates,
  };
  await writeFile(
    join(catalogsRoot, `${agentId}.json`),
    `${JSON.stringify(file, null, 2)}\n`,
  );
}

function parseSimpleToml(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*"([^"]*)"\s*$/);
    if (match) out[match[1]] = match[2];
  }
  return out;
}

function parseAllowlist(text) {
  const out = {};
  let current = null;
  let row = null;
  const flush = () => {
    if (current && row) {
      out[current] ??= [];
      out[current].push(row);
    }
    row = null;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const section = line.match(/^\[\[([A-Za-z0-9_]+)\]\]$/);
    if (section) {
      flush();
      current = section[1];
      row = {};
      continue;
    }
    const match = line.match(/^([A-Za-z0-9_]+)\s*=\s*"([^"]*)"\s*$/);
    if (match && row) row[match[1]] = match[2];
  }
  flush();
  return out;
}

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolveRun(stdout);
      else reject(new Error(`${command} ${args.join(' ')} failed: ${stderr || stdout}`));
    });
  });
}
