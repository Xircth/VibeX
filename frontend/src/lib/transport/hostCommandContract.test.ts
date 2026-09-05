import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DESKTOP_SHELL_COMMANDS,
  HOST_COMMAND_DESCRIPTORS,
  HOST_COMMANDS,
  HOST_EVENT_CHANNELS,
} from 'shared/hostCommands';

const FRONTEND_ROOT = join(import.meta.dirname, '../..');
const CALL_PATTERN =
  /(?:backendCall|desktopShellCall|tauriInvoke|\.call|callApplicationCommand|invokeAsResult)(?:<[^>]*>)?\(\s*(?:[^,]+,\s*)?['"]([a-z][a-z0-9_]*)['"]/g;
const HOST_TRANSPORT_CALL_PATTERN =
  /(?:backendCall|callApplicationCommand|invokeAsResult)(?:<[^>]*>)?\(\s*(?:[^,]+,\s*)?['"]([a-z][a-z0-9_]*)['"]/g;
const SUBSCRIBE_PATTERN = /subscribeCommand:\s*['"]([a-z][a-z0-9_]*)['"]/g;
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
      for (const pattern of [
        CALL_PATTERN,
        SUBSCRIBE_PATTERN,
        BARE_CALL_PATTERN,
      ]) {
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

  it('host transport facades never call desktop-shell commands', () => {
    const shell = new Set<string>(DESKTOP_SHELL_COMMANDS);
    const violations: string[] = [];
    for (const file of walkTsFiles(FRONTEND_ROOT)) {
      const source = readFileSync(file, 'utf8');
      HOST_TRANSPORT_CALL_PATTERN.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = HOST_TRANSPORT_CALL_PATTERN.exec(source))) {
        if (shell.has(match[1])) {
          violations.push(`${file}:${match[1]}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('trash_item is a host file command, not a desktop-shell command', () => {
    expect(HOST_COMMANDS).toContain('trash_item');
    expect(DESKTOP_SHELL_COMMANDS).not.toContain('trash_item');
  });

  it('session product commands stay out of the desktop shell list', () => {
    const product = [
      'conversation_attach',
      'conversation_detail',
      'conversation_events_since',
      'conversation_ensure_session_controls',
      'conversation_list',
      'conversation_create',
      'conversation_start_turn',
    ];
    const shell = new Set<string>(DESKTOP_SHELL_COMMANDS);
    expect(product.filter((command) => shell.has(command))).toEqual([]);
    expect(HOST_COMMANDS).toContain('conversation_attach');
  });

  it('every host command has a generated descriptor', () => {
    const described = new Set(
      HOST_COMMAND_DESCRIPTORS.map((descriptor) => descriptor.name)
    );
    expect([...HOST_COMMANDS].sort()).toEqual([...described].sort());
    expect(
      HOST_COMMAND_DESCRIPTORS.find(
        (descriptor) => descriptor.name === 'conversation_attach'
      )
    ).toEqual({
      name: 'conversation_attach',
      scope: 'conversation.attach',
      kind: 'core',
      argShape: 'request',
    });
  });

  it('host event channels declare durability and scope', () => {
    expect(HOST_EVENT_CHANNELS.length).toBeGreaterThan(0);
    for (const channel of HOST_EVENT_CHANNELS) {
      expect(channel.prefix.length).toBeGreaterThan(0);
      expect(['durable', 'invalidation', 'best_effort']).toContain(
        channel.durability
      );
      expect(channel.scope.length).toBeGreaterThan(0);
    }
  });
});
