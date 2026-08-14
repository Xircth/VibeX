import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { build } from "esbuild";
import { buildPlugin, sdkAliases } from "./build.js";
export async function testPlugin(root) {
    const pluginRoot = resolve(root);
    await buildPlugin(pluginRoot);
    const testRoot = join(pluginRoot, "test");
    const entries = (await readdir(testRoot, { withFileTypes: true }))
        .filter((entry) => entry.isFile() &&
        /\.(?:test|spec)\.(?:mjs|js|mts|ts)$/u.test(entry.name))
        .map((entry) => join(testRoot, entry.name));
    if (!entries.length) {
        throw new Error("plugin_test_harness_missing: test/*.test.mjs is required");
    }
    const outputRoot = await mkdtemp(join(tmpdir(), "vibex-plugin-test-"));
    try {
        const outputs = [];
        for (const entry of entries) {
            const output = join(outputRoot, `${basename(entry).replace(/\W+/gu, "-")}.mjs`);
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
    }
    finally {
        await rm(outputRoot, { recursive: true, force: true });
    }
}
async function runNodeTests(outputs) {
    await new Promise((resolvePromise, reject) => {
        const child = spawn(process.execPath, ["--test", ...outputs], {
            stdio: "inherit",
        });
        child.on("error", reject);
        child.on("exit", (code) => code === 0
            ? resolvePromise()
            : reject(new Error(`plugin_tests_failed: node exited with ${code}`)));
    });
}
