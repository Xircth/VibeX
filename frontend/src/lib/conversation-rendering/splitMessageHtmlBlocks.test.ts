import { describe, expect, it } from 'vitest';
import { splitMessageHtmlSegments } from './splitMessageHtmlBlocks';

describe('splitMessageHtmlSegments', () => {
  it('splits a message with a fenced HTML block into before-markdown, standalone html block, and after-markdown', () => {
    const input = [
      '前面半截说明文字：这是液态玻璃原型。',
      '```html',
      '<!DOCTYPE html><html><head><title>Liquid Glass UI</title></head><body><h1>Demo</h1></body></html>',
      '```',
      '后面半截说明文字：你可以点击标题在标签页打开。',
    ].join('\n\n');

    const segments = splitMessageHtmlSegments(input, {
      workspacePath: 'C:/workspace/project',
    });

    expect(segments).toHaveLength(3);
    expect(segments[0]).toEqual({
      kind: 'markdown',
      text: '前面半截说明文字：这是液态玻璃原型。',
    });
    expect(segments[1]).toMatchObject({
      kind: 'html',
      displayPath: expect.stringMatching(
        /^\.vibe-images\/html-previews\/liquid-glass-ui-[a-z0-9]+\.html$/
      ),
      filePath: expect.stringMatching(
        /^C:\/workspace\/project\/\.vibe-images\/html-previews\/liquid-glass-ui-[a-z0-9]+\.html$/
      ),
    });
    expect(segments[2]).toEqual({
      kind: 'markdown',
      text: '后面半截说明文字：你可以点击标题在标签页打开。',
    });
  });

  it('extracts standalone HTML preview blocks from local .html markdown links', () => {
    const input = [
      '已为你生成原型文件，点击打开 [liquid-glass-ui.html](file:///C:/workspace/project/ui/liquid-glass-ui.html) 即可体验。',
      '如果你想应用到具体组件，请告诉我。',
    ].join('\n\n');

    const segments = splitMessageHtmlSegments(input, {
      workspacePath: 'C:/workspace/project',
    });

    expect(segments).toHaveLength(3);
    expect(segments[0]).toEqual({
      kind: 'markdown',
      text: '已为你生成原型文件，点击打开 [liquid-glass-ui.html](file:///C:/workspace/project/ui/liquid-glass-ui.html) 即可体验。',
    });
    expect(segments[1]).toEqual({
      kind: 'html',
      filePath: 'C:/workspace/project/ui/liquid-glass-ui.html',
      displayPath: 'ui/liquid-glass-ui.html',
      title: 'liquid-glass-ui.html',
    });
    expect(segments[2]).toEqual({
      kind: 'markdown',
      text: '如果你想应用到具体组件，请告诉我。',
    });
  });

  it('keeps non-HTML code blocks inside the markdown segment', () => {
    const input = '前置说明\n\n```ts\nconst x = 1;\n```\n\n后置说明';
    const segments = splitMessageHtmlSegments(input);

    expect(segments).toEqual([
      {
        kind: 'markdown',
        text: input,
      },
    ]);
  });
});
