import { readFile, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createPackageLock } from "./package.js";
import { validatePlugin } from "./validation.js";
export async function inspectLinkedPackage(root) {
    const { root: sourceRoot } = await readPluginReference(root);
    const validation = await validatePlugin(sourceRoot);
    if (!validation.valid || !validation.manifest) {
        const codes = validation.diagnostics.map((item) => item.code).join(", ");
        throw new Error(`plugin_validation_failed${codes ? `: ${codes}` : ""}`);
    }
    const manifest = JSON.parse(await readFile(join(sourceRoot, ".vibex-plugin", "plugin.json"), "utf8"));
    const lock = await createPackageLock(sourceRoot);
    return {
        root: sourceRoot,
        manifest,
        identity: { publisher: manifest.publisher, id: manifest.id },
        packageDigest: lock.packageDigest,
    };
}
export async function installLinkedPlugin(root, client) {
    const plugin = await inspectLinkedPackage(root);
    const result = await client.installLinked({
        sourcePath: plugin.root,
        expected: {
            publisher: plugin.manifest.publisher,
            pluginId: plugin.manifest.id,
            version: plugin.manifest.version,
            packageDigest: plugin.packageDigest,
        },
    });
    assertActivatedPackage(plugin, result);
    return result;
}
export async function reloadLinkedPlugin(root, client) {
    const plugin = await inspectLinkedPackage(root);
    const result = await client.reloadCandidate(plugin.identity, {
        sourcePath: plugin.root,
        expectedPackageDigest: plugin.packageDigest,
    });
    assertActivatedPackage(plugin, result);
    return result;
}
export async function doctorPlugin(root, client) {
    const plugin = await readPluginReference(root);
    const report = await client.doctor(plugin.identity);
    if (report.plugin.publisher !== plugin.identity.publisher ||
        report.plugin.id !== plugin.identity.id) {
        throw new Error("plugin_dev_host_response_mismatch");
    }
    return report;
}
export async function uninstallLinkedPlugin(root, client, retainData = true) {
    const plugin = await readPluginReference(root);
    const result = await client.uninstallLinked(plugin.identity, retainData);
    if (result.plugin.publisher !== plugin.identity.publisher ||
        result.plugin.id !== plugin.identity.id) {
        throw new Error("plugin_dev_host_response_mismatch");
    }
    return result;
}
async function readPluginReference(root) {
    const sourceRoot = await realpath(resolve(root));
    if (!(await stat(sourceRoot)).isDirectory()) {
        throw new Error("plugin_link_source_not_directory");
    }
    const manifest = JSON.parse(await readFile(join(sourceRoot, ".vibex-plugin", "plugin.json"), "utf8"));
    if (typeof manifest.publisher !== "string" ||
        !/^[a-z0-9][a-z0-9._-]{0,62}$/.test(manifest.publisher) ||
        typeof manifest.id !== "string" ||
        !/^[a-z0-9][a-z0-9._-]{1,62}$/.test(manifest.id)) {
        throw new Error("plugin_identity_invalid");
    }
    return {
        root: sourceRoot,
        identity: { publisher: manifest.publisher, id: manifest.id },
    };
}
function assertActivatedPackage(plugin, result) {
    if (result.plugin.publisher !== plugin.identity.publisher ||
        result.plugin.id !== plugin.identity.id ||
        result.packageDigest !== plugin.packageDigest) {
        throw new Error("plugin_dev_host_response_mismatch");
    }
}
