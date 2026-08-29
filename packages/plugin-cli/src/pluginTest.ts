import { spawn } from "node:child_process";
import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { build } from "esbuild";

import { buildPlugin, sdkAliases } from "./build.js";
import { inspectLinkedPackage } from "./pluginControl.js";
import {
  doctorOnProductHost,
  enableOnProductHost,
  importLinkedOnProductHost,
  uninstallOnProductHost,
} from "./productHost.js";

export async function testPlugin(
  root: string,
  options: { host?: boolean } = {},
) {
  const pluginRoot = resolve(root);
  if (options.host) {
    await testPluginOnHost(pluginRoot);
    return;
  }
  await buildPlugin(pluginRoot);
  const testRoot = join(pluginRoot, "test");
  const entries = (await readdir(testRoot, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isFile() &&
        /\.(?:test|spec)\.(?:mjs|js|mts|ts)$/u.test(entry.name),
    )
    .map((entry) => join(testRoot, entry.name));
  if (!entries.length) {
    throw new Error("plugin_test_harness_missing: test/*.test.mjs is required");
  }

  const outputRoot = await mkdtemp(join(tmpdir(), "vibex-plugin-test-"));
  try {
    const outputs: string[] = [];
    for (const entry of entries) {
      const output = join(
        outputRoot,
        `${basename(entry).replace(/\W+/gu, "-")}.mjs`,
      );
      await build({
        entryPoints: [entry],
        outfile: output,
        bundle: true,
        format: "esm",
        platform: "node",
        target: "node20",
        alias: sdkAliases(),
        sourcemap: false,
        legalComments: "none",
        logLevel: "silent",
      });
      outputs.push(output);
    }
    await runNodeTests(outputs);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
}

async function testPluginOnHost(root: string) {
  await buildPlugin(root);
  const plugin = await inspectLinkedPackage(root);
  const installed = await importLinkedOnProductHost(plugin.root, plugin.identity);
  if (installed.queued) {
    throw new Error("No running VibeX Host. Start Desktop or `vibex serve`.");
  }
  await enableOnProductHost(plugin.identity.id);
  const skill = await firstSkillFile(root);
  if (skill) {
    const original = await readFile(skill, "utf8");
    await writeFile(skill, `${original}\n<!-- host-test ${Date.now()} -->\n`);
    const deadline = Date.now() + 10_000;
    let updated = false;
    while (Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 400));
      const report = await doctorOnProductHost(plugin.identity.id);
      const digest =
        report.installation &&
        typeof report.installation === "object" &&
        "packageDigest" in report.installation
          ? String(
              (report.installation as { packageDigest?: string }).packageDigest ??
                "",
            )
          : "";
      if (digest && digest !== installed.packageDigest) {
        updated = true;
        break;
      }
    }
    await writeFile(skill, original);
    if (!updated) {
      throw new Error("plugin_host_skill_reload_failed");
    }
  }
  await uninstallOnProductHost(plugin.identity.id, true);
  await access(root);
}

async function firstSkillFile(root: string): Promise<string | null> {
  async function visit(directory: string): Promise<string | null> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        const nested = await visit(absolute);
        if (nested) return nested;
      } else if (entry.name === "SKILL.md") {
        return absolute;
      }
    }
    return null;
  }
  return visit(root);
}

async function runNodeTests(outputs: readonly string[]) {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--test", ...outputs], {
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolvePromise()
        : reject(new Error(`plugin_tests_failed: node exited with ${code}`)),
    );
  });
}
