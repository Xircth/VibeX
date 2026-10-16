import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MermaidDiagram } from './MermaidDiagram';

const initialize = vi.hoisted(() => vi.fn());
const renderDiagram = vi.hoisted(() =>
  vi.fn(async (id: string) => {
    const bomb = document.createElement('div');
    bomb.id = `d${id}`;
    bomb.setAttribute('data-mermaid-bomb', 'true');
    document.body.appendChild(bomb);
    throw new Error('Syntax error in text');
  })
);

vi.mock('mermaid', () => ({
  default: {
    initialize,
    render: (id: string) => renderDiagram(id),
  },
}));

describe('MermaidDiagram', () => {
  beforeEach(() => {
    initialize.mockClear();
    renderDiagram.mockClear();
    document
      .querySelectorAll('[data-mermaid-bomb]')
      .forEach((node) => node.remove());
  });

  it('keeps a failed diagram off the document body', async () => {
    render(<MermaidDiagram value="not a diagram" />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Syntax error in text'
    );
    expect(initialize).toHaveBeenCalledWith(
      expect.objectContaining({ suppressErrorRendering: true })
    );
    expect(document.querySelector('[data-mermaid-bomb]')).toBeNull();
  });
});
