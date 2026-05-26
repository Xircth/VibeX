import { describe, expect, it } from 'vitest';

import { isTerminalTabCloseKey } from './terminalTabClosePolicy';

describe('terminal tab close key policy', () => {
  it('activates close for Enter and Space only', () => {
    expect(isTerminalTabCloseKey('Enter')).toBe(true);
    expect(isTerminalTabCloseKey(' ')).toBe(true);
    expect(isTerminalTabCloseKey('Escape')).toBe(false);
    expect(isTerminalTabCloseKey('Space')).toBe(false);
  });
});
