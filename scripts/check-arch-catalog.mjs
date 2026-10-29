// I3 — contribution directory alignment (ADR-0069).
//
// Every contribution kind an official plugin manifest declares must exist in
// contribution-kinds.v1.json and must not be marked unimplemented. A kind that
// is ready/preview but no official plugin consumes only warns, so the directory
// can list future kinds without failing the build.
//
// KNOWN_UNREGISTERED_KINDS is the ratchet for "consumed but not registered yet"
// gaps, loaded from check-arch-ratchet.json. Each entry needs a reason. J5 has
// already registered app.rail.section, so the list is empty; when a temporary
// gap is added and the directory later gains that kind, the stale-entry check
// turns red and forces removal. The ratchet only tightens.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  CONTRIBUTION_KINDS,
  OFFICIAL_PLUGIN_ROOTS,
  RULE_I3,
  lineOfNeedle,
  loadRatchet,
  readJson,
  readText,
} from "./check-arch-shared.mjs";

export const RULE = RULE_I3;

const RATCHET = loadRatchet();

export const KNOWN_UNREGISTERED_KINDS = new Map(
  (RATCHET.i3KnownUnregisteredKinds ?? []).map((entry) => [
    entry.kind,
    entry.reason,
  ])
);

const VALID_STATUS = new Set(["ready", "preview", "unimplemented"]);

export function collectOfficialPluginManifests(rootDir) {
  const manifests = [];
  for (const pluginRoot of OFFICIAL_PLUGIN_ROOTS) {
    const absoluteRoot = join(rootDir, pluginRoot);
    if (!existsSync(absoluteRoot)) continue;
    for (const entry of readdirSync(absoluteRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const relativeManifest = `${pluginRoot}/${entry.name}/.vibex-plugin/plugin.json`;
      if (!existsSync(join(rootDir, relativeManifest))) continue;
      manifests.push({ relativeManifest, fallbackId: entry.name });
    }
  }
  return manifests;
}

export function checkCatalog({
  rootDir,
  knownGaps = KNOWN_UNREGISTERED_KINDS,
} = {}) {
  const catalog = readJson(rootDir, CONTRIBUTION_KINDS);
  const catalogSource = readText(rootDir, CONTRIBUTION_KINDS);
  const kinds = catalog.kinds ?? [];
  const violations = [];
  const warnings = [];

  const catalogById = new Map();
  for (const kind of kinds) {
    if (catalogById.has(kind.id)) {
      violations.push({
        rule: RULE,
        file: CONTRIBUTION_KINDS,
        line: lineOfNeedle(catalogSource, `"id": "${kind.id}"`),
        message: `目录 kind 重复登记：${kind.id}`,
      });
    }
    catalogById.set(kind.id, kind);
    if (!VALID_STATUS.has(kind.status)) {
      violations.push({
        rule: RULE,
        file: CONTRIBUTION_KINDS,
        line: lineOfNeedle(catalogSource, `"id": "${kind.id}"`),
        message: `kind '${kind.id}' 状态 '${kind.status}' 非法（只允许 ready / preview / unimplemented）`,
      });
    }
  }

  // kind -> every official consumer location
  const usage = new Map();
  let pluginCount = 0;
  for (const { relativeManifest, fallbackId } of collectOfficialPluginManifests(
    rootDir
  )) {
    const source = readText(rootDir, relativeManifest);
    let manifest;
    try {
      manifest = JSON.parse(source);
    } catch (error) {
      violations.push({
        rule: RULE,
        file: relativeManifest,
        line: 0,
        message: `官方插件清单不是合法 JSON：${error.message}`,
      });
      continue;
    }
    pluginCount += 1;
    const pluginId = manifest.id ?? fallbackId;
    for (const integration of manifest.integrations ?? []) {
      const kind = integration.kind;
      if (typeof kind !== "string" || kind.length === 0) {
        violations.push({
          rule: RULE,
          file: relativeManifest,
          line: lineOfNeedle(source, `"id": "${integration.id}"`),
          message: `官方插件 ${pluginId} 的贡献缺少 kind：${integration.id ?? "unknown"}`,
        });
        continue;
      }
      const line = lineOfNeedle(source, `"kind": "${kind}"`);
      if (!usage.has(kind)) usage.set(kind, []);
      usage.get(kind).push({ plugin: pluginId, file: relativeManifest, line });
    }
  }

  for (const [kind, consumers] of usage) {
    const catalogEntry = catalogById.get(kind);
    if (!catalogEntry) {
      if (knownGaps.has(kind)) {
        warnings.push({
          rule: RULE,
          file: consumers[0].file,
          line: consumers[0].line,
          message: `[已知缺口] 官方插件消费 kind '${kind}' 但目录未登记：${knownGaps.get(kind)}`,
        });
      } else {
        for (const consumer of consumers) {
          violations.push({
            rule: RULE,
            file: consumer.file,
            line: consumer.line,
            message: `官方插件 ${consumer.plugin} 消费 kind '${kind}'，但 contribution-kinds.v1.json 未登记`,
          });
        }
      }
    } else if (catalogEntry.status === "unimplemented") {
      for (const consumer of consumers) {
        violations.push({
          rule: RULE,
          file: consumer.file,
          line: consumer.line,
          message: `官方插件 ${consumer.plugin} 消费 kind '${kind}'，但目录标记 unimplemented`,
        });
      }
    }
  }

  for (const [kind, reason] of knownGaps) {
    if (catalogById.has(kind)) {
      violations.push({
        rule: RULE,
        file: CONTRIBUTION_KINDS,
        line: lineOfNeedle(catalogSource, `"id": "${kind}"`),
        message: `已知缺口 '${kind}' 已登记进目录，删除白名单条目（ratchet 只收紧）：${reason}`,
      });
    }
  }

  let unusedReady = 0;
  for (const kind of kinds) {
    if (usage.has(kind.id) || kind.status === "unimplemented") continue;
    unusedReady += 1;
    warnings.push({
      rule: RULE,
      file: CONTRIBUTION_KINDS,
      line: lineOfNeedle(catalogSource, `"id": "${kind.id}"`),
      message: `kind '${kind.id}' 状态 ${kind.status} 但无官方插件使用（只警告）`,
    });
  }

  return {
    violations,
    warnings,
    metrics: {
      catalogKinds: kinds.length,
      officialPlugins: pluginCount,
      usedKinds: usage.size,
      unusedReady,
    },
  };
}
