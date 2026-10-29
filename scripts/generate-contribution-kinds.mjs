#!/usr/bin/env node
/**
 * Generates `packages/plugin-contract/catalog/contribution-kinds.v1.json`.
 *
 * The catalog is a projection of two facts and is never hand-edited:
 *
 *   1. the authoring contract — the integration kinds that both the SDK
 *      manifest schema (`packages/plugin-sdk/src/manifest.ts`) and the Plugin
 *      CLI validator (`packages/plugin-cli/src/validation.ts`) accept;
 *   2. the Host consumer — the module that actually renders or executes each
 *      kind, taken from CONSUMERS below and verified against the source tree,
 *      plus whether any official plugin ships that kind.
 *
 * Status follows ADR-0066 §7 and ADR-0069 principle 3 ("a slot ships together
 * with its first official consumer"):
 *
 *   ready         a Host consumer exists and an official plugin uses the kind
 *   preview       a Host consumer exists, no official plugin uses the kind yet
 *   unimplemented no Host runtime consumes the kind at all
 *
 * Usage:
 *   node scripts/generate-contribution-kinds.mjs
 *   node scripts/generate-contribution-kinds.mjs --check
 *     exits 1 when the committed catalog differs from the generated one.
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SDK_MANIFEST = 'packages/plugin-sdk/src/manifest.ts';
const CLI_VALIDATION = 'packages/plugin-cli/src/validation.ts';
const CATALOG = 'packages/plugin-contract/catalog/contribution-kinds.v1.json';
const PLUGINS_DIR = 'plugins';

/**
 * Where each kind is actually consumed at runtime. `symbol` must appear in
 * `file`, so a renamed or deleted consumer fails generation instead of leaving
 * a stale "ready" claim in the published contract.
 */
const CONSUMERS = {
  'content.skill': {
    file: 'crates/plugins/src/package.rs',
    symbol: '"content.skill"',
  },
  'content.mcp': {
    file: 'crates/plugins/src/package.rs',
    symbol: '"content.mcp"',
  },
  'workflow.binding': {
    file: 'crates/plugins/src/package.rs',
    symbol: '"workflow.binding"',
  },
  'file.opener': {
    file: 'crates/plugins/src/package.rs',
    symbol: '"file.opener"',
  },
  'artifact.preview': {
    file: 'frontend/src/components/previews/PluginFilePreview.tsx',
    symbol: 'PluginFilePreview',
  },
  'app.surface': {
    file: 'frontend/src/components/plugins/AppSurfaceHost.tsx',
    symbol: 'AppSurfaceHost',
  },
  'app.command': {
    file: 'frontend/src/components/search/SearchPalette.tsx',
    symbol: 'commandRegistry',
  },
  'app.toolbar': {
    file: 'frontend/src/components/layout/Toolbar.tsx',
    symbol: 'useSlotContributions',
  },
  'app.status': {
    file: 'frontend/src/components/plugins/PluginStatusItems.tsx',
    symbol: 'PluginStatusItems',
  },
  'app.composer.slash': {
    file: 'frontend/src/components/tasks/follow-up/session-composer-input/useSessionComposerCommands.ts',
    symbol: 'useSlashCommands',
  },
  'app.timeline.card': {
    file: 'frontend/src/components/plugins/PluginTimelineCards.tsx',
    symbol: 'PluginTimelineCards',
  },
  'app.settings.section': {
    file: 'frontend/src/components/plugins/PluginSettingsSections.tsx',
    symbol: 'AppSurfaceHost',
  },
  'host.service': {
    file: 'crates/plugins/src/package.rs',
    symbol: 'HostServiceContribution',
  },
  'provider.model.importSource': {
    file: 'frontend/src/pages/settings/agent-model-provider-manager/useProviderFormState.ts',
    symbol: 'provider_import_source',
  },
  'provider.model.catalog': {
    file: 'frontend/src/features/plugins/providers/hostProviderServices.ts',
    symbol: 'provider.model.catalog',
  },
  'app.panel': {
    file: 'frontend/src/components/layout/panels/PanelRegistry.tsx',
    symbol: 'registerBuiltinPanels',
  },
  'app.tab': {
    file: 'frontend/src/components/layout/Toolbar.tsx',
    symbol: 'app_tab',
  },
  'app.kanban.view': {
    file: 'frontend/src/lib/kanbanViewCatalog.ts',
    symbol: 'kanbanViewRegistry',
  },
  'app.settings.page': {
    file: 'frontend/src/pages/settings/SettingsLayout.tsx',
    symbol: 'settingsPageRegistry',
  },
  'app.composer.action': {
    file: 'frontend/src/components/tasks/follow-up/session-composer-input/SessionComposerInput.tsx',
    symbol: 'composer_action',
  },
  'app.rail.section': {
    file: 'frontend/src/components/layout/RightPanelSidebar.tsx',
    symbol: 'app_rail_section',
  },
  'provider.remote.provisioner': {
    file: 'frontend/src/pages/settings/RemoteClientSettings.tsx',
    symbol: 'provisioner',
  },
};

