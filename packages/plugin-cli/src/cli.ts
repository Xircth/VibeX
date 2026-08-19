#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildPlugin } from "./build.js";
import { watchPluginSources } from "./dev.js";
import {
  PluginDevHostClient,
  PluginDevHostError,
  resolvePluginDevConnection,
} from "./hostClient.js";
import { packPlugin } from "./package.js";
import {
  doctorPlugin,
  installLinkedPlugin,
  reloadLinkedPlugin,
  uninstallLinkedPlugin,
} from "./pluginControl.js";
import { scaffoldPlugin } from "./scaffold.js";
import { testPlugin } from "./pluginTest.js";
import { validatePlugin } from "./validation.js";

const helpText = `VibeX Plugin CLI 1.0\n\nCommands:\n  init [dir] [--publisher id] [--template skill|mcp|file-tab|full|ts-worker|node-worker|python-worker|rust-worker|host-service|hooks]\n  validate [dir] [--json]\n  build [dir]\n  test [dir]\n  dev [dir] [--host url]\n  install --link [dir] [--host url]\n  uninstall [dir] [--delete-data] [--host url]\n  pack [dir] [--output file.vxp]\n  doctor [dir] [--host url]\n  toolchain\n\nHost-local only. Connection uses VIBEX_PLUGIN_DEV_HOST.`;
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
    case "test":
      await testPlugin(resolve(positional(args) ?? "."));
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
      const result = await installLinkedPlugin(root, hostClient(args));
      console.log(
        `Installed ${result.plugin.publisher}/${result.plugin.id} generation ${result.generation} (${result.packageDigest})`,
      );
      break;
    }
    case "uninstall": {
      const root = resolve(positional(args) ?? ".");
      const result = await uninstallLinkedPlugin(
        root,
        hostClient(args),
        !args.includes("--delete-data"),
      );
      console.log(
        `Uninstalled ${result.plugin.publisher}/${result.plugin.id}; data ${result.dataRetention}`,
      );
      break;
    }
    case "dev": {
      const root = resolve(positional(args) ?? ".");
      const client = hostClient(args);
      await buildPlugin(root);
      const installed = await installLinkedPlugin(root, client);
      console.log(
        `Published generation ${installed.generation}; watching ${root}`,
      );
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      try {
        await watchPluginSources(root, {
          signal: controller.signal,
          async reload() {
            await buildPlugin(root);
            if (controller.signal.aborted) return;
            const candidate = await reloadLinkedPlugin(root, client);
            console.log(`Published generation ${candidate.generation}`);
          },
          onError(error) {
            console.error(formatError(error));
          },
        });
      } finally {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
      }
      break;
    }
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
              "full",
              "ts-worker",
              "node-worker",
              "python-worker",
              "rust-worker",
              "host-service",
              "hooks",
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
      const report = await doctorPlugin(root, hostClient(args));
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
    if (!argument.startsWith("--")) return argument;
  }
  return undefined;
}

function hostClient(args: readonly string[]) {
  return new PluginDevHostClient(resolvePluginDevConnection(args));
}

function formatError(error: unknown) {
  if (error instanceof PluginDevHostError) {
    const generation =
      error.publishedGeneration === undefined
        ? ""
        : `; published generation ${error.publishedGeneration} remains active`;
    const diagnostic = error.diagnosticId
      ? `; diagnostic ${error.diagnosticId}`
      : "";
    return `${error.code}: ${error.message}${generation}${diagnostic}`;
  }
  return error instanceof Error ? error.message : String(error);
}
