import { describe, expect, it } from 'vitest';

import {
  completeBrowserAddress,
  isBrowserAddressSubmitKey,
} from './completeAddress';

describe('isBrowserAddressSubmitKey', () => {
  it('submits only a bare Enter', () => {
    expect(isBrowserAddressSubmitKey({ key: 'Enter', code: 'Enter' })).toBe(
      true
    );
    expect(
      isBrowserAddressSubmitKey({ key: 'NumpadEnter', code: 'NumpadEnter' })
    ).toBe(true);
    expect(isBrowserAddressSubmitKey({ key: 'Shift', code: 'ShiftLeft' })).toBe(
      false
    );
    expect(
      isBrowserAddressSubmitKey({
        key: 'Enter',
        code: 'ShiftLeft',
        shiftKey: true,
      })
    ).toBe(false);
    expect(
      isBrowserAddressSubmitKey({
        key: 'Enter',
        code: 'Enter',
        shiftKey: true,
      })
    ).toBe(false);
    expect(
      isBrowserAddressSubmitKey({ key: 'Enter', code: 'Enter', keyCode: 229 })
    ).toBe(false);
  });
});

describe('completeBrowserAddress', () => {
  it('leaves a full http(s) address alone', () => {
    expect(completeBrowserAddress('https://example.com/path')).toBe(
      'https://example.com/path'
    );
    expect(completeBrowserAddress('http://localhost:3000')).toBe(
      'http://localhost:3000/'
    );
  });

  it('adds https for a bare hostname', () => {
    expect(completeBrowserAddress('baidu.com')).toBe('https://baidu.com/');
    expect(completeBrowserAddress('www.example.com/search?q=1')).toBe(
      'https://www.example.com/search?q=1'
    );
  });

  it('uses http for localhost and loopback', () => {
    expect(completeBrowserAddress('localhost:5173')).toBe(
      'http://localhost:5173/'
    );
    expect(completeBrowserAddress('127.0.0.1:8080')).toBe(
      'http://127.0.0.1:8080/'
    );
  });

  it('accepts about:blank and rejects empty or unknown schemes', () => {
    expect(completeBrowserAddress('about:blank')).toBe('about:blank');
    expect(completeBrowserAddress('   ')).toBeNull();
    expect(completeBrowserAddress('javascript:alert(1)')).toBeNull();
    expect(completeBrowserAddress('file:///tmp/x')).toBeNull();
    expect(completeBrowserAddress('not a host')).toBeNull();
    expect(completeBrowserAddress('baidu')).toBeNull();
  });
});
