import { readFile, realpath, stat } from "node:fs/promises";
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

export async function inspectLinkedPackage(
  root: string,
): Promise<LinkedPackage> {
  const { root: sourceRoot } = await readPluginReference(root);
  const validation = await validatePlugin(sourceRoot);
  if (!validation.valid || !validation.manifest) {
    const codes = validation.diagnostics.map((item) => item.code).join(", ");
    throw new Error(`plugin_validation_failed${codes ? `: ${codes}` : ""}`);
  }
  const manifest = JSON.parse(
    await readFile(join(sourceRoot, ".vibex-plugin", "plugin.json"), "utf8"),
  ) as VibeXPluginManifest;
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
  const manifest = JSON.parse(
    await readFile(join(sourceRoot, ".vibex-plugin", "plugin.json"), "utf8"),
  ) as Partial<VibeXPluginManifest>;
  if (
    typeof manifest.publisher !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,62}$/.test(manifest.publisher) ||
    typeof manifest.id !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{1,62}$/.test(manifest.id)
  ) {
    throw new Error("plugin_identity_invalid");
  }
  return {
    root: sourceRoot,
    identity: { publisher: manifest.publisher, id: manifest.id },
  };
}
