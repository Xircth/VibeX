import { afterEach, describe, expect, it } from 'vitest';

import { clearLocalStorageCache } from '@/lib/safeStorage';
import {
  BROWSER_ADDRESS_HISTORY_KEY,
  recordBrowserAddress,
  readBrowserAddressHistory,
  suggestBrowserAddresses,
} from './browserAddressHistory';

describe('browserAddressHistory', () => {
  afterEach(() => {
    window.localStorage.clear();
    clearLocalStorageCache();
  });

  it('records submitted addresses most-recent first and skips blanks', () => {
    expect(recordBrowserAddress('')).toEqual([]);
    expect(recordBrowserAddress('about:blank')).toEqual([]);
    recordBrowserAddress('baidu.com');
    recordBrowserAddress('https://github.com/vibex');
    recordBrowserAddress('https://baidu.com/');
    expect(readBrowserAddressHistory()).toEqual([
      'https://baidu.com/',
      'https://github.com/vibex',
    ]);
    expect(window.localStorage.getItem(BROWSER_ADDRESS_HISTORY_KEY)).toContain(
      'baidu.com'
    );
  });

  it('suggests recent and matching addresses', () => {
    recordBrowserAddress('https://github.com/vibex');
    recordBrowserAddress('https://www.baidu.com/');
    recordBrowserAddress('http://localhost:5173');
    expect(suggestBrowserAddresses('')).toEqual([
      'http://localhost:5173',
      'https://www.baidu.com/',
      'https://github.com/vibex',
    ]);
    expect(suggestBrowserAddresses('bai')).toEqual(['https://www.baidu.com/']);
    expect(suggestBrowserAddresses('GITHUB')).toEqual([
      'https://github.com/vibex',
    ]);
  });
});
