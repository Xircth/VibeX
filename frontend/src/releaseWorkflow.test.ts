import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '../..');

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf8');
}

function cargoPackageName(packageDirectory: string): string {
  const manifest = read(`${packageDirectory}/Cargo.toml`);
  const name = manifest.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
  if (!name) throw new Error(`Missing package name in ${packageDirectory}`);
  return name;
}

function cargoBinaryNames(packageDirectory: string): string[] {
  const manifest = read(`${packageDirectory}/Cargo.toml`);
  const explicit = [
    ...manifest.matchAll(/\[\[bin\]\][\s\S]*?^name\s*=\s*"([^"]+)"/gm),
  ].map((match) => match[1]);
  const srcBinDirectory = join(repoRoot, packageDirectory, 'src/bin');
  const srcBin = existsSync(srcBinDirectory)
    ? readdirSync(srcBinDirectory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.rs'))
        .map((entry) => basename(entry.name, '.rs'))
    : [];
  return [...new Set([...explicit, ...srcBin])];
}

describe('release binary contract', () => {
  it('builds and packages the Cargo binary targets that actually exist', () => {
    const packages = ['crates/server', 'crates/vibex-mcp', 'crates/review'].map(
      (directory) => ({
        directory,
        packageName: cargoPackageName(directory),
        binaryNames: cargoBinaryNames(directory),
      })
    );

    expect(packages).toEqual([
      {
        directory: 'crates/server',
        packageName: 'server',
        binaryNames: ['vibex-server'],
      },
      {
        directory: 'crates/vibex-mcp',
        packageName: 'vibex-mcp',
        binaryNames: ['vibex-mcp'],
      },
      {
        directory: 'crates/review',
        packageName: 'review',
        binaryNames: ['review'],
      },
    ]);

    for (const workflowPath of [
      '.github/workflows/release.yml',
      '.github/workflows/pre-release.yml',
    ]) {
      const workflow = read(workflowPath);
      for (const { packageName, binaryNames } of packages) {
        expect(workflow, workflowPath).toContain(`-p ${packageName}`);
        for (const binaryName of binaryNames) {
          expect(workflow, workflowPath).toContain(`--bin ${binaryName}`);
          expect(workflow, workflowPath).toContain(`release/${binaryName}`);
        }
      }
      expect(workflow, workflowPath).not.toContain('mcp_task_server');
      expect(workflow, workflowPath).not.toMatch(/release\/server(?:\.exe)?\b/);
    }
  });

  it('uses the current server binary target for backend development', () => {
    const launcher = read('scripts/run-backend-dev.js');
    expect(launcher).toContain('run --bin vibex-server');
    expect(launcher).not.toContain('run --bin server');
  });
});
