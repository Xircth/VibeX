import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import {
  PluginDevHostClient,
  resolvePluginDevConnection,
} from "./hostClient.js";
import {
  doctorPlugin,
  installLinkedPlugin,
  uninstallLinkedPlugin,
} from "./pluginControl.js";

import { build } from "esbuild";

import { buildPlugin, sdkAliases } from "./build.js";

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
  const client = new PluginDevHostClient(
    resolvePluginDevConnection(process.argv.slice(2)),
  );
  await buildPlugin(root);
  const installed = await installLinkedPlugin(root, client);
  const skill = await firstSkillFile(root);
  if (skill) {
    const original = await readFile(skill, "utf8");
    await writeFile(skill, `${original}\n<!-- host-test ${Date.now()} -->\n`);
    const deadline = Date.now() + 10_000;
    let updated = false;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      const report = await doctorPlugin(root, client);
      const digest =
        report.installation &&
        typeof report.installation === "object" &&
        report.installation !== null &&
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
  await uninstallLinkedPlugin(root, client, true);
  const { access } = await import("node:fs/promises");
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
