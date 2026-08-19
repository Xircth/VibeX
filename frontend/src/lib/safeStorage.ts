const memory = new Map<string, string | null>();

function canUseLocalStorage(): boolean {
  return (
    typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
  );
}

export function readLocalStorage(key: string): string | null {
  if (memory.has(key)) {
    return memory.get(key) ?? null;
  }
  if (!canUseLocalStorage()) {
    memory.set(key, null);
    return null;
  }
  try {
    const value = window.localStorage.getItem(key);
    memory.set(key, value);
    return value;
  } catch {
    memory.set(key, null);
    return null;
  }
}

export function writeLocalStorage(key: string, value: string): void {
  memory.set(key, value);
  if (!canUseLocalStorage()) {
    return;
  }
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private mode, quota, or disabled storage.
  }
}

export function clearLocalStorageCache(key?: string): void {
  if (key) {
    memory.delete(key);
    return;
  }
  memory.clear();
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key) {
      memory.delete(event.key);
    } else {
      memory.clear();
    }
  });
}
