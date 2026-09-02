import { describe, expect, it } from 'vitest';
import {
  buildMermaidRenderCandidates,
  normalizeMermaidSource,
} from './normalizeMermaidSource';

describe('normalizeMermaidSource', () => {
  it('converts graph directives to flowchart', () => {
    expect(normalizeMermaidSource('graph TB\nA-->B')).toBe(
      'flowchart TB\nA-->B'
    );
  });

  it('quotes unquoted subgraph titles', () => {
    expect(normalizeMermaidSource('flowchart TB\nsubgraph 基础层\nA-->B\nend')).toBe(
      'flowchart TB\nsubgraph 基础层["基础层"]\nA-->B\nend'
    );
  });

  it('removes list markers after line breaks in node labels', () => {
    expect(
      normalizeMermaidSource(
        'flowchart TB\nBM[BaseModel<br/>- ID, CreatedAt<br/>- UpdatedAt]'
      )
    ).toBe(
      'flowchart TB\nBM["BaseModel<br/>ID, CreatedAt<br/>UpdatedAt"]'
    );
  });

  it('quotes complex node labels with commas', () => {
    expect(normalizeMermaidSource('flowchart TB\nBM[BaseModel, ID, Name]')).toBe(
      'flowchart TB\nBM["BaseModel, ID, Name"]'
    );
  });

  it('deduplicates render candidates when normalization is a no-op', () => {
    expect(buildMermaidRenderCandidates('flowchart TB\nA-->B')).toEqual([
      'flowchart TB\nA-->B',
    ]);
  });

  it('includes normalized fallback when source changes', () => {
    expect(buildMermaidRenderCandidates('graph TB\nsubgraph RBAC\nA-->B\nend')).toEqual([
      'graph TB\nsubgraph RBAC\nA-->B\nend',
      'flowchart TB\nsubgraph RBAC["RBAC"]\nA-->B\nend',
    ]);
  });
});
