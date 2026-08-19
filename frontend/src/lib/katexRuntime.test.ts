import { describe, expect, it, vi } from 'vitest';

const renderToString = vi.fn(() => '<span>math</span>');

vi.mock('katex', () => ({
  default: { renderToString },
}));

vi.mock('katex/dist/katex.min.css', () => ({}));

describe('loadKatex', () => {
  it('loads katex once and reuses the same promise', async () => {
    const { loadKatex } = await import('./katexRuntime');
    const [first, second] = await Promise.all([loadKatex(), loadKatex()]);
    expect(first).toBe(second);
    expect(first.renderToString).toBe(renderToString);
  });
});
