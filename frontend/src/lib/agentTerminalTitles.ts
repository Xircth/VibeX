export function agentTerminalLabel(agentId: string | null | undefined): string {
  const key = agentId?.trim().toLowerCase() ?? '';
  switch (key) {
    case 'codex':
      return 'Codex';
    case 'claude_code':
      return 'Claude';
    case 'grok':
      return 'Grok';
    case 'opencode':
      return 'OpenCode';
    case 'antigravity':
    case 'gemini':
      return 'Antigravity';
    case 'deepseek_harness':
      return 'DeepSeek';
    case 'hermes':
      return 'Hermes';
    case 'kimi_code':
      return 'Kimi';
    case 'cline':
      return 'Cline';
    case 'codebuddy':
      return 'CodeBuddy';
    case 'pi':
      return 'Pi';
    case 'openclaw':
      return 'OpenClaw';
    case 'cursor':
      return 'Cursor';
    default: {
      if (!key) {
        return 'Agent';
      }
      const token = key.split(/[._-]/)[0] ?? 'Agent';
      return token.charAt(0).toUpperCase() + token.slice(1);
    }
  }
}

export function nextAgentTerminalTitle(
  agentId: string | null | undefined,
  existingTitles: readonly string[]
): string {
  const label = agentTerminalLabel(agentId);
  const used = new Set<number>();
  const prefix = `${label}-`;
  for (const title of existingTitles) {
    if (!title.startsWith(prefix)) {
      continue;
    }
    const suffix = title.slice(prefix.length);
    if (/^\d+$/.test(suffix)) {
      used.add(Number(suffix));
    }
  }

  let index = 1;
  while (used.has(index)) {
    index += 1;
  }
  return `${label}-${String(index).padStart(2, '0')}`;
}
