import { render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const conversationStyles = [
  readFileSync(
    resolve(process.cwd(), 'src/styles/conversation/conv-components.css'),
    'utf8'
  ),
  readFileSync(
    resolve(process.cwd(), 'src/styles/conversation/conv-tools.css'),
    'utf8'
  ),
].join('\n');

const astryxToolCallDefault = `
  .astryx-chat-tool-calls {
    margin-block-start: 8px;
  }
`;

describe('assistant turn vertical rhythm', () => {
  it('keeps thinking and tool-call outer spacing equal to the shared body gap', () => {
    const { container } = render(
      <div className="legacy-design">
        <style>{`${astryxToolCallDefault}\n${conversationStyles}`}</style>
        <div className="conv-assistant-body">
          <div className="conv-markdown">
            <p>Before</p>
          </div>
          <div className="conv-thinking">
            <button type="button" className="conv-thinking-header">
              Thinking
            </button>
          </div>
          <div className="conv-entry-item vibex-turn-tool-calls">
            <div className="astryx-chat-tool-calls">Read</div>
          </div>
          <div className="conv-markdown">
            <p>After</p>
          </div>
        </div>
      </div>
    );

    const body = container.querySelector('.conv-assistant-body');
    const thinking = container.querySelector('.conv-thinking');
    const header = container.querySelector('.conv-thinking-header');
    const toolCalls = container.querySelector('.astryx-chat-tool-calls');

    expect(getComputedStyle(body as Element).gap).toBe('10px');
    expect(getComputedStyle(thinking as Element).paddingTop).toBe('0px');
    expect(getComputedStyle(thinking as Element).paddingBottom).toBe('0px');
    expect(getComputedStyle(header as Element).paddingTop).toBe('2px');
    expect(getComputedStyle(header as Element).paddingBottom).toBe('2px');
    expect(getComputedStyle(toolCalls as Element).marginBlockStart).toBe('0px');
    expect(getComputedStyle(toolCalls as Element).marginBlockEnd).toBe('0px');
  });
});

describe('user message action rail', () => {
  it('anchors hover actions to the bottom-right of the bubble', () => {
    const { container } = render(
      <div className="legacy-design">
        <style>
          {readFileSync(
            resolve(process.cwd(), 'src/styles/conversation/conv-messages.css'),
            'utf8'
          )}
        </style>
        <div className="conv-user-turn">
          <div className="conv-user-bubble-wrap">
            <div className="conv-user-actions">
              <button type="button" className="conv-user-action-btn">
                Copy
              </button>
            </div>
          </div>
        </div>
      </div>
    );

    const actions = container.querySelector('.conv-user-actions');
    const button = container.querySelector('.conv-user-action-btn');
    expect(getComputedStyle(actions as Element).top).toBe('100%');
    expect(getComputedStyle(actions as Element).right).toBe('0px');
    expect(getComputedStyle(actions as Element).paddingTop).toBe('4px');
    expect(getComputedStyle(button as Element).width).toBe('20px');
    expect(getComputedStyle(button as Element).height).toBe('20px');
  });
});
