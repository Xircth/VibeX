// I1 — contract registration (ADR-0033 / ADR-0069 / ADR-0078).
//
// The catalog is the single registry of "capability -> port -> implementation".
// This rule checks that the registry and the two executable seams agree:
//
//   - every host-api.v1.json op has one kind="op" entry in host-bindings;
//   - every HostCapabilityBroker::supports capability has one kind="capability"
//     entry, and every capability entry is actually accepted by supports().
//
// status="undeclared" entries are "implemented or reachable but not registered
// in host-api.v1.json"; they are reported separately as warnings, never mixed
// into the missing-binding failures.

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  CAPABILITY_BROKER,
  HOST_API,
  HOST_BINDINGS,
  RULE_I1,
  lineOfIndex,
  lineOfNeedle,
  readJson,
  readText,
} from "./check-arch-shared.mjs";

export const RULE = RULE_I1;

export function extractSupportsCapabilities(source) {
  const functionIndex = source.indexOf(
    "fn supports(&self, capability: &str) -> bool"
  );
  if (functionIndex === -1) {
    throw new Error("在 host_capability_broker.rs 中找不到 supports()");
  }
  const matchIndex = source.indexOf("matches!(", functionIndex);
  if (matchIndex === -1) {
    throw new Error("supports() 不是 matches! 结构，I1 无法解析 capability 名单");
  }
  let depth = 0;
  let end = -1;
  for (let index = matchIndex; index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    else if (source[index] === ")") {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  if (end === -1) {
    throw new Error("supports() 的 matches! 括号不平衡，I1 无法解析");
  }
  const body = source.slice(matchIndex, end);
  const seen = new Set();
  const capabilities = [];
  for (const match of body.matchAll(/"([^"]+)"/g)) {
    const name = match[1];
    if (seen.has(name)) continue;
    seen.add(name);
    capabilities.push({
      name,
      line: lineOfIndex(source, matchIndex + (match.index ?? 0)),
    });
  }
  return capabilities;
}

export function checkContract({
  rootDir,
  bindingsPath = HOST_BINDINGS,
  apiPath = HOST_API,
  brokerPath = CAPABILITY_BROKER,
} = {}) {
  if (!existsSync(join(rootDir, bindingsPath))) {
    throw new Error(
      `缺少契约绑定文件 ${bindingsPath}（J1 产物；合入后 I1 才生效，本地自测请临时复制，不要把它带进交付）`
    );
  }

  const api = readJson(rootDir, apiPath);
  const apiSource = readText(rootDir, apiPath);
  const bindings = readJson(rootDir, bindingsPath);
  const bindingsSource = readText(rootDir, bindingsPath);
  const brokerSource = readText(rootDir, brokerPath);

  const apiOps = (api.operations ?? []).map((operation) => operation.id);
  const entries = bindings.entries ?? [];
  const violations = [];
  const warnings = [];

  const entryLine = (entry) =>
    lineOfNeedle(bindingsSource, `"name": "${entry.name}"`);

  const seenKeys = new Set();
  const opEntries = new Map();
  for (const entry of entries) {
    const key = `${entry.kind}:${entry.name}`;
    if (seenKeys.has(key)) {
      violations.push({
        rule: RULE,
        file: bindingsPath,
        line: entryLine(entry),
        message: `绑定条目重复：${key}`,
      });
    }
    seenKeys.add(key);
    if (entry.kind === "op") opEntries.set(entry.name, entry);
    if (entry.kind !== "op" && entry.kind !== "capability") {
      violations.push({
        rule: RULE,
        file: bindingsPath,
        line: entryLine(entry),
        message: `未知 kind '${entry.kind}'（只允许 op / capability）`,
      });
    }
  }

  for (const op of apiOps) {
    if (!opEntries.has(op)) {
      violations.push({
        rule: RULE,
        file: apiPath,
        line: lineOfNeedle(apiSource, `"id": "${op}"`),
        message: `host-api op '${op}' 在 host-bindings 中没有 kind=op 的绑定条目`,
      });
    }
  }

  const supports = extractSupportsCapabilities(brokerSource);
  const supportedNames = new Set(supports.map((capability) => capability.name));
  const capabilityEntries = entries.filter(
    (entry) => entry.kind === "capability"
  );
  const registeredNames = new Set(
    capabilityEntries.map((entry) => entry.name)
  );

  for (const entry of capabilityEntries) {
    if (!supportedNames.has(entry.name)) {
      violations.push({
        rule: RULE,
        file: bindingsPath,
        line: entryLine(entry),
        message: `capability 条目 '${entry.name}' 不在 HostCapabilityBroker::supports() 名单中`,
      });
    }
  }
  for (const capability of supports) {
    if (!registeredNames.has(capability.name)) {
      violations.push({
        rule: RULE,
        file: brokerPath,
        line: capability.line,
        message: `supports() 接受 capability '${capability.name}'，但 host-bindings 没有 kind=capability 条目`,
      });
    }
  }

  for (const entry of entries) {
    if (entry.status === "undeclared") {
      warnings.push({
        rule: RULE,
        file: bindingsPath,
        line: entryLine(entry),
        message: `[undeclared] ${entry.kind} '${entry.name}' 已实现或可达但未登记到 host-api（${entry.notes ?? "无说明"}）`,
      });
    } else if (entry.kind === "op" && !apiOps.includes(entry.name)) {
      warnings.push({
        rule: RULE,
        file: bindingsPath,
        line: entryLine(entry),
        message: `op 条目 '${entry.name}' 不在 host-api.v1.json 中；若确实可达，status 应为 undeclared`,
      });
    }
  }

  return {
    violations,
    warnings,
    metrics: {
      apiOps: apiOps.length,
      opEntries: opEntries.size,
      capabilityEntries: capabilityEntries.length,
      supports: supports.length,
      undeclared: entries.filter((entry) => entry.status === "undeclared")
        .length,
    },
  };
}
