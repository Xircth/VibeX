export function toVibeImagePath(filePath: string): string {
  if (filePath.startsWith('.vibe-images/')) {
    return filePath;
  }

  return `.vibe-images/${filePath.replace(/^[/\\]+/, '')}`;
}
