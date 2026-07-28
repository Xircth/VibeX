import { describe, expect, it } from 'vitest';
import { redlineDocumentToPayloads } from './tauriInspector';

describe('redlineDocumentToPayloads', () => {
  it('turns Redline element annotations into preview element payloads', () => {
    const payloads = redlineDocumentToPayloads({
      url: 'tauri://localhost/settings',
      annotations: [
        {
          type: 'select',
          selector: 'button.save',
          tagName: 'BUTTON',
          classes: 'save primary',
          comment: 'Make this action less prominent',
          html: '<button class="save primary">',
          computedCss: { color: 'rgb(255, 0, 0)' },
          position: { x: 120, y: 80 },
        },
      ],
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      selected: {
        name: 'button.save',
        url: 'tauri://localhost/settings',
      },
      trigger: 'tauri-inspector',
      coords: { x: 120, y: 80 },
      clickedElement: {
        tag: 'button',
        className: 'save primary',
        dataset: {
          preview: '<button class="save primary">',
          redlineComment: 'Make this action less prominent',
          redlineSelector: 'button.save',
        },
      },
    });
    expect(payloads[0].clickedElement?.dataset?.redlineComputedCss).toContain(
      '"color":"rgb(255, 0, 0)"'
    );
  });

  it('uses the near element for shape annotations and skips unanchored notes', () => {
    const payloads = redlineDocumentToPayloads({
      url: 'tauri://localhost/',
      annotations: [
        {
          type: 'box',
          nearSelector: '#sidebar',
          nearTagName: 'ASIDE',
          nearClasses: 'sidebar',
          comment: 'Reduce this width',
          html: '<aside id="sidebar">',
        },
        {
          type: 'text',
          comment: 'Page-level thought',
        },
      ],
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0].selected.name).toBe('#sidebar');
    expect(payloads[0].clickedElement?.tag).toBe('aside');
  });
});
