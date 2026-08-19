import { describe, expect, it } from 'vitest';
import { parseSearchQuery, parseToolHitItems } from './toolHitItems';

describe('parseToolHitItems', () => {
  it('parses file:line hits and URLs from text', () => {
    expect(
      parseToolHitItems(
        [
          'crates/conversations/src/service.rs:41: cancel_session()',
          'https://example.com/docs Example docs',
        ].join('\n')
      )
    ).toEqual([
      {
        path: 'crates/conversations/src/service.rs',
        url: null,
        line: '41',
        text: 'cancel_session()',
      },
      {
        path: null,
        url: 'https://example.com/docs',
        line: null,
        text: 'Example docs',
      },
    ]);
  });

  it('extracts query and source URLs from a nested search payload', () => {
    const payload = {
      action: {
        type: 'search',
        query: 'site:github.com vibex workflow creator plugin',
        sources: [
          { type: 'url', url: '' },
          {
            type: 'url',
            url: 'https://github.com/jeremylongshore/claude-code-plugins-plus-skills',
          },
          {
            type: 'url',
            url: 'https://github.com/jfmaes/awesome-ai-workflow',
          },
        ],
      },
      status: 'completed',
    };

    expect(parseSearchQuery(payload)).toBe(
      'site:github.com vibex workflow creator plugin'
    );
    expect(parseToolHitItems(JSON.stringify(payload))).toEqual([
      {
        path: null,
        url: 'https://github.com/jeremylongshore/claude-code-plugins-plus-skills',
        line: null,
        text: 'https://github.com/jeremylongshore/claude-code-plugins-plus-skills',
        directory: false,
      },
      {
        path: null,
        url: 'https://github.com/jfmaes/awesome-ai-workflow',
        line: null,
        text: 'https://github.com/jfmaes/awesome-ai-workflow',
        directory: false,
      },
    ]);
  });

  it('reads title/url objects used by web search tools', () => {
    expect(
      parseToolHitItems({
        results: [{ title: 'ACP', url: 'https://agentclientprotocol.com' }],
      })
    ).toEqual([
      {
        path: null,
        url: 'https://agentclientprotocol.com',
        line: null,
        text: 'ACP',
        directory: false,
      },
    ]);
  });
});
