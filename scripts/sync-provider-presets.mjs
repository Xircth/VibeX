#!/usr/bin/env node
// Converts the pinned CC-Switch preset snapshot into the Host's built-in
// provider preset catalogs and copies the icons those presets reference.
//
//   node scripts/sync-provider-presets.mjs [--src <cc-switch checkout>]
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const presetsRoot = join(repoRoot, 'frontend', 'src', 'features', 'provider-presets');
const catalogsRoot = join(presetsRoot, 'catalogs');
const iconsRoot = join(repoRoot, 'frontend', 'public', 'provider-icons');
const require = createRequire(join(repoRoot, 'packages/plugin-cli/package.json'));
const esbuild = require('esbuild');

const PI_APIS = new Set([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
]);
const OAUTH_TYPES = new Set(['github_copilot', 'codex_oauth', 'xai_oauth']);
const CATEGORY_RANK = { official: 0, prime: 1, partner: 2, community: 3 };
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

const SOURCE = parseSimpleToml(await readFile(join(presetsRoot, 'SOURCE.toml'), 'utf8'));
const ALLOWLIST = parseAllowlist(
  await readFile(join(presetsRoot, 'subset-allowlist.toml'), 'utf8'),
);

const srcFlag = flag('--src');
const sourceRoot = srcFlag ? resolve(srcFlag) : await fetchPinnedSource();
await assertPinnedCommit(sourceRoot);
const modules = await loadSourceModules(sourceRoot);

const reports = [];
const catalogs = {
  claude_code: convertClaude(modules.claude.providerPresets, reports),
  codex: convertCodex(modules.codex.codexProviderPresets, reports),
  antigravity: convertGemini(modules.gemini.geminiProviderPresets, reports),
  grok: convertGrok(modules.grok.grokBuildProviderPresets, reports),
  pi: convertPiShape('pi', modules.pi.piProviderPresets, reports),
  omp: convertPiShape('omp', modules.omp.ompProviderPresets, reports),
  hermes: convertHermes(modules.hermes.hermesProviderPresets, reports),
  openclaw: convertOpenClaw(modules.openclaw.openclawProviderPresets, reports),
  kimi_code: convertKimi(modules.pi.piProviderPresets, reports),
  deepseek_harness: convertDsh(modules.dsh.dshProviderPresets, reports),
  opencode: convertOpenCode(modules.opencode.opencodeProviderPresets, reports),
  cline: convertAllowlist('cline'),
};

await rm(catalogsRoot, { recursive: true, force: true });
await rm(iconsRoot, { recursive: true, force: true });
await mkdir(catalogsRoot, { recursive: true });
await mkdir(iconsRoot, { recursive: true });

const usedIcons = new Set();
for (const [agentId, templates] of Object.entries(catalogs)) {
  const sorted = sortTemplates(templates);
  for (const template of sorted) {
    if (template.icon) usedIcons.add(template.icon);
  }
  await writeJson(join(catalogsRoot, `${agentId}.json`), sorted);
}
const iconIndex = await writeIcons(usedIcons, modules.icons);
await writeJson(join(presetsRoot, 'icons.json'), iconIndex);

for (const line of reports) console.log(line);
console.log(`icons: ${Object.keys(iconIndex).length} / ${usedIcons.size} referenced`);

function flag(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : (process.argv[index + 1] ?? null);
}

async function fetchPinnedSource() {
  const root = await mkdtemp(join(tmpdir(), 'cc-switch-'));
  await run('git', ['clone', '--depth', '1', '--branch', SOURCE.tag, SOURCE.repository, root]);
  return root;
}

async function assertPinnedCommit(root) {
  const sha = (await run('git', ['-C', root, 'rev-parse', 'HEAD'])).trim();
  if (sha !== SOURCE.commit) {
    throw new Error(`CC-Switch HEAD ${sha} does not match SOURCE.toml commit ${SOURCE.commit}`);
  }
}

