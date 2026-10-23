import { existsSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { VibeXPluginManifest } from "@vibex/plugin-sdk";

import { createPackageLock } from "./package.js";
import { validatePlugin } from "./validation.js";

export type PluginIdentity = {
  publisher: string;
  id: string;
};

export interface LinkedPackage {
  root: string;
  manifest: VibeXPluginManifest;
  identity: PluginIdentity;
  packageDigest: string;
}

export function resolvePluginDirectoryInput(input?: string): string {
  const target = input?.trim() || ".";
  const direct = resolve(target);
  if (existsSync(direct)) {
    return direct;
  }
  const userPluginsRoot =
    process.env.VIBEX_USER_PLUGINS_DIR?.trim() ||
    join(homedir(), ".vibex", "plugins");
  const underUserPlugins = join(userPluginsRoot, target);
  if (existsSync(underUserPlugins)) {
    return underUserPlugins;
  }
  return direct;
}

export async function inspectLinkedPackage(
  root: string,
): Promise<LinkedPackage> {
  const resolvedInput = resolvePluginDirectoryInput(root);
  const { root: sourceRoot, manifestPath, rawManifest } =
    await readPluginReference(resolvedInput);
  const isRootV2Manifest =
    !manifestPath.endsWith(join(".vibex-plugin", "plugin.json")) &&
    String(rawManifest.apiVersion) === "2.0";
  if (!isRootV2Manifest) {
    const validation = await validatePlugin(sourceRoot);
    if (!validation.valid || !validation.manifest) {
      const codes = validation.diagnostics.map((item) => item.code).join(", ");
      throw new Error(`plugin_validation_failed${codes ? `: ${codes}` : ""}`);
    }
  }
  const manifest = {
    manifestVersion: 4,
    ...rawManifest,
    publisher: rawManifest.publisher ?? "local",
  } as VibeXPluginManifest;
  const lock = await createPackageLock(sourceRoot);
  return {
    root: sourceRoot,
    manifest,
    identity: { publisher: manifest.publisher, id: manifest.id },
    packageDigest: lock.packageDigest,
  };
}

async function readPluginReference(root: string) {
  const sourceRoot = await realpath(resolve(root));
  if (!(await stat(sourceRoot)).isDirectory()) {
    throw new Error("plugin_link_source_not_directory");
  }
  const nestedManifestPath = join(sourceRoot, ".vibex-plugin", "plugin.json");
  const rootManifestPath = join(sourceRoot, "plugin.json");
  const manifestPath = existsSync(nestedManifestPath)
    ? nestedManifestPath
    : rootManifestPath;
  const manifest = JSON.parse(
    await readFile(manifestPath, "utf8"),
  ) as Partial<VibeXPluginManifest> & { apiVersion?: string };
  const publisher =
    typeof manifest.publisher === "string" && manifest.publisher.trim()
      ? manifest.publisher
      : String(manifest.apiVersion) === "2.0"
        ? "local"
        : undefined;
  if (
    typeof publisher !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,62}$/.test(publisher) ||
    typeof manifest.id !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{1,62}$/.test(manifest.id)
  ) {
    throw new Error("plugin_identity_invalid");
  }
  return {
    root: sourceRoot,
    manifestPath,
    rawManifest: { ...manifest, publisher },
    identity: { publisher, id: manifest.id },
  };
}
