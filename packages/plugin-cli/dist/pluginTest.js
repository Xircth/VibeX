import { spawn } from "node:child_process";
import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { build } from "esbuild";
import { buildPlugin, sdkAliases } from "./build.js";
import { inspectLinkedPackage } from "./pluginControl.js";
import { catalogHasKinds, catalogLacksKinds, hostJourneyKindsFromIntegrations, } from "./pluginHostJourney.js";
import { callProductHost, contributionCatalogOnProductHost, disableOnProductHost, doctorOnProductHost, enableOnProductHost, importLinkedOnProductHost, uninstallOnProductHost, } from "./productHost.js";
export async function testPlugin(root, options = {}) {
    const pluginRoot = resolve(root);
    if (options.host) {
        await testPluginOnHost(pluginRoot);
        return;
    }
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
async function testPluginOnHost(root) {
    await buildPlugin(root);
    const plugin = await inspectLinkedPackage(root);
    const installed = await importLinkedOnProductHost(plugin.root, plugin.identity);
    if (installed.queued) {
        throw new Error("No Host is bound. Run `vibex plugin run server --http://127.0.0.1:17891 --token <token>`.");
    }
    await enableOnProductHost(plugin.identity.id);
    const integrations = await readManifestIntegrations(root);
    const hostKinds = hostJourneyKindsFromIntegrations(integrations);
    const catalogAgentId = catalogAgentIdFromIntegrations(integrations);
    if (hostKinds.length > 0) {
        await waitForCatalog(plugin.identity.id, hostKinds, true, "plugin_host_contributions_missing");
        if (catalogAgentId) {
            await waitForProviderCatalogList(catalogAgentId, true);
        }
        await disableOnProductHost(plugin.identity.id);
        await waitForCatalog(plugin.identity.id, hostKinds, false, "plugin_host_contributions_lingered");
        if (catalogAgentId) {
            await waitForProviderCatalogList(catalogAgentId, false);
        }
        await enableOnProductHost(plugin.identity.id);
        await waitForCatalog(plugin.identity.id, hostKinds, true, "plugin_host_contributions_missing");
        if (catalogAgentId) {
            await waitForProviderCatalogList(catalogAgentId, true);
        }
    }
    const skill = await firstSkillFile(root);
    if (skill) {
        const original = await readFile(skill, "utf8");
        await writeFile(skill, `${original}\n<!-- host-test ${Date.now()} -->\n`);
        const deadline = Date.now() + 10_000;
        let updated = false;
        while (Date.now() < deadline) {
            await new Promise((resolveWait) => setTimeout(resolveWait, 400));
            const report = await doctorOnProductHost(plugin.identity.id);
            const digest = report.installation &&
                typeof report.installation === "object" &&
                "packageDigest" in report.installation
                ? String(report.installation.packageDigest ??
                    "")
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
async function readManifestIntegrations(root) {
    const raw = await readFile(join(root, ".vibex-plugin", "plugin.json"), "utf8");
    const manifest = JSON.parse(raw);
    return manifest.integrations;
}
function catalogAgentIdFromIntegrations(integrations) {
    if (!Array.isArray(integrations))
        return null;
    for (const item of integrations) {
        if (!item || typeof item !== "object")
            continue;
        const record = item;
        if (record.kind !== "provider.model.catalog")
            continue;
        if (Array.isArray(record.agents)) {
            const agentId = record.agents.find((value) => typeof value === "string" && value.length > 0);
            if (agentId)
                return agentId;
        }
        return "claude_code";
    }
    return null;
}
async function waitForProviderCatalogList(agentId, present) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        const listed = await callProductHost("provider_catalog_list", { agentId });
        const count = Array.isArray(listed.templates) ? listed.templates.length : 0;
        if (present ? count > 0 : count === 0)
            return;
        await new Promise((resolveWait) => setTimeout(resolveWait, 400));
    }
    throw new Error(present
        ? "plugin_host_provider_catalog_empty"
        : "plugin_host_provider_catalog_lingered");
}
async function waitForCatalog(pluginId, kinds, present, error) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        const catalog = await contributionCatalogOnProductHost();
        const items = catalog.items ?? [];
        const ready = present
            ? catalogHasKinds(items, pluginId, kinds)
            : catalogLacksKinds(items, pluginId, kinds);
        if (ready)
            return;
        await new Promise((resolveWait) => setTimeout(resolveWait, 400));
    }
    throw new Error(error);
}
async function firstSkillFile(root) {
    async function visit(directory) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            if (entry.name === "node_modules" || entry.name === ".git")
                continue;
            const absolute = join(directory, entry.name);
            if (entry.isDirectory()) {
                const nested = await visit(absolute);
                if (nested)
                    return nested;
            }
            else if (entry.name === "SKILL.md") {
                return absolute;
            }
        }
        return null;
    }
    return visit(root);
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
