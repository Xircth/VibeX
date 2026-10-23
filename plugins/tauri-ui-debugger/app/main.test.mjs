import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLabel,
  buildMarkdown,
  formatShortcut,
  isMainWindow,
  matchesShortcut,
  normalizeConfig,
  contentLevel,
  truncate,
} from './main.js';

const info = {
  tag: 'button',
  classes: ['raised-control'],
  text: '发送',
  component: 'SendBar',
  chain: ['SendBar', 'Composer', 'ConversationPane'],
  source: 'frontend/src/components/SendBar.tsx:42:7',
  selector: 'main > div.composer > button:nth-of-type(2)',
  rect: { x: 812, y: 640, width: 96, height: 32 },
  styles: 'display:flex; padding:0 12px; border-radius:8px',
};

test('label and markdown match the spec format', () => {
  assert.equal(buildLabel(info), '<SendBar> SendBar.tsx:42');
  assert.equal(
    buildMarkdown(info, 3),
    [
      '[UI 元素] <button.raised-control> 文本: "发送"',
      '- 组件链: SendBar > Composer > ConversationPane',
      '- 源码: frontend/src/components/SendBar.tsx:42:7 (data-vx-source)',
      '- 选择器: main > div.composer > button:nth-of-type(2)',
      '- 尺寸: 96×32 @ (812, 640)',
      '- 关键样式: display:flex; padding:0 12px; border-radius:8px',
    ].join('\n')
  );
  const level1 = buildMarkdown(info, 1);
  assert.ok(level1.includes('- 源码:'));
  assert.ok(!level1.includes('组件链'));
  assert.ok(!level1.includes('关键样式'));
});

test('text truncation at 80 chars', () => {
  assert.equal(Array.from(truncate('字'.repeat(100))).length, 81);
});

test('config normalization and levels', () => {
  const c = normalizeConfig({ ballPosition: 'x', shortcut: '关闭' });
  assert.equal(c.ballPosition, '左下角');
  assert.equal(c.shortcut, '关闭');
  assert.equal(contentLevel(c), 2);
});

test('shortcuts are platform aware', () => {
  assert.equal(formatShortcut('Alt+Shift+C', true), '⌥⇧C');
  assert.equal(formatShortcut('Ctrl+Shift+X', true), '⌘⇧X');
  assert.equal(formatShortcut('Ctrl+Shift+X', false), 'Ctrl+Shift+X');
  const ev = { altKey: true, shiftKey: true, ctrlKey: false, metaKey: false, code: 'KeyC' };
  assert.ok(matchesShortcut(ev, 'Alt+Shift+C', false));
  assert.ok(!matchesShortcut(ev, '关闭', false));
  assert.ok(matchesShortcut({ metaKey: true, shiftKey: true, code: 'KeyX' }, 'Ctrl+Shift+X', true));
});

test('ball mounts only in app windows', () => {
  assert.equal(isMainWindow({ label: 'main', pathname: '/plugins' }), true);
  assert.equal(isMainWindow({ label: 'app-3' }), true);
  assert.equal(isMainWindow({ label: 'settings' }), false);
  assert.equal(isMainWindow({ label: 'settings-host-abc' }), false);
  assert.equal(isMainWindow({ label: 'desktop-toast' }), false);
  // No runtime label: fall back to route prefixes.
  assert.equal(isMainWindow({ pathname: '/' }), true);
  assert.equal(isMainWindow({ pathname: '/settings/plugins' }), false);
  assert.equal(isMainWindow({ pathname: '/plugins/x' }), false);
  assert.equal(isMainWindow({ pathname: '/settingsfoo' }), true);
});
