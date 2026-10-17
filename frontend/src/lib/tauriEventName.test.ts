import { describe, expect, it } from 'vitest';
import { isValidTauriEventName } from './tauriEventName';

describe('isValidTauriEventName', () => {
  it('accepts the Tauri listen charset', () => {
    expect(isValidTauriEventName('plugin:browser')).toBe(true);
    expect(isValidTauriEventName('conversation-events:abc-123')).toBe(true);
    expect(isValidTauriEventName('slash-commands-stream:none:default')).toBe(
      true
    );
  });

  it('rejects the dotted plugin.browser name that Tauri listen throws on', () => {
    expect(isValidTauriEventName('plugin.browser')).toBe(false);
    expect(isValidTauriEventName('agent.activity')).toBe(false);
    expect(isValidTauriEventName('')).toBe(false);
  });
});
