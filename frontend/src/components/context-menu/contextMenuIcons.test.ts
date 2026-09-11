import { describe, expect, it } from 'vitest';
import { Copy, Plus } from 'lucide-react';
import { contextMenuIcon } from './contextMenuIcons';

describe('contextMenuIcon', () => {
  it('resolves built-in icons by item id', () => {
    expect(contextMenuIcon('create-session')).toBe(Plus);
    expect(contextMenuIcon('copy')).toBe(Copy);
    expect(contextMenuIcon('auto-sort')).toBeTruthy();
    expect(contextMenuIcon('fork-session')).toBeTruthy();
  });

  it('prefers an explicit override', () => {
    expect(contextMenuIcon('copy', Plus)).toBe(Plus);
  });
});
