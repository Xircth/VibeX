export type TerminalOutputPayload = {
  data: string;
  seq: number;
};

export function parseTerminalOutputPayload(
  payload: unknown
): TerminalOutputPayload | null {
  if (typeof payload === 'string') {
    return { data: payload, seq: 0 };
  }
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const record = payload as { data?: unknown; seq?: unknown };
  if (typeof record.data !== 'string') {
    return null;
  }
  const seq =
    typeof record.seq === 'number' && Number.isFinite(record.seq)
      ? record.seq
      : 0;
  return { data: record.data, seq };
}
