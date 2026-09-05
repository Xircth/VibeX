#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { packPlugin } from "./package.js";
import { buildPlugin } from "./build.js";
import {
  bindHostServer,
  parseRunInvocation,
  runPluginBuild,
  runPluginDev,
  runPluginTest,
} from "./pluginRun.js";
import {
  doctorOnProductHost,
  importLinkedOnProductHost,
  uninstallOnProductHost,
} from "./productHost.js";
import { inspectLinkedPackage } from "./pluginControl.js";
import { scaffoldPlugin } from "./scaffold.js";
import { testPlugin } from "./pluginTest.js";
import { validatePlugin } from "./validation.js";

const helpText = `VibeX Plugin CLI 1.0

Commands:
  run server [--http://127.0.0.1:17891] [--token <token>]
  run dev [dir]
  run build [dir]
  run test [dir] [--host]
  init [dir] [--publisher id] [--template skill|mcp|file-tab|editor-tab|full|ts-worker|node-worker|python-worker|rust-worker|host-service|hooks|host-chrome|provider-import|panel|kanban-view]
  validate [dir] [--json]
  build [dir]
  test [dir] [--host]
  dev [dir]
  install --link [dir]
  uninstall [dir] [--delete-data]
  pack [dir] [--output file.vxp]
  doctor [dir]
  toolchain

Prefer \`vibex plugin run server\` then \`vibex plugin run dev\` from a plugin directory.
\`dev\` is an alias of \`run dev\`. \`add --dev\` only links; it does not start HMR.
test --host installs, enables Host contributions, asserts they appear then vanish on disable, reloads a Skill when one exists, and uninstalls.`;
const [command = "help", ...args] = process.argv.slice(2);

try {
  switch (command) {
    case "init": {
      const root = await scaffoldPlugin(
        positional(args) ?? "vibex-plugin",
        flag(args, "--publisher") ?? "local",
        flag(args, "--template") ?? "full",
      );
      await buildPlugin(root);
      console.log(`Created ${root}`);
      break;
    }
    case "validate": {
      const result = await validatePlugin(resolve(positional(args) ?? "."));
      printValidation(result, args.includes("--json"));
      if (!result.valid) process.exitCode = 1;
      break;
    }
    case "build": {
      const root = resolve(positional(args) ?? ".");
      await buildPlugin(root);
      console.log(`Built ${root}`);
      break;
    }
    case "run": {
      const invocation = parseRunInvocation(args);
      if (invocation.script === "server") {
        const session = await bindHostServer({ flags: invocation.host });
        console.log(`Host ${session.url} ready`);
        break;
      }
      if (invocation.script === "dev") {
        await runPluginDev(resolve(invocation.positional[0] ?? "."));
        break;
      }
      if (invocation.script === "build") {
        const root = await runPluginBuild(invocation.positional[0] ?? ".");
        console.log(`Built ${root}`);
        break;
      }
      await runPluginTest(invocation.positional[0] ?? ".", {
        host: invocation.hostJourney,
      });
      break;
    }
    case "test":
      await testPlugin(resolve(positional(args) ?? "."), {
        host: args.includes("--host"),
      });
      break;
    case "pack": {
      const root = resolve(positional(args) ?? ".");
      await ensureValid(root);
      const result = await packPlugin(root, flag(args, "--output"));
      console.log(`${result.output}\nsha256:${result.lock.packageDigest}`);
      break;
    }
    case "install": {
      if (!args.includes("--link")) throw new Error("install_requires_--link");
      const root = resolve(positional(args) ?? ".");
      await buildPlugin(root);
      const plugin = await inspectLinkedPackage(root);
      const result = await importLinkedOnProductHost(plugin.root, plugin.identity);
      console.log(
        `Installed ${result.plugin.publisher}/${result.plugin.id} generation ${result.generation} (${result.packageDigest})`,
      );
      break;
    }
    case "uninstall": {
      const root = resolve(positional(args) ?? ".");
      const plugin = await inspectLinkedPackage(root);
      const result = await uninstallOnProductHost(
        plugin.identity.id,
        !args.includes("--delete-data"),
      );
      console.log(
        `Uninstalled ${plugin.identity.publisher}/${plugin.identity.id}; data ${result.dataRetention ?? "retained"}`,
      );
      break;
    }
    case "dev":
      await runPluginDev(resolve(positional(args) ?? "."));
      break;
    case "toolchain": {
      const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
      console.log(
        JSON.stringify(
          {
            hostVersion: "0.1.3",
            cli: resolve(here, "cli.js"),
            contract: resolve(here, "../../plugin-contract"),
            js: resolve(here, "../../plugin-sdk"),
            python: resolve(here, "../../../sdk/python"),
            rust: resolve(here, "../../../crates/plugin-sdk"),
            templates: [
              "skill",
              "mcp",
              "file-tab",
              "editor-tab",
              "full",
              "ts-worker",
              "node-worker",
              "python-worker",
              "rust-worker",
              "host-service",
              "hooks",
              "host-chrome",
              "provider-import",
              "panel",
              "kanban-view",
            ],
          },
          null,
          2,
        ),
      );
      break;
    }
    case "doctor": {
      const root = resolve(positional(args) ?? ".");
      const plugin = await inspectLinkedPackage(root);
      const report = await doctorOnProductHost(plugin.identity.id);
      console.log(JSON.stringify(report, null, 2));
      if (report.diagnostics.some((item) => item.severity === "error")) {
        process.exitCode = 1;
      }
      break;
    }
    case "help":
    case "--help":
    case "-h":
      console.log(helpText);
      break;
    default:
      throw new Error(`Unknown command ${command}\n${helpText}`);
  }
} catch (error) {
  console.error(formatError(error));
  process.exitCode = 1;
}

async function ensureValid(root: string) {
  const result = await validatePlugin(root);
  if (!result.valid) {
    printValidation(result, false);
    throw new Error("Plugin validation failed");
  }
}

function printValidation(
  result: Awaited<ReturnType<typeof validatePlugin>>,
  json: boolean,
) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  for (const item of result.diagnostics)
    console.log(`${item.severity.toUpperCase()} ${item.code}: ${item.message}`);
  console.log(result.valid ? "Plugin is valid." : "Plugin is invalid.");
}

function flag(args: readonly string[], name: string) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function positional(args: readonly string[]) {
  const valueOptions = new Set([
    "--host",
    "--http",
    "--token",
    "--publisher",
    "--template",
    "--output",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (valueOptions.has(argument)) {
      index += 1;
      continue;
    }
    if (
      argument.startsWith("--http://") ||
      argument.startsWith("--https://") ||
      argument.startsWith("--host=") ||
      argument.startsWith("--http=") ||
      argument.startsWith("--token=")
    ) {
      continue;
    }
    if (!argument.startsWith("--")) return argument;
  }
  return undefined;
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
