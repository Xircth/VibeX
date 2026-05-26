import { $createParagraphNode, createEditor, type LexicalNode } from 'lexical';
import type { TextMatchTransformer } from '@lexical/markdown';
import { describe, expect, it } from 'vitest';

import { createDecoratorNode } from './create-decorator-node';

type TestData = {
  label: string;
};

function exportNode(transformer: TextMatchTransformer, node: LexicalNode) {
  return transformer.export?.(node, () => '', () => '');
}

function readExport(
  config: NonNullable<Parameters<typeof createEditor>[0]>,
  read: () => string | null | undefined
) {
  const editor = createEditor(config);
  let value: string | null | undefined;

  editor.update(
    () => {
      value = read();
    },
    { discrete: true }
  );

  return value;
}

describe('createDecoratorNode transformers', () => {
  it('exports inline serialized node data', () => {
    const result = createDecoratorNode<TestData>({
      type: 'test-inline-node',
      component: () => null,
      serialization: {
        format: 'inline',
        pattern: /\[\[inline:([^\]]+)\]\]/,
        trigger: ']',
        serialize: (data) => `[[inline:${data.label}]]`,
        deserialize: (match) => ({ label: match[1] ?? '' }),
      },
    });

    expect(
      readExport({ nodes: [result.Node] }, () =>
        exportNode(
          result.transformers[0] as TextMatchTransformer,
          result.createNode({ label: 'alpha' })
        )
      )
    ).toBe('[[inline:alpha]]');
  });

  it('returns null when inline export receives a different node type', () => {
    const result = createDecoratorNode<TestData>({
      type: 'test-inline-node',
      component: () => null,
      serialization: {
        format: 'inline',
        pattern: /\[\[inline:([^\]]+)\]\]/,
        trigger: ']',
        serialize: (data) => `[[inline:${data.label}]]`,
        deserialize: (match) => ({ label: match[1] ?? '' }),
      },
    });

    expect(
      readExport({ nodes: [result.Node] }, () =>
        exportNode(
          result.transformers[0] as TextMatchTransformer,
          $createParagraphNode()
        )
      )
    ).toBeNull();
  });

  it('exports fenced serialized node data', () => {
    const result = createDecoratorNode<TestData>({
      type: 'test-fenced-node',
      component: () => null,
      serialization: {
        format: 'fenced',
        language: 'test-block',
        serialize: (data) => data.label,
        deserialize: (content) => ({ label: content }),
      },
    });

    expect(
      readExport({ nodes: [result.Node] }, () =>
        exportNode(
          result.transformers[0] as TextMatchTransformer,
          result.createNode({ label: 'bravo' })
        )
      )
    ).toBe('\n```test-block\nbravo\n```\n');
  });
});
