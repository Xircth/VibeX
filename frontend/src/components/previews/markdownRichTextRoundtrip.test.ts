import { describe, expect, it } from 'vitest';
import {
  applyUnicodeEmphasisToEditorState,
  compactYamlFrontmatter,
  isolateYamlFrontmatter,
  markdownToRichTextState,
  richTextStateToMarkdown,
} from '@/utils/markdownRichTextState';
import { markdownToEditorStateJSON } from '@astryxdesign/richtext';

type LexicalNode = {
  type?: string;
  text?: string;
  format?: number;
  tag?: string;
  listType?: string;
  children?: LexicalNode[];
};

function walk(
  node: LexicalNode | undefined,
  acc: Array<{
    t?: string;
    text?: string;
    fmt?: number;
    tag?: string;
    listType?: string;
  }> = []
) {
  if (!node) {
    return acc;
  }
  acc.push({
    t: node.type,
    text: node.text,
    fmt: node.format,
    tag: node.tag,
    listType: node.listType,
  });
  for (const child of node.children ?? []) {
    walk(child, acc);
  }
  return acc;
}

function boldTexts(nodes: ReturnType<typeof walk>): string[] {
  return nodes
    .filter((node) => ((node.fmt ?? 0) & 1) !== 0 && node.text)
    .map((node) => node.text ?? '');
}

describe('Astryx richtext markdown roundtrip', () => {
  it('converts a heading back to markdown', () => {
    const json = markdownToRichTextState('# Title\n\nHello');
    const markdown = richTextStateToMarkdown(json);
    expect(markdown).toContain('Title');
    expect(markdown).toContain('Hello');
  });

  it('keeps YAML frontmatter dashes on their own lines', () => {
    const source = [
      '---',
      'summary: hello world',
      '---',
      '',
      '# Title',
      '',
    ].join('\n');
    const json = markdownToRichTextState(source);
    const nodes = walk(JSON.parse(json).root as LexicalNode);
    const rules = nodes.filter((node) => node.t === 'horizontalrule');
    const texts = nodes.map((node) => node.text).filter(Boolean);

    expect(rules).toHaveLength(2);
    expect(texts.some((text) => text?.includes('hello world ---'))).toBe(false);
    expect(texts.some((text) => text?.includes('summary: hello world'))).toBe(
      true
    );

    const markdown = richTextStateToMarkdown(json);
    expect(markdown).toMatch(/^---\r?\nsummary: hello world\r?\n---/);
    expect(markdown).not.toMatch(/hello world ---/);
  });

  it('marks bold inside a list item that ends with parentheses before a fullwidth colon', () => {
    const source = [
      '- **全局停止快捷键与紧急停止**：支持自定义全局停止快捷键。',
      '- **永不共享名单 (Never-Share Blocklist)**：内置终端、浏览器、密码管理器、通讯工具等敏感分类预设，支持自定义添加应用名称、Bundle ID 或可执行文件名。',
      '',
    ].join('\n');
    const json = markdownToRichTextState(source);
    const nodes = walk(JSON.parse(json).root as LexicalNode);
    const bold = boldTexts(nodes);

    expect(bold).toContain('全局停止快捷键与紧急停止');
    expect(bold).toContain('永不共享名单 (Never-Share Blocklist)');
    expect(nodes.some((node) => node.text?.includes('**永不共享名单'))).toBe(
      false
    );
  });

  it('applies bold when a closer sits between ASCII and Unicode punctuation', () => {
    const source = markdownToEditorStateJSON(
      '**永不共享名单 (Never-Share Blocklist)**：内置终端。'
    );
    const nodes = walk(
      JSON.parse(applyUnicodeEmphasisToEditorState(source)).root as LexicalNode
    );
    expect(boldTexts(nodes)).toContain('永不共享名单 (Never-Share Blocklist)');
  });

  it('isolates and compact YAML fences without rewriting the body', () => {
    const source = [
      '---',
      'summary: 桌面窗口与应用感知',
      '---',
      '',
      '# Title',
      '',
    ].join('\n');
    const isolated = isolateYamlFrontmatter(source);
    expect(isolated.startsWith('---\n\nsummary:')).toBe(true);
    expect(isolated).toContain('\n\n---\n');
    expect(compactYamlFrontmatter(isolated)).toBe(source);
  });
});
