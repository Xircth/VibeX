import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendRoot = path.resolve(__dirname, '..');

function readFile(relativePath) {
  return fs.readFileSync(path.join(frontendRoot, relativePath), 'utf8');
}

test('历史消息流兼容 LogMsg::Finished 字符串完成事件', () => {
  const source = readFile('src/utils/streamJsonPatchEntries.ts');

  assert.match(source, /msg === 'Finished' \|\| data\?\.finished !== undefined/);
  assert.match(source, /opts\.onFinished\?\.\(snapshot\.entries\)/);
});

test('terminal fit and writes are guarded by the live xterm instance', () => {
  const source = readFile('src/hooks/useTauriTerminal.ts');

  assert.match(source, /function fitTerminalIfReady/);
  assert.match(source, /hasUsableTerminalContainer\(container\)/);
  assert.match(source, /hasLiveTerminalElement\(terminal, container\)/);
  assert.match(source, /isCurrentInitialization\(\)/);
  assert.match(source, /terminal\.write\(bytes\)/);
});

test('终端在有选区时拦截 Ctrl\/Cmd\+C 做复制', () => {
  const source = readFile('src/hooks/useTauriTerminal.ts');

  assert.match(source, /attachCustomKeyEventHandler/);
  assert.match(source, /hasSelection\(\)/);
  assert.match(source, /getSelection\(\)/);
});

test('终端在无选区时放行 Ctrl\/Cmd\+C 到 PTY', () => {
  const source = readFile('src/hooks/useTauriTerminal.ts');

  assert.match(source, /return true/);
});
