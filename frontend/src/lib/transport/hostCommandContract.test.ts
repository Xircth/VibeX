import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DESKTOP_SHELL_COMMANDS, HOST_COMMANDS } from 'shared/hostCommands';

const FRONTEND_ROOT = join(import.meta.dirname, '../..');
const CALL_PATTERN =
  /(?:backendCall|tauriInvoke|\.call|callApplicationCommand|invokeAsResult)(?:<[^>]*>)?\(\s*(?:[^,]+,\s*)?['"]([a-z][a-z0-9_]*)['"]/g;
const SUBSCRIBE_PATTERN =
  /subscribeCommand:\s*['"]([a-z][a-z0-9_]*)['"]/g;
const BARE_CALL_PATTERN =
  /(?<![.\w])call(?:<[^>]*>)?\(\s*['"]([a-z][a-z0-9_]*)['"]/g;

function walkTsFiles(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (
      entry === 'node_modules' ||
      entry.endsWith('.test.ts') ||
      entry.endsWith('.test.tsx')
    ) {
      continue;
    }
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      walkTsFiles(path, files);
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      files.push(path);
    }
  }
  return files;
}

describe('Host command contract', () => {
  it('frontend product commands are registered or desktop-shell', () => {
    const allowed = new Set<string>([
      ...HOST_COMMANDS,
      ...DESKTOP_SHELL_COMMANDS,
    ]);
    const used = new Set<string>();
    for (const file of walkTsFiles(FRONTEND_ROOT)) {
      const source = readFileSync(file, 'utf8');
      for (const pattern of [CALL_PATTERN, SUBSCRIBE_PATTERN, BARE_CALL_PATTERN]) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(source))) {
          if (match[1] !== 'application_call') {
            used.add(match[1]);
          }
        }
      }
    }
    const missing = [...used].filter((command) => !allowed.has(command)).sort();
    expect(missing).toEqual([]);
  });

  it('host and desktop-shell command names do not overlap', () => {
    const host = new Set<string>(HOST_COMMANDS);
    const overlap = DESKTOP_SHELL_COMMANDS.filter((command) =>
      host.has(command)
    );
    expect(overlap).toEqual([]);
  });
});
