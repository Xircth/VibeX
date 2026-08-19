import { describe, expect, it } from 'vitest';
import { fileNameFromPath, looksLikeFilePath } from './ToolCallTarget';

describe('ToolCallTarget helpers', () => {
  it('keeps search queries and commands as plain text', () => {
    expect(looksLikeFilePath('session cancel')).toBe(false);
    expect(looksLikeFilePath('pnpm test')).toBe(false);
    expect(looksLikeFilePath('https://example.com/docs')).toBe(false);
    expect(looksLikeFilePath('http://localhost:3000/app')).toBe(false);
  });

  it('recognizes file paths and extracts the leaf name', () => {
    expect(looksLikeFilePath('live_host.mjs')).toBe(true);
    expect(
      looksLikeFilePath(
        '/Users/mac/Projects/vibe-workflow-creator/runtime/mcp-server.ts'
      )
    ).toBe(true);
    expect(
      fileNameFromPath(
        '/Users/mac/Projects/vibe-workflow-creator/runtime/mcp-server.ts'
      )
    ).toBe('mcp-server.ts');
  });
});
