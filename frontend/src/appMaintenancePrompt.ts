import type { LocalToolStatus } from '@/lib/api';

function versionParts(version: string): number[] {
  return version
    .trim()
    .replace(/^v/i, '')
    .split(/[.-]/)
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part));
}

export function compareVersionLike(current: string, minimum: string): number {
  const currentParts = versionParts(current);
  const minimumParts = versionParts(minimum);
  const length = Math.max(currentParts.length, minimumParts.length);

  for (let index = 0; index < length; index += 1) {
    const currentPart = currentParts[index] ?? 0;
    const minimumPart = minimumParts[index] ?? 0;
    if (currentPart > minimumPart) return 1;
    if (currentPart < minimumPart) return -1;
  }

  return 0;
}

export function localToolNeedsUpdatePrompt(tool: LocalToolStatus): boolean {
  if (!tool.installed) return true;
  if (!tool.minimum_supported_version || !tool.installed_version) return false;

  return (
    compareVersionLike(tool.installed_version, tool.minimum_supported_version) <
    0
  );
}
