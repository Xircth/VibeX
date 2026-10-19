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
    resolve(process.cwd(), 'src/styles/conversation/conv-markdown.css'),
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
    const markdown = container.querySelector('.conv-markdown');
    const toolCalls = container.querySelector('.astryx-chat-tool-calls');

    expect(getComputedStyle(header as Element).fontSize).toBe('13px');
    expect(getComputedStyle(header as Element).fontSize).toBe(
      getComputedStyle(markdown as Element).fontSize
    );
    expect(getComputedStyle(body as Element).gap).toBe('10px');
    expect(getComputedStyle(thinking as Element).paddingTop).toBe('0px');
    expect(getComputedStyle(thinking as Element).paddingBottom).toBe('0px');
    expect(getComputedStyle(header as Element).paddingTop).toBe('2px');
    expect(getComputedStyle(header as Element).paddingBottom).toBe('2px');
    expect(getComputedStyle(toolCalls as Element).marginBlockStart).toBe('0px');
    expect(getComputedStyle(toolCalls as Element).marginBlockEnd).toBe('0px');
  });

  it('restores extra space around a tool-call fold versus surrounding prose', () => {
    const { container } = render(
      <div className="legacy-design">
        <style>{`${astryxToolCallDefault}\n${conversationStyles}`}</style>
        <div className="conv-assistant-body">
          <div className="conv-markdown">
            <p>Before</p>
          </div>
          <div className="conv-activity-batch">Mixed fold</div>
          <div className="astryx-chat-tool-calls vibex-tool-call-batch">
            Grouped tools
          </div>
          <div className="astryx-chat-tool-calls">Single tool</div>
        </div>
      </div>
    );

    const mixed = container.querySelector('.conv-activity-batch');
    const grouped = container.querySelector('.vibex-tool-call-batch');
    const single = container.querySelector(
      '.astryx-chat-tool-calls:not(.vibex-tool-call-batch)'
    );

    expect(getComputedStyle(mixed as Element).marginBlockStart).toBe('8px');
    expect(getComputedStyle(mixed as Element).marginBlockEnd).toBe('8px');
    expect(getComputedStyle(grouped as Element).marginBlockStart).toBe('8px');
    expect(getComputedStyle(grouped as Element).marginBlockEnd).toBe('8px');
    expect(getComputedStyle(single as Element).marginBlockStart).toBe('0px');
  });

  it('spaces expanded tools from thinking without changing tool-to-tool rhythm', () => {
    const { container } = render(
      <div className="legacy-design">
        <style>{conversationStyles}</style>
        <div className="conv-nested-scroll">
          <div className="astryx-chat-tool-calls">Search</div>
          <div className="astryx-chat-tool-calls">Read</div>
          <div className="conv-thinking">Thought</div>
          <div className="astryx-chat-tool-calls">Edit</div>
        </div>
      </div>
    );

    const tools = container.querySelectorAll('.astryx-chat-tool-calls');
    const thinking = container.querySelector('.conv-thinking');

    expect(getComputedStyle(tools[1] as Element).marginTop).not.toBe('10px');
    expect(getComputedStyle(thinking as Element).marginTop).toBe('10px');
    expect(getComputedStyle(tools[2] as Element).marginTop).toBe('10px');
  });

  it('gives nested overflow panes 4px inline room for tool-row hover radius', () => {
    const { container } = render(
      <div className="legacy-design">
        <style>{conversationStyles}</style>
        <div className="conv-nested-scroll">pane</div>
        <div className="astryx-chat-tool-calls">
          <button type="button" role="button" aria-expanded="true">
            Group
          </button>
          <div>
            <div>rows</div>
          </div>
        </div>
      </div>
    );

    const nested = container.querySelector('.conv-nested-scroll');
    const expanded = container.querySelector(
      ".astryx-chat-tool-calls [role='button'][aria-expanded='true'] + div"
    );
    const expandedInner = expanded?.firstElementChild;

    expect(getComputedStyle(nested as Element).paddingInlineStart).toBe('4px');
    expect(getComputedStyle(nested as Element).paddingInlineEnd).toBe('4px');
    expect(getComputedStyle(nested as Element).marginInlineStart).toBe('-4px');
    expect(getComputedStyle(nested as Element).marginInlineEnd).toBe('-4px');
    expect(getComputedStyle(expanded as Element).paddingInlineStart).toBe(
      '4px'
    );
    expect(getComputedStyle(expanded as Element).marginInlineStart).toBe(
      '-4px'
    );
    expect(getComputedStyle(expandedInner as Element).overflow).toBe('visible');
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

  it('keeps the action rail reachable after leaving the bubble', () => {
    const css = readFileSync(
      resolve(process.cwd(), 'src/styles/conversation/conv-messages.css'),
      'utf8'
    );

    expect(css).toMatch(/\.conv-user-bubble-wrap::after\s*\{[^}]*top:\s*100%/u);
    expect(css).toMatch(
      /\.conv-user-bubble-wrap:hover::after\s*\{[^}]*pointer-events:\s*auto/u
    );
    expect(css).toMatch(
      /\.conv-user-actions:hover,\s*\n\s*\.conv-user-actions:focus-within/u
    );
    expect(css).toMatch(/pointer-events 0s linear 220ms/u);
    expect(css).toMatch(/visibility 0s linear 220ms/u);
  });
});
