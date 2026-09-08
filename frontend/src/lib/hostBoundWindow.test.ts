import { describe, expect, it } from 'vitest';

import {
  isHostAppWindowLabel,
  isHostBoundWindowLabel,
} from './hostBoundWindow';

describe('isHostBoundWindowLabel', () => {
  it('treats Host windows and their Settings companion as Server-bound', () => {
    expect(isHostAppWindowLabel('host-ssh-1')).toBe(true);
    expect(isHostAppWindowLabel('settings-host-ssh-1')).toBe(false);
    expect(isHostBoundWindowLabel('host-ssh-1')).toBe(true);
    expect(isHostBoundWindowLabel('settings-host-ssh-1')).toBe(true);
  });

  it('keeps local App windows on the local Host', () => {
    expect(isHostAppWindowLabel('main')).toBe(false);
    expect(isHostAppWindowLabel('settings')).toBe(false);
    expect(isHostBoundWindowLabel('main')).toBe(false);
    expect(isHostBoundWindowLabel('settings')).toBe(false);
    expect(isHostBoundWindowLabel('app-local-1')).toBe(false);
    expect(isHostBoundWindowLabel('host-')).toBe(false);
    expect(isHostBoundWindowLabel('settings-host-')).toBe(false);
    expect(isHostBoundWindowLabel('desktop-toast')).toBe(false);
  });
});
