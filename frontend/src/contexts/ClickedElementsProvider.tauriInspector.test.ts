import { describe, expect, it } from 'vitest';
import {
  buildClickedElementData,
  type ClickedEntry,
} from './ClickedElementsProvider';

describe('Tauri inspector element formatting', () => {
  it('keeps the Redline selector, comment, HTML, and computed CSS for the Agent', () => {
    const entry: ClickedEntry = {
      id: 'capture-1',
      timestamp: 1,
      dedupeKey: 'button.save',
      payload: {
        selected: {
          name: 'button.save',
          props: {},
          source: { fileName: '', lineNumber: 0, columnNumber: 0 },
          pathToSource: '',
          editor: '',
          url: 'tauri://localhost',
        },
        components: [],
        trigger: 'tauri-inspector',
        clickedElement: {
          tag: 'button',
          className: 'save',
          dataset: {
            redlineSelector: 'button.save',
            redlineComment: 'Use the secondary style',
            preview: '<button class="save">',
            redlineComputedCss: '{"color":"red"}',
          },
        },
      },
    };

    const data = buildClickedElementData(entry);

    expect(data.fullMarkdown).toContain('From Tauri App selection:');
    expect(data.fullMarkdown).toContain('`button.save`');
    expect(data.fullMarkdown).toContain('Use the secondary style');
    expect(data.fullMarkdown).toContain('<button class="save">');
    expect(data.fullMarkdown).toContain('{"color":"red"}');
  });
});
