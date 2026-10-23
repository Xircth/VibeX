#!/usr/bin/env node
/**
 * Generates `.agents/skills/vibex-plugin-creator/references/sdk-api.md`
 * directly from the exported TypeScript declarations in `packages/plugin-sdk/src/`.
 *
 * Usage:
 *   node scripts/gen-plugin-sdk-doc.mjs          # write sdk-api.md
 *   node scripts/gen-plugin-sdk-doc.mjs --check  # verify sdk-api.md is up to date
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const sdkSrcDir = path.join(repoRoot, 'packages', 'plugin-sdk', 'src');
const outFile = path.join(
  repoRoot,
  '.agents',
  'skills',
  'vibex-plugin-creator',
  'references',
  'sdk-api.md'
);

const MODULE_ORDER = [
  {
    file: 'context.ts',
    title: 'Plugin Context & Lifecycle (`context.ts`)',
    summary:
      'Primary v2.0 plugin authoring entrypoint (`defineVibeXPlugin`, `VibeXPluginContext`, `ctx.ui`, `ctx.hooks`, `ctx.services`, `ctx.host`, `ctx.worker`, `ctx.self`).',
  },
  {
    file: 'registry.ts',
    title: 'UI Slots, Prompt Context & Internal Message Capture (`registry.ts`)',
    summary:
      'Typed registries for UI slots, commands, views, panels, kanban views, settings pages, slash commands, markdown renderers, `beforeTurn` prompt contributions, and `InternalMessageCapture`.',
  },
  {
    file: 'services.ts',
    title: 'Cordis-Style IoC Service Container & EffectScope (`services.ts`)',
    summary:
      'Dependency injection (`provide`, `inject`, `require`, `onChange`), reversible `EffectScope` disposers, and waterfall hook interceptors (`intercept`, `runWaterfall`).',
  },
  {
    file: 'hooks.ts',
    title: 'React Subscription Hooks (`hooks.ts`)',
    summary:
      'Zero-flicker `useSyncExternalStore` hooks for consuming plugin registries and IoC services inside React components.',
  },
  {
    file: 'testing.ts',
    title: 'Plugin Test Harness (`testing.ts`)',
    summary:
      'In-memory test harness (`createPluginTestHarness`) for testing plugin activation, UI registrations, hooks, Host RPC mocks, and zero-residue disposal.',
  },
  {
    file: 'worker.ts',
    title: 'Backend Node Worker Runtime (`worker.ts`)',
    summary:
      'Tier-2 / Tier-3 Node Worker definition (`definePluginWorker`, `PluginWorkerContext`, Host capability calls).',
  },
  {
    file: 'app.ts',
    title: 'App Surface Bridge (`app.ts`)',
    summary:
      'App surface mount API (`definePluginApp`, `VibeXAppBridge`, 1-hop `bridge.hostCall`).',
  },
  {
    file: 'manifest.ts',
    title: 'Plugin Manifest Schema (`manifest.ts`)',
    summary:
      'Manifest types and helpers for `.vibex-plugin/plugin.json` (`apiVersion: "2.0"` and `"1.0"`).',
  },
  {
    file: 'protocol.ts',
    title: 'Wire Protocol & Error Codes (`protocol.ts`)',
    summary:
      'JSON-RPC wire protocol frames, capability names, and structured `PluginSdkError` definitions.',
  },
];

/**
 * Extracts exported declarations (interfaces, types, classes, consts, functions)
 * along with any immediately preceding JSDoc block from a TypeScript source file.
 */
