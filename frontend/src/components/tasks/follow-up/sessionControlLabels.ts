function normalizedControlLabel(value: string): string {
  return value.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

/** Keep the ACP value untouched while shortening Codex's verbose UI label. */
export function compactSessionControlLabel(
  value: string,
  advertisedLabel: string
): string {
  const isAgentFullAccess =
    normalizedControlLabel(value) === 'agentfullaccess' ||
    normalizedControlLabel(advertisedLabel) === 'agentfullaccess';
  return isAgentFullAccess ? '完全访问' : advertisedLabel;
}
