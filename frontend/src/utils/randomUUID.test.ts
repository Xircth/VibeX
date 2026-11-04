import { describe, expect, it } from 'vitest';
import { installRandomUUIDPolyfill, randomUUID } from './randomUUID';

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('randomUUID', () => {
  it('generates valid RFC 4122 v4 UUIDs and polyfills crypto.randomUUID when undefined', () => {
    const originalRandomUUID = globalThis.crypto.randomUUID;
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      value: undefined,
      configurable: true,
      writable: true,
    });

    try {
      expect(globalThis.crypto.randomUUID).toBeUndefined();
      const first = randomUUID();
      const second = randomUUID();
      expect(first).toMatch(UUID_V4_REGEX);
      expect(second).toMatch(UUID_V4_REGEX);
      expect(first).not.toBe(second);

      installRandomUUIDPolyfill();
      expect(typeof globalThis.crypto.randomUUID).toBe('function');
      expect(globalThis.crypto.randomUUID()).toMatch(UUID_V4_REGEX);
    } finally {
      Object.defineProperty(globalThis.crypto, 'randomUUID', {
        value: originalRandomUUID,
        configurable: true,
        writable: true,
      });
    }
  });
});
