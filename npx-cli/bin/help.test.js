const assert = require('node:assert/strict');
const test = require('node:test');

const { isHelp, isVersion, helpTopic, text } = require('./help');

test('recognizes help and version flags', () => {
  assert.equal(isHelp(['help']), true);
  assert.equal(isHelp(['--help']), true);
  assert.equal(isHelp(['-h']), true);
  assert.equal(isHelp(['serve', '--help']), true);
  assert.equal(isHelp(['serve']), false);
  assert.equal(isVersion(['--version']), true);
  assert.equal(isVersion(['-V']), true);
  assert.equal(isVersion(['version']), true);
});

test('help topics cover serve and control commands', () => {
  assert.equal(helpTopic(['help', 'serve']), 'serve');
  assert.equal(helpTopic(['serve', '--help']), 'serve');
  assert.match(text(), /serve, web/);
  assert.match(text(), /list/);
  assert.match(text(), /install <id>/);
  assert.match(text('serve'), /--rotate-token/);
  assert.match(text('web'), /--rotate-token/);
  assert.match(text('list'), /--refresh/);
  assert.match(text('install'), /--yes/);
  assert.match(text('conversation'), /send\s+--conversation/);
  assert.match(text('plugin'), /plugin add --web/);
  assert.match(text('plugin'), /--profile/);
  assert.match(text('plugin'), /--dev/);
  assert.match(text('plugin'), /plugin list/);
  assert.match(text('plugin'), /plugin update/);
  assert.match(text('plugin'), /plugin remove/);
  assert.match(text('plugin'), /gc-runtimes/);
  assert.match(text('plugin'), /#tag/);
  assert.match(text(), /plugin add/);
  assert.match(text(), /plugin list/);
  assert.match(text(), /plugin remove/);
  assert.match(text('unknown-cmd'), /Unknown command/);
});