function extractExportedDeclarations(sourceText) {
  const lines = sourceText.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    // Capture optional leading JSDoc comment
    let jsdoc = [];
    if (lines[i].trim().startsWith('/**')) {
      const startDoc = i;
      while (i < lines.length && !lines[i].includes('*/')) {
        i += 1;
      }
      if (i < lines.length) {
        jsdoc = lines.slice(startDoc, i + 1);
        i += 1;
      }
      while (i < lines.length && lines[i].trim() === '') {
        i += 1;
      }
    }

    if (i >= lines.length) break;
    const line = lines[i];

    if (
      /^export\s+(interface|type|const|function|async\s+function|class)\b/.test(
        line
      )
    ) {
      const declLines = [...jsdoc];
      if (
        /^export\s+(async\s+)?function\b/.test(line) ||
        /^export\s+class\b/.test(line)
      ) {
        // For functions and classes: capture signature (or class public surface) cleanly
        if (/^export\s+(async\s+)?function\b/.test(line)) {
          let sig = [];
          let parenDepth = 0;
          let foundOpenParen = false;
          while (i < lines.length) {
            const cur = lines[i];
            for (const ch of cur) {
              if (ch === '(') {
                parenDepth += 1;
                foundOpenParen = true;
              } else if (ch === ')') {
                parenDepth -= 1;
              }
            }
            if (foundOpenParen && parenDepth <= 0 && cur.includes('{')) {
              sig.push(cur.replace(/\s*\{[\s\S]*$/, ';'));
              // Skip body
              let braceDepth = 0;
              for (const ch of cur) {
                if (ch === '{') braceDepth += 1;
                if (ch === '}') braceDepth -= 1;
              }
              i += 1;
              while (i < lines.length && braceDepth > 0) {
                for (const ch of lines[i]) {
                  if (ch === '{') braceDepth += 1;
                  if (ch === '}') braceDepth -= 1;
                }
                i += 1;
              }
              break;
            } else if (foundOpenParen && parenDepth <= 0 && cur.trim().endsWith(';')) {
              sig.push(cur);
              i += 1;
              break;
            } else {
              sig.push(cur);
              i += 1;
            }
          }
          declLines.push(...sig);
          blocks.push(declLines.join('\n'));
          continue;
        }
      }

      // Interface, type, const, or class
      if (line.includes('{')) {
        let braceDepth = 0;
        while (i < lines.length) {
          const cur = lines[i];
          for (const ch of cur) {
            if (ch === '{') braceDepth += 1;
            if (ch === '}') braceDepth -= 1;
          }
          declLines.push(cur);
          i += 1;
          if (braceDepth <= 0) break;
        }
        blocks.push(declLines.join('\n'));
        continue;
      } else {
        while (i < lines.length) {
          const cur = lines[i];
          declLines.push(cur);
          i += 1;
          if (cur.trim().endsWith(';')) break;
        }
        blocks.push(declLines.join('\n'));
        continue;
      }
    }

    i += 1;
  }

  return blocks;
}

function generateMarkdown() {
  const sections = [];
  sections.push(`# \`@vibex/plugin-sdk\` API Reference (Auto-Generated)

> **DO NOT EDIT THIS FILE BY HAND.**
> Generated by \`node scripts/gen-plugin-sdk-doc.mjs\` from \`packages/plugin-sdk/src/*.ts\`.

## Quick Overview: 4-Tier Progressive Plugin Model

| Tier | Capabilities | Required Files | Runtime Cost |
| :--- | :--- | :--- | :--- |
| **Tier 0: Declarative** | Themes, CSS variables, JSON Schema settings, static slash commands, prompt templates, MCP configs | \`.vibex-plugin/plugin.json\` (+ optional \`style.css\`, \`skills/*/SKILL.md\`) | **Zero JS / Zero Process** |
| **Tier 1: UI & Hook Plugin** | Custom UI slots, panels, tabs, kanban views, markdown codeblock renderers, \`beforeTurn\` / \`afterTurn\` hooks, \`captureInternalMessage\`, IoC services, 1-hop \`ctx.host.*\` RPC | \`.vibex-plugin/plugin.json\` + \`index.js\` (or \`index.ts\`) | **Zero Child Process** (runs in WebView with \`PluginErrorBoundary\` + \`EffectScope\`) |
| **Tier 2: Shared Node Worker** | Pure Node.js background handlers (\`fs\`, \`crypto\`, data pipelines) | \`.vibex-plugin/plugin.json\` + \`worker/index.mjs\` (\`"sharedWorker": true\`) | **Shared Single Node Host Process** (\`vm.SourceTextModule\` + \`AbortController\` + \`AsyncLocalStorage\`) |
| **Tier 3: Isolated Process / Sidecar** | Native addons, custom Python/binary runtimes, long-lived CLI/daemon child processes (\`ctx.host.exec.spawn\`) | \`.vibex-plugin/plugin.json\` + \`worker/index.mjs\` (\`"isolation": "process"\`) | **Dedicated OS Process** with automatic lifecycle cleanup |

---
`);

  for (const mod of MODULE_ORDER) {
    const filePath = path.join(sdkSrcDir, mod.file);
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, 'utf8');
    const declarations = extractExportedDeclarations(content);
    if (declarations.length === 0) continue;

    sections.push(`## ${mod.title}\n`);
    sections.push(`${mod.summary}\n`);
    sections.push('```ts');
    sections.push(declarations.join('\n\n'));
    sections.push('```\n');
  }

  return sections.join('\n');
}

const generated = generateMarkdown();
const isCheck = process.argv.includes('--check');

if (isCheck) {
  if (!fs.existsSync(outFile)) {
    console.error(`Missing generated file: ${outFile}`);
    process.exit(1);
  }
  const existing = fs.readFileSync(outFile, 'utf8').replace(/\r\n/g, '\n');
  if (existing !== generated) {
    console.error(
      `Out-of-date SDK docs in ${outFile}. Run 'node scripts/gen-plugin-sdk-doc.mjs' to update.`
    );
    process.exit(1);
  }
  console.log(`SDK API reference is up to date: ${outFile}`);
  process.exit(0);
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, generated, 'utf8');
console.log(`Generated ${outFile} (${generated.length} bytes)`);
