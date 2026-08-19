const drafts = new Map<string, unknown>();

export function retainAgentSettingsDraft<T>(key: string, value: T) {
  drafts.set(key, value);
}

export function peekAgentSettingsDraft<T>(key: string): T | null {
  if (!drafts.has(key)) return null;
  return drafts.get(key) as T;
}

export function clearAgentSettingsDraft(key: string) {
  drafts.delete(key);
}

export function clearAllAgentSettingsDrafts() {
  drafts.clear();
}