/** Kinds the manifest accepts but no Host runtime consumes. */
const NO_RUNTIME = {
  'content.hook':
    'Host has no Hook runtime (ADR-0066 §7): the manifest validates and inspect warns, nothing executes it.',
};

const PREVIEW_REASON =
  'Host consumer exists, but no official plugin ships this kind yet (ADR-0069 principle 3).';

function fail(message) {
  throw new Error(message);
}

async function readText(relativePath) {
  try {
    return await readFile(join(ROOT, relativePath), 'utf8');
  } catch (error) {
    fail(`cannot read ${relativePath}: ${error.message}`);
  }
}

function quotedStrings(block) {
  return [...block.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

/** Kind set and order from the SDK manifest schema's `integrations.kind.enum`. */
function schemaKinds(manifestSource) {
  const integrations = manifestSource.indexOf('integrations: {');
  if (integrations === -1) fail(`${SDK_MANIFEST}: integrations block not found`);
  const enumAt = manifestSource.indexOf('enum: [', integrations);
  if (enumAt === -1) fail(`${SDK_MANIFEST}: integrations kind enum not found`);
  const end = manifestSource.indexOf(']', enumAt);
  if (end === -1) fail(`${SDK_MANIFEST}: unterminated integrations kind enum`);
  return quotedStrings(manifestSource.slice(enumAt, end));
}

/** `handler` is true when the kind's manifest interface accepts one. */
function interfaceKinds(manifestSource) {
  const kinds = new Map();
  const interfaces = manifestSource.matchAll(
    /export interface (\w+IntegrationManifest)\s+extends IntegrationBase \{([\s\S]*?)\n\}/g
  );
  for (const [, name, body] of interfaces) {
    const kind = body.match(/kind: '([^']+)'/)?.[1];
    if (!kind) fail(`${SDK_MANIFEST}: ${name} declares no kind`);
    kinds.set(kind, /^\s*handler\??:/m.test(body));
  }
  return kinds;
}

/** Kind set the Plugin CLI validates before install. */
function cliKinds(validationSource) {
  const start = validationSource.indexOf('const INTEGRATION_KINDS = new Set([');
  if (start === -1) fail(`${CLI_VALIDATION}: INTEGRATION_KINDS not found`);
  const end = validationSource.indexOf(']);', start);
  if (end === -1) fail(`${CLI_VALIDATION}: unterminated INTEGRATION_KINDS`);
  return [
    ...validationSource
      .slice(start, end)
      .matchAll(/["']([a-zA-Z][a-zA-Z0-9.]*)["']/g),
  ].map((match) => match[1]);
}

/** kind -> number of official plugin integrations that ship it. */
async function officialUsage() {
  const usage = new Map();
  const entries = await readdir(join(ROOT, PLUGINS_DIR), { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(
      ROOT,
      PLUGINS_DIR,
      entry.name,
      '.vibex-plugin',
      'plugin.json'
    );
    let raw;
    try {
      raw = await readFile(manifestPath, 'utf8');
    } catch {
      continue;
    }
    const manifest = JSON.parse(raw);
    for (const integration of manifest.integrations ?? []) {
      const kind = integration.kind;
      if (typeof kind !== 'string') continue;
      usage.set(kind, (usage.get(kind) ?? 0) + 1);
    }
  }
  return usage;
}

function assertSameSet(label, left, right) {
  const missing = left.filter((item) => !right.includes(item));
  const extra = right.filter((item) => !left.includes(item));
  if (missing.length > 0 || extra.length > 0) {
    fail(
      `${label} disagree: missing ${JSON.stringify(missing)}, unexpected ${JSON.stringify(extra)}`
    );
  }
}

async function buildCatalog() {
  const manifestSource = await readText(SDK_MANIFEST);
  const schema = schemaKinds(manifestSource);
  const handlers = interfaceKinds(manifestSource);
  const cli = cliKinds(await readText(CLI_VALIDATION));

  assertSameSet(
    'SDK integration kind enum and manifest interfaces',
    schema,
    [...handlers.keys()]
  );
  assertSameSet('SDK kind enum and Plugin CLI kinds', schema, cli);
  if (new Set(schema).size !== schema.length) {
    fail('SDK integration kind enum contains duplicates');
  }

  const usage = await officialUsage();
  const declared = new Set([...Object.keys(CONSUMERS), ...Object.keys(NO_RUNTIME)]);
  assertSameSet('contract kinds and consumer registry', schema, [...declared]);

  const kinds = [];
  for (const kind of schema) {
    const consumer = CONSUMERS[kind];
    const handler = handlers.get(kind) === true;
    if (NO_RUNTIME[kind]) {
      if (consumer) fail(`${kind}: a kind without a runtime cannot declare a consumer`);
      kinds.push({
        id: kind,
        status: 'unimplemented',
        handler,
        notes: NO_RUNTIME[kind],
      });
      continue;
    }
    const source = await readText(consumer.file);
    if (!source.includes(consumer.symbol)) {
      fail(
        `${kind}: consumer ${consumer.file} no longer contains \`${consumer.symbol}\``
      );
    }
    const used = usage.get(kind) ?? 0;
    kinds.push({
      id: kind,
      status: used > 0 ? 'ready' : 'preview',
      handler,
      consumer: consumer.file,
      ...(used > 0 ? {} : { notes: PREVIEW_REASON }),
    });
  }

  return {
    $generatedBy: 'scripts/generate-contribution-kinds.mjs',
    $comment:
      'Do not edit by hand. Regenerate with node scripts/generate-contribution-kinds.mjs.',
    schemaVersion: 1,
    kinds,
  };
}

async function main() {
  const check = process.argv.includes('--check');
  const catalog = await buildCatalog();
  const next = `${JSON.stringify(catalog, null, 2)}\n`;
  const outputPath = join(ROOT, CATALOG);

  const counts = catalog.kinds.reduce((accumulator, kind) => {
    accumulator[kind.status] = (accumulator[kind.status] ?? 0) + 1;
    return accumulator;
  }, {});

  if (check) {
    const current = await readText(CATALOG);
    if (current !== next) {
      fail(`${CATALOG} is stale; run node scripts/generate-contribution-kinds.mjs`);
    }
    console.log(`${CATALOG} is up to date (${catalog.kinds.length} kinds)`);
    return;
  }

  await writeFile(outputPath, next, 'utf8');
  console.log(
    `${CATALOG}: ${catalog.kinds.length} kinds ` +
      `(${Object.entries(counts)
        .map(([status, count]) => `${status}=${count}`)
        .join(', ')})`
  );
}

main().catch((error) => {
  console.error(`generate-contribution-kinds: ${error.message}`);
  process.exitCode = 1;
});
