import { describe, expect, it } from 'vitest';
import { defaultSessionPanelWidth } from './dockviewStartupSizing';

describe('dockview startup sizing', () => {
  it('makes only the initial session column 30% narrower', () => {
    // Previous default: 620px. New default: exactly 70% of that.
    expect(defaultSessionPanelWidth(2560, 400)).toBe(434);
    expect(defaultSessionPanelWidth(1440, 400)).toBe(434);
    // The usability floor remains independent from the default.
    expect(defaultSessionPanelWidth(1440, 480)).toBe(480);
  });
});
