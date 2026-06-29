#!/usr/bin/env node

const { spawnSync } = require('child_process');

const workflowFile = 'desktop-release.yml';

function readOption(name) {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);

  if (index !== -1) {
    return args[index + 1] || null;
  }

  const prefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : null;
}

function hasFlag(name) {
  return process.argv.slice(2).includes(name);
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    ...options,
  });
}

function readGitValue(args) {
  const result = run('git', args);
  return result.status === 0 ? result.stdout.trim() : null;
}

function resolveRef() {
  return (
    readOption('--ref') ||
    readGitValue(['symbolic-ref', '--short', 'HEAD']) ||
    readGitValue(['describe', '--tags', '--exact-match']) ||
    readGitValue(['rev-parse', 'HEAD'])
  );
}

const ref = resolveRef();
const releaseTag = readOption('--release-tag');
const uploadToRelease = hasFlag('--upload-to-release');

if (!ref) {
  console.error('Unable to resolve a git ref for the desktop build workflow.');
  process.exit(1);
}

if (uploadToRelease && !releaseTag) {
  console.error('Pass --release-tag <tag> when using --upload-to-release.');
  process.exit(1);
}

const ghArgs = ['workflow', 'run', workflowFile, '--ref', ref];

if (releaseTag) {
  ghArgs.push('-f', `release_tag=${releaseTag}`);
}

if (uploadToRelease) {
  ghArgs.push('-f', 'upload_to_release=true');
}

console.log(`Triggering ${workflowFile} on ${ref}...`);

if (uploadToRelease) {
  console.log(`Release ${releaseTag} will be created if it does not exist.`);
}

const result = run('gh', ghArgs, { stdio: 'inherit' });

if (result.error) {
  console.error(
    [
      'Failed to start the desktop build workflow.',
      '',
      'Install and authenticate GitHub CLI, then retry:',
      '  gh auth login',
      `  gh workflow run ${workflowFile} --ref ${ref}`,
    ].join('\n')
  );
  process.exit(1);
}

if (result.status !== 0) {
  console.error(
    [
      '',
      'Desktop build workflow was not started.',
      `If GitHub reports "${workflowFile} not found", commit and push .github/workflows/${workflowFile} to the default branch first.`,
      'Then rerun:',
      '  pnpm run tauri:build:all',
    ].join('\n')
  );
}

process.exit(result.status ?? 1);
