export function hashString(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

export function sanitizeDomId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '') || 'diagram';
}

export function createMermaidDiagramId(reactId: string, source: string): string {
  return `mermaid-${sanitizeDomId(reactId)}-${hashString(source)}`;
}
