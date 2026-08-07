const ACRONYMS = new Map([
  ['api', 'API'],
  ['url', 'URL'],
  ['id', 'ID'],
  ['mcp', 'MCP'],
  ['acp', 'ACP'],
  ['http', 'HTTP'],
  ['https', 'HTTPS'],
  ['json', 'JSON'],
  ['oauth', 'OAuth'],
  ['ui', 'UI'],
]);

export function containsCjk(value: string): boolean {
  return /[\u3400-\u9fff]/u.test(value);
}

export function humanizeIdentifier(value: string): string {
  return value
    .split(/[_-]+/u)
    .filter(Boolean)
    .map(
      (word) =>
        ACRONYMS.get(word.toLowerCase()) ??
        `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`
    )
    .join(' ');
}
