import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MermaidDiagram } from './MermaidDiagram';

const initialize = vi.hoisted(() => vi.fn());
const renderDiagram = vi.hoisted(() =>
  vi.fn(
    async (
      id: string,
      _text?: string,
      container?: Element
    ): Promise<{ svg: string }> => {
      if (!container || !document.body.contains(container)) {
        throw new TypeError(
          "Cannot read properties of null (reading 'firstChild')"
        );
      }
      const bomb = document.createElement('div');
      bomb.id = `d${id}`;
      bomb.setAttribute('data-mermaid-bomb', 'true');
      document.body.appendChild(bomb);
      throw new Error('Syntax error in text');
    }
  )
);

vi.mock('mermaid', () => ({
  default: {
    initialize,
    render: (id: string, text?: string, container?: Element) =>
      renderDiagram(id, text, container),
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
      expect.objectContaining({
        suppressErrorRendering: true,
        securityLevel: 'antiscript',
        htmlLabels: true,
      })
    );
    expect(document.querySelector('[data-mermaid-bomb]')).toBeNull();
  });

  it('passes a live container so mermaid can read firstChild', async () => {
    renderDiagram.mockImplementationOnce(async (_id, _text, container) => {
      if (!container || !document.body.contains(container)) {
        throw new TypeError(
          "Cannot read properties of null (reading 'firstChild')"
        );
      }
      return {
        svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>ok</text></svg>',
      };
    });

    render(<MermaidDiagram value="graph TD; A-->B" />);

    const diagram = await screen.findByRole('img', { name: /Mermaid/ });
    expect(diagram).toHaveTextContent('ok');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(renderDiagram).toHaveBeenCalledWith(
      expect.stringMatching(/^mermaid-/),
      'graph TD; A-->B',
      expect.any(HTMLElement)
    );
  });
});