async function loadSourceModules(root) {
  const configDir = join(root, 'src', 'config');
  const entries = {
    claude: join(configDir, 'claudeProviderPresets.ts'),
    codex: join(configDir, 'codexProviderPresets.ts'),
    gemini: join(configDir, 'geminiProviderPresets.ts'),
    grok: join(configDir, 'grokBuildProviderPresets.ts'),
    pi: join(configDir, 'piProviderPresets.ts'),
    omp: join(configDir, 'ompProviderPresets.ts'),
    dsh: join(configDir, 'dshProviderPresets.ts'),
    hermes: join(configDir, 'hermesProviderPresets.ts'),
    openclaw: join(configDir, 'openclawProviderPresets.ts'),
    opencode: join(configDir, 'opencodeProviderPresets.ts'),
    icons: join(root, 'src', 'icons', 'extracted', 'index.ts'),
  };
  const loaded = {};
  const staging = await mkdtemp(join(tmpdir(), 'provider-presets-bundle-'));
  try {
    for (const [key, entry] of Object.entries(entries)) {
      const outfile = join(staging, `${key}.mjs`);
      await esbuild.build({
        absWorkingDir: dirname(entry),
        entryPoints: [entry],
        outfile,
        bundle: true,
        format: 'esm',
        platform: 'node',
        target: 'node20',
        logLevel: 'silent',
        alias: { '@': join(root, 'src') },
        plugins: [assetPathPlugin()],
      });
      loaded[key] = await import(pathToFileURL(outfile).href);
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return loaded;
}

// Image imports evaluate to their absolute source path so icons can be copied.
// Preset modules are plain data; npm packages they import are never installed
// from the untrusted checkout and resolve to an inert proxy instead.
function assetPathPlugin() {
  return {
    name: 'cc-switch-asset-paths',
    setup(build) {
      build.onResolve({ filter: /^[^./@]|^@[^/]+\// }, (args) =>
        args.kind === 'entry-point'
          ? undefined
          : { path: args.path, namespace: 'npm-stub' },
      );
      build.onLoad({ filter: /.*/, namespace: 'npm-stub' }, () => ({
        contents:
          'const inert = new Proxy(function () {}, { get: (_, key) => key === Symbol.toPrimitive ? () => "" : inert, apply: () => inert, construct: () => inert });\nmodule.exports = inert;',
        loader: 'js',
      }));
      build.onResolve({ filter: /\.(png|jpe?g|svg|webp)(\?url)?$/ }, (args) => ({
        path: resolve(args.resolveDir, args.path.replace(/\?url$/, '')),
        namespace: 'asset-path',
      }));
      build.onLoad({ filter: /.*/, namespace: 'asset-path' }, (args) => ({
        contents: `export default ${JSON.stringify(args.path)};`,
        loader: 'js',
      }));
    },
  };
}

function convertClaude(presets, reports) {
  return convertEach('claude_code', presets, reports, (preset, skip) => {
    if (preset.apiFormat && preset.apiFormat !== 'anthropic') return skipAs(skip, 'format');
    const env = object(object(preset.settingsConfig).env);
    const apiUrl = publicUrl(env.ANTHROPIC_BASE_URL);
    if (!apiUrl) return skipAs(skip, 'no-url');
    const model = {};
    for (const [key, envName] of CLAUDE_MODEL_KEYS) {
      const value = text(env[envName]);
      if (value) model[key] = value;
    }
    return {
      surface: 'reusable',
      api_url: apiUrl,
      model: JSON.stringify(model),
      api_key_field: text(preset.apiKeyField),
    };
  });
}

function convertCodex(presets, reports) {
  return convertEach('codex', presets, reports, (preset, skip) => {
    if (preset.apiFormat && preset.apiFormat !== 'openai_responses') return skipAs(skip, 'format');
    const config = String(preset.config ?? '');
    if ((tomlString(config, 'wire_api') ?? 'responses') !== 'responses') {
      return skipAs(skip, 'format');
    }
    const apiUrl = publicUrl(tomlString(config, 'base_url'));
    if (!apiUrl) return skipAs(skip, 'no-url');
    return { surface: 'reusable', api_url: apiUrl, model: serializeCodexModel(preset, config) };
  });
}

function convertGemini(presets, reports) {
  return convertEach('antigravity', presets, reports, (preset, skip) => {
    const env = object(object(preset.settingsConfig).env);
    const apiUrl = publicUrl(
      env.GEMINI_BASE_URL || env.GOOGLE_GEMINI_BASE_URL || env.API_BASE_URL || preset.baseURL,
    );
    const model = text(env.GEMINI_MODEL || preset.model);
    if (!apiUrl || !model) return skipAs(skip, 'no-url');
    return { surface: 'reusable', api_url: apiUrl, model };
  });
}

function convertGrok(presets, reports) {
  return convertEach('grok', presets, reports, (preset, skip) => {
    const config = String(preset.config ?? '');
    if ((tomlString(config, 'wire_api') ?? 'responses') !== 'responses') {
      return skipAs(skip, 'format');
    }
    const apiUrl = publicUrl(tomlString(config, 'base_url'));
    const modelId = text(tomlString(config, 'model'));
    if (!apiUrl || !modelId) return skipAs(skip, 'no-url');
    return {
      surface: 'reusable',
      api_url: apiUrl,
      model: JSON.stringify({
        id: modelId,
        api_backend: 'responses',
        context_window: null,
        models: [modelId],
      }),
    };
  });
}

// Pi and Oh My Pi share the `{ id, api, models }` model mapping.
function convertPiShape(agentId, presets, reports) {
  return convertEach(agentId, presets, reports, (preset, skip) => {
    const settings = object(preset.settingsConfig);
    const api = text(settings.api);
    if (!PI_APIS.has(api)) return skipAs(skip, 'format');
    const apiUrl = publicUrl(settings.baseUrl);
    const ids = modelIds(settings.models);
    if (!apiUrl || ids.length === 0) return skipAs(skip, 'no-url');
    return {
      surface: 'reusable',
      api_url: apiUrl,
      model: JSON.stringify({ id: ids[0], api, models: ids }),
    };
  });
}

// Kimi Code is projected as an OpenAI chat-completions provider, so only Pi
// presets on that wire without vendor compat flags carry over.
function convertKimi(presets, reports) {
  return convertEach('kimi_code', presets, reports, (preset, skip) => {
    const settings = object(preset.settingsConfig);
    if (settings.api !== 'openai-completions' || settings.compat) return skipAs(skip, 'format');
    const apiUrl = publicUrl(settings.baseUrl);
    const ids = modelIds(settings.models);
    if (!apiUrl || ids.length === 0) return skipAs(skip, 'no-url');
    return { surface: 'reusable', api_url: apiUrl, model: ids[0] };
  });
}

// DeepSeek Harness custom providers speak OpenAI chat completions only.
function convertDsh(presets, reports) {
  return convertEach('deepseek_harness', presets, reports, (preset, skip) => {
    const settings = object(preset.settingsConfig);
    if (settings.api !== 'openai-completions') return skipAs(skip, 'format');
    const baseUrl = publicUrl(object(settings.options).baseURL);
    const models = Object.entries(object(settings.models)).map(([id, value]) =>
      omitEmpty({ id, name: text(object(value).name) }),
    );
    if (!baseUrl || models.length === 0) return skipAs(skip, 'no-url');
    return {
      surface: 'dsh',
      display_name: text(preset.name),
      base_url: baseUrl,
      api: 'openai-completions',
      default_model: models[0].id,
      models,
    };
  });
}

function convertHermes(presets, reports) {
  return convertEach('hermes', presets, reports, (preset, skip) => {
    const settings = object(preset.settingsConfig);
    if (settings.api_mode && settings.api_mode !== 'chat_completions') {
      return skipAs(skip, 'format');
    }
    const apiUrl = publicUrl(settings.base_url);
    const ids = modelIds(settings.models);
    if (!apiUrl || ids.length === 0) return skipAs(skip, 'no-url');
    const suggested = text(object(object(preset.suggestedDefaults).model).default);
    return { surface: 'reusable', api_url: apiUrl, model: defaultModelValue(ids, suggested) };
  });
}

function convertOpenClaw(presets, reports) {
  return convertEach('openclaw', presets, reports, (preset, skip) => {
    const settings = object(preset.settingsConfig);
    if (settings.api && settings.api !== 'openai-completions') return skipAs(skip, 'format');
    const apiUrl = publicUrl(settings.baseUrl);
    const ids = modelIds(settings.models);
    if (!apiUrl || ids.length === 0) return skipAs(skip, 'no-url');
    const suggested = stripProviderPrefix(
      text(object(object(preset.suggestedDefaults).model).primary),
    );
    return { surface: 'reusable', api_url: apiUrl, model: defaultModelValue(ids, suggested) };
  });
}

function convertOpenCode(presets, reports) {
  return convertEach('opencode', presets, reports, (preset, skip) => {
    const settings = object(preset.settingsConfig);
    const providerId = slug(preset.name);
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(providerId)) return skipAs(skip, 'format');
    const baseUrl = publicUrl(object(settings.options).baseURL);
    const models = Object.entries(object(settings.models)).map(([id, value]) => ({
      id,
      name: text(object(value).name) || id,
    }));
    if (!baseUrl || models.length === 0) return skipAs(skip, 'no-url');
    const npm = text(settings.npm);
    return {
      id: providerId,
      surface: 'opencode',
      provider_id: providerId,
      npm,
      api: inferOpenCodeApi(npm),
      base_url: baseUrl,
      models,
    };
  });
}

function convertEach(agentId, presets, reports, convert) {
  if (!Array.isArray(presets)) throw new Error(`${agentId}: preset export is missing`);
  const used = new Set();
  const skip = { oauth: 0, hidden: 0, format: 0, 'no-url': 0 };
  const templates = [];
  for (const preset of presets) {
    const blocked = globalSkip(preset);
    if (blocked) {
      skip[blocked] += 1;
      continue;
    }
    const name = text(preset.name);
    if (!name) {
      skip['no-url'] += 1;
      continue;
    }
    const body = convert(preset, skip);
    if (!body) continue;
    templates.push(
      omitEmpty({
        id: uniqueId(body.id || slug(name), used),
        name,
        icon: text(preset.icon).toLowerCase(),
        website_url: publicUrl(preset.websiteUrl, { stripQuery: true }),
        api_key_url: publicUrl(preset.apiKeyUrl, { stripQuery: true }),
        endpoint_candidates: Array.isArray(preset.endpointCandidates)
          ? preset.endpointCandidates.map((item) => publicUrl(item)).filter(Boolean)
          : [],
        category: categoryOf(preset),
        ...body,
      }),
    );
  }
  reports.push(reportLine(agentId, presets.length, templates.length, skip));
  return templates;
}

function convertAllowlist(agentId) {
  const rows = ALLOWLIST[agentId] ?? [];
  if (rows.length === 0) throw new Error(`subset-allowlist.toml is missing [[${agentId}]]`);
  return rows.map((row) =>
    omitEmpty({
      id: row.id,
      name: row.name,
      icon: row.icon,
      website_url: row.websiteUrl,
      category: row.category,
      surface: 'reusable',
      api_url: row.apiUrl,
      model: row.model,
    }),
  );
}

function skipAs(skip, reason) {
  skip[reason] += 1;
  return null;
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

// Official, prime and partner rows keep upstream order; the rest sort by name.
function sortTemplates(templates) {
  return templates
    .map((template, index) => ({ template, index }))
    .sort((left, right) => {
      const rank = CATEGORY_RANK[left.template.category] - CATEGORY_RANK[right.template.category];
      if (rank !== 0) return rank;
      if (left.template.category !== 'community') return left.index - right.index;
      return left.template.name.localeCompare(right.template.name, 'en');
    })
    .map(({ template }) => template);
}

// Monochrome SVGs render as a mask in the current text color; other images
// that may draw dark ink on a transparent ground get a light backing in dark mode.
async function writeIcons(names, iconModule) {
  const index = {};
  for (const name of [...names].sort()) {
    const tile = iconModule.isTileIcon?.(name) === true;
    const svg = iconModule.getIcon(name);
    if (svg) {
      const ink = !tile && isMonochrome(svg, iconModule.isDarkInk);
      const file = `${name}.svg`;
      await writeFile(join(iconsRoot, file), `${svg.trim()}\n`);
      index[name] = omitEmpty({
        file,
        ink: ink || null,
        backing: (!ink && iconModule.needsLightBacking(name)) || null,
      });
      continue;
    }
    const source = iconModule.getIconUrl(name);
    if (!source) {
      console.warn(`icon "${name}" is referenced but not shipped by CC-Switch`);
      continue;
    }
    const file = `${name}${extname(basename(source)).toLowerCase()}`;
    await copyFile(source, join(iconsRoot, file));
    index[name] = omitEmpty({ file, backing: !tile || null });
  }
  return index;
}

// Every painted color is near-black or currentColor (an unset fill paints
// black), so the glyph can follow the text color.
function isMonochrome(svg, isDarkInk) {
  const body = svg.replace(/<(defs|clipPath|mask)\b[\s\S]*?<\/\1>/g, '');
  if (/<style\b|url\(/.test(body)) return false;
  const paints = [...body.matchAll(/\b(?:fill|stroke)(?:="|:\s*)([^";]+)/g)]
    .map((match) => match[1].trim())
    .filter((color) => color !== 'none');
  return paints.every((color) => color.toLowerCase() === 'currentcolor' || isDarkInk(color));
}

function serializeCodexModel(preset, config) {
  const defaultModel = text(tomlString(config, 'model')) || null;
  const catalog = Array.isArray(preset.modelCatalog) ? preset.modelCatalog : [];
  const customs = catalog
    .map((item) => {
      if (typeof item === 'string') {
        return { slug: item, display_name: item, context_window: null, base: item };
      }
      const model = text(object(item).model);
      if (!model) return null;
      return {
        slug: model,
        display_name: text(object(item).displayName) || model,
        context_window: object(item).contextWindow ?? null,
        base: model,
      };
    })
    .filter(Boolean);
  return JSON.stringify({ default_model: defaultModel, customs, excluded_officials: [] });
}

function defaultModelValue(ids, suggested) {
  const defaultId = ids.includes(suggested) ? suggested : ids[0];
  return ids.length === 1 ? defaultId : JSON.stringify({ default: defaultId, models: ids });
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
    if (normalized === 'token' || normalized === 'api_key') return null;
  }
  if (options.stripQuery) {
    url.search = '';
    url.hash = '';
  }
  return url.toString();
}

function tomlString(toml, key) {
  const match = String(toml).match(
    new RegExp(`(?:^|\\n)${key}\\s*=\\s*("(?:\\\\.|[^"\\\\])*")`),
  );
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
  let next = seed;
  for (let n = 2; used.has(next); n += 1) next = `${seed}-${n}`;
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

function reportLine(agentId, total, kept, skip) {
  const skipped = Object.values(skip).reduce((sum, n) => sum + n, 0);
  const detail = Object.entries(skip)
    .filter(([, n]) => n > 0)
    .map(([reason, n]) => `${reason}: ${n}`)
    .join(', ');
  return `${agentId}: kept ${kept} / ${total} skipped ${skipped}${detail ? ` (${detail})` : ''}`;
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function parseSimpleToml(source) {
  const out = {};
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*"([^"]*)"\s*$/);
    if (match) out[match[1]] = match[2];
  }
  return out;
}

function parseAllowlist(source) {
  const out = {};
  let current = null;
  let row = null;
  const flush = () => {
    if (current && row) (out[current] ??= []).push(row);
    row = null;
  };
  for (const raw of source.split(/\r?\n/)) {
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
