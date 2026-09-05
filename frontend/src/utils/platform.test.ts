import { afterEach, describe, expect, it } from 'vitest';
import { applyHostPlatformToDocument, getHostPlatform } from './platform';

const originalUserAgentData = (
  navigator as Navigator & { userAgentData?: { platform?: string } }
).userAgentData;
const originalPlatform = navigator.platform;
const originalUserAgent = navigator.userAgent;

function stubPlatform(platform: string): void {
  Object.defineProperty(navigator, 'userAgentData', {
    configurable: true,
    value: { platform },
  });
  Object.defineProperty(navigator, 'platform', {
    configurable: true,
    value: platform,
  });
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    value: platform,
  });
}

afterEach(() => {
  document.documentElement.removeAttribute('data-host-platform');
  document.documentElement.classList.remove('host-windows');
  if (originalUserAgentData === undefined) {
    delete (navigator as Navigator & { userAgentData?: unknown }).userAgentData;
  } else {
    Object.defineProperty(navigator, 'userAgentData', {
      configurable: true,
      value: originalUserAgentData,
    });
  }
  Object.defineProperty(navigator, 'platform', {
    configurable: true,
    value: originalPlatform,
  });
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    value: originalUserAgent,
  });
});

describe('getHostPlatform', () => {
  it('detects Windows, macOS, and Linux', () => {
    stubPlatform('Windows');
    expect(getHostPlatform()).toBe('windows');
    stubPlatform('MacIntel');
    expect(getHostPlatform()).toBe('macos');
    stubPlatform('Linux x86_64');
    expect(getHostPlatform()).toBe('linux');
  });
});

describe('applyHostPlatformToDocument', () => {
  it('exposes Windows and Linux on html for the Inter UI font override', () => {
    stubPlatform('Win32');
    applyHostPlatformToDocument();
    expect(document.documentElement.dataset.hostPlatform).toBe('windows');
    expect(document.documentElement.classList.contains('host-windows')).toBe(
      true
    );

    stubPlatform('Linux x86_64');
    applyHostPlatformToDocument();
    expect(document.documentElement.dataset.hostPlatform).toBe('linux');
    expect(document.documentElement.classList.contains('host-windows')).toBe(
      false
    );
  });

  it('does not mark macOS as Windows', () => {
    stubPlatform('MacIntel');
    applyHostPlatformToDocument();
    expect(document.documentElement.dataset.hostPlatform).toBe('macos');
    expect(document.documentElement.classList.contains('host-windows')).toBe(
      false
    );
  });
});
