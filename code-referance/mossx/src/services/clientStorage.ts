import { invoke } from "@tauri-apps/api/core";

export type ClientStoreName = "layout" | "composer" | "threads" | "app";

const ALL_STORES: ClientStoreName[] = ["layout", "composer", "threads", "app"];

const cache: Partial<Record<ClientStoreName, Record<string, unknown>>> = {};

let preloaded = false;

const WRITE_DEBOUNCE_MS = 300;
const pendingTimers: Partial<Record<ClientStoreName, ReturnType<typeof setTimeout>>> = {};

export async function preloadClientStores(): Promise<void> {
  if (preloaded) {
    return;
  }
  const results = await Promise.all(
    ALL_STORES.map(async (store) => {
      try {
        const data = await invoke<Record<string, unknown> | null>(
          "client_store_read",
          { store },
        );
        return [store, data ?? {}] as const;
      } catch {
        return [store, {}] as const;
      }
    }),
  );
  for (const [store, data] of results) {
    cache[store] = data;
  }
  preloaded = true;
}

export function isPreloaded(): boolean {
  return preloaded;
}

export function getClientStoreSync<T = unknown>(
  store: ClientStoreName,
  key: string,
): T | undefined {
  const storeData = cache[store];
  if (!storeData) {
    return undefined;
  }
  return storeData[key] as T | undefined;
}

export function getClientStoreFullSync<T = Record<string, unknown>>(
  store: ClientStoreName,
): T | undefined {
  return cache[store] as T | undefined;
}

export function writeClientStoreValue(
  store: ClientStoreName,
  key: string,
  value: unknown,
): void {
  if (!cache[store]) {
    cache[store] = {};
  }
  cache[store]![key] = value;
  scheduleDiskWrite(store);
}

export function writeClientStoreData(
  store: ClientStoreName,
  data: Record<string, unknown>,
): void {
  cache[store] = data;
  scheduleDiskWrite(store);
}

function scheduleDiskWrite(store: ClientStoreName): void {
  if (pendingTimers[store] != null) {
    clearTimeout(pendingTimers[store]);
  }
  pendingTimers[store] = setTimeout(() => {
    delete pendingTimers[store];
    const data = cache[store] ?? {};
    invoke("client_store_write", { store, data }).catch((error) => {
      if (typeof console !== "undefined") {
        console.error(`Failed to write client store "${store}":`, error);
      }
    });
  }, WRITE_DEBOUNCE_MS);
}
