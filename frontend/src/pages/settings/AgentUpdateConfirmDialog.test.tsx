import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('AgentUpdateConfirmDialog', () => {
  it('does not render a header icon', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/pages/settings/AgentUpdateConfirmDialog.tsx'),
      'utf8'
    );
    expect(source).not.toContain('agent-update-dialog-icon');
    expect(source).not.toContain('RefreshCw');
  });
});
