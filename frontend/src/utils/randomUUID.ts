type UUIDString = `${string}-${string}-${string}-${string}-${string}`;

function fallbackRandomUUID(): UUIDString {
  const bytes = new Uint8Array(16);
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    cryptoObj.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }

  // RFC 4122 section 4.4: set version to 4 (0100xxxx) and variant to 10xxxxxx
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Generates an RFC 4122 version 4 UUID that works in both secure (HTTPS / localhost)
 * and insecure (HTTP LAN / public IP) browser contexts.
 */
export function randomUUID(): UUIDString {
  const cryptoObj = globalThis.crypto;
  if (
    cryptoObj &&
    typeof cryptoObj.randomUUID === 'function' &&
    cryptoObj.randomUUID !== fallbackRandomUUID
  ) {
    return cryptoObj.randomUUID();
  }
  return fallbackRandomUUID();
}

export function installRandomUUIDPolyfill(): void {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID !== 'function') {
    try {
      Object.defineProperty(cryptoObj, 'randomUUID', {
        value: fallbackRandomUUID,
        configurable: true,
        writable: true,
      });
    } catch {
      // Ignore if globalThis.crypto is frozen in the current environment
    }
  }
}

installRandomUUIDPolyfill();
