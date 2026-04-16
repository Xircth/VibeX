import type { GitFileStatusEntry, GitFileDiffEntry } from 'shared/types';

/**
 * Generates a conventional commit message by analyzing staged files and diffs.
 * Uses heuristics to determine the commit type, scope, and description.
 */
export function generateCommitMessage(
  stagedFiles: GitFileStatusEntry[],
  diffs: GitFileDiffEntry[]
): string {
  if (stagedFiles.length === 0) {
    return '';
  }

  const type = detectCommitType(stagedFiles, diffs);
  const scope = detectScope(stagedFiles);
  const description = generateDescription(stagedFiles, diffs);

  const scopePart = scope ? `(${scope})` : '';
  return `${type}${scopePart}: ${description}`;
}

function detectCommitType(
  files: GitFileStatusEntry[],
  diffs: GitFileDiffEntry[]
): string {
  const paths = files.map((f) => f.path.toLowerCase());
  const statuses = files.map((f) => f.status);

  // All new files → feat
  if (statuses.every((s) => s === 'A' || s === '?')) {
    return 'feat';
  }

  // All deleted files → chore
  if (statuses.every((s) => s === 'D')) {
    return 'chore';
  }

  // Test files
  if (paths.every((p) => isTestFile(p))) {
    return 'test';
  }

  // Documentation files
  if (paths.every((p) => isDocFile(p))) {
    return 'docs';
  }

  // Config/build files
  if (paths.every((p) => isConfigFile(p))) {
    return 'chore';
  }

  // Style files only
  if (paths.every((p) => isStyleFile(p))) {
    return 'style';
  }

  // Check diff content for fix indicators
  const diffTexts = diffs
    .filter((d) => files.some((f) => f.path === d.path))
    .map((d) => d.diff)
    .join('\n')
    .toLowerCase();

  if (
    diffTexts.includes('fix') ||
    diffTexts.includes('bug') ||
    diffTexts.includes('error') ||
    diffTexts.includes('patch')
  ) {
    return 'fix';
  }

  // Mix of adds and modifies → feat
  if (statuses.includes('A') || statuses.includes('?')) {
    return 'feat';
  }

  // Pure renames
  if (statuses.every((s) => s === 'R')) {
    return 'refactor';
  }

  // Default: modifications
  return 'refactor';
}

function detectScope(files: GitFileStatusEntry[]): string {
  const paths = files.map((f) => f.path.replace(/\\/g, '/'));

  // Find common directory prefix
  const dirs = paths.map((p) => {
    const parts = p.split('/');
    parts.pop(); // remove filename
    return parts;
  });

  if (dirs.length === 0) return '';

  // Check for known top-level directories
  const topDirs = new Set(dirs.map((d) => d[0]).filter(Boolean));

  if (topDirs.size === 1) {
    const topDir = [...topDirs][0];

    // Second-level directory as scope for known structures
    const secondDirs = new Set(
      dirs.filter((d) => d.length > 1 && d[0] === topDir).map((d) => d[1])
    );

    if (secondDirs.size === 1) {
      const secondDir = [...secondDirs][0];
      // For deeper paths, check third level
      const thirdDirs = new Set(
        dirs
          .filter((d) => d.length > 2 && d[0] === topDir && d[1] === secondDir)
          .map((d) => d[2])
      );

      if (thirdDirs.size === 1) {
        return [...thirdDirs][0];
      }
      return secondDir;
    }

    if (
      topDir === 'frontend' ||
      topDir === 'src-tauri' ||
      topDir === 'crates'
    ) {
      return topDir;
    }
  }

  // Multiple top-level dirs
  if (topDirs.size <= 3) {
    return [...topDirs].join(',');
  }

  return '';
}

function generateDescription(
  files: GitFileStatusEntry[],
  _diffs: GitFileDiffEntry[]
): string {
  const statuses = files.map((f) => f.status);
  const fileNames = files.map((f) => {
    const parts = f.path.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1];
  });

  // Single file → mention it by name
  if (files.length === 1) {
    const file = files[0];
    const name = fileNames[0];
    const baseName = name.replace(/\.[^.]+$/, '');

    switch (file.status) {
      case 'A':
      case '?':
        return `add ${baseName}`;
      case 'D':
        return `remove ${baseName}`;
      case 'R':
        return `rename ${baseName}`;
      case 'M':
      default:
        return `update ${baseName}`;
    }
  }

  // All same status
  if (new Set(statuses).size === 1) {
    const status = statuses[0];
    const count = files.length;
    switch (status) {
      case 'A':
      case '?':
        return `add ${count} files`;
      case 'D':
        return `remove ${count} files`;
      case 'R':
        return `rename ${count} files`;
      case 'M':
        return `update ${count} files`;
    }
  }

  // Group by extension to find the dominant file type
  const extGroups = new Map<string, number>();
  for (const name of fileNames) {
    const ext = name.includes('.') ? (name.split('.').pop() ?? '') : '';
    extGroups.set(ext, (extGroups.get(ext) ?? 0) + 1);
  }

  // Find the most common extension
  let dominantExt = '';
  let maxCount = 0;
  for (const [ext, count] of extGroups) {
    if (count > maxCount) {
      maxCount = count;
      dominantExt = ext;
    }
  }

  // Find common component names
  const componentNames = fileNames
    .filter(
      (n) => /^[A-Z]/.test(n) && (n.endsWith('.tsx') || n.endsWith('.jsx'))
    )
    .map((n) => n.replace(/\.[^.]+$/, ''));

  if (componentNames.length > 0 && componentNames.length <= 3) {
    return `update ${componentNames.join(', ')}`;
  }

  const added = statuses.filter((s) => s === 'A' || s === '?').length;
  const modified = statuses.filter((s) => s === 'M').length;
  const deleted = statuses.filter((s) => s === 'D').length;

  const parts: string[] = [];
  if (added > 0) parts.push(`add ${added}`);
  if (modified > 0) parts.push(`update ${modified}`);
  if (deleted > 0) parts.push(`remove ${deleted}`);

  if (dominantExt) {
    return `${parts.join(', ')} ${dominantExt} files`;
  }

  return `${parts.join(', ')} files`;
}

function isTestFile(path: string): boolean {
  return (
    path.includes('test') ||
    path.includes('spec') ||
    path.includes('__tests__') ||
    path.endsWith('.test.ts') ||
    path.endsWith('.test.tsx') ||
    path.endsWith('.spec.ts') ||
    path.endsWith('.spec.tsx')
  );
}

function isDocFile(path: string): boolean {
  return (
    path.endsWith('.md') ||
    path.endsWith('.txt') ||
    path.endsWith('.rst') ||
    path.includes('docs/') ||
    path.includes('readme')
  );
}

function isConfigFile(path: string): boolean {
  const name = path.split('/').pop() ?? '';
  return (
    name.startsWith('.') ||
    name.includes('config') ||
    name.includes('rc') ||
    name === 'package.json' ||
    name === 'tsconfig.json' ||
    name === 'Cargo.toml' ||
    name === 'Cargo.lock' ||
    name.endsWith('.toml') ||
    name.endsWith('.yaml') ||
    name.endsWith('.yml') ||
    name === 'pnpm-lock.yaml'
  );
}

function isStyleFile(path: string): boolean {
  return (
    path.endsWith('.css') ||
    path.endsWith('.scss') ||
    path.endsWith('.less') ||
    path.endsWith('.styl')
  );
}
